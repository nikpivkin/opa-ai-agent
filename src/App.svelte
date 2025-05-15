<script lang="ts">
  import ChatMessage from "./lib/components/ChatMessage.svelte";
  import { onMount } from "svelte";
  import { EditorState } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { basicSetup } from "codemirror";
  import { json } from "@codemirror/lang-json";
  import { PaneGroup, Pane, PaneResizer } from "paneforge";

  import {
    Textarea,
    Spinner,
    ButtonGroup,
    Button,
    ToolbarButton,
    Modal,
    Input,
    Label,
  } from "flowbite-svelte";

  import CollapsablePane from "./lib/components/CollapsablePane.svelte";

  import type { Message } from "./lib/types/chat";
  import {
    chatSessions,
    currentSessionId,
    switchToNewChat,
  } from "./stores/chat";

  let editorContainer: HTMLDivElement;
  let editorView: EditorView;

  let inputContainer: HTMLDivElement;
  let inputView: EditorView;

  let outputContainer: HTMLDivElement;
  let outputView: EditorView;

  let schemaContainer: HTMLDivElement;
  let schemaView: EditorView;

  let currentChatSession = $derived($chatSessions[$currentSessionId] || {});

  let inputJson: string =
    localStorage.getItem("input_json") || '{"method": "GET"}';
  $effect(() => {
    localStorage.setItem("input_json", inputJson);
  });
  let outputResult: string = $state("");
  $effect(() => {
    const val = outputResult;

    outputView?.dispatch({
      changes: { from: 0, to: outputView.state.doc.length, insert: val },
    });
  });
  let jsonError: string | null = $state(null);
  let policyPrompt: string = $state(
    localStorage.getItem("policy_prompt") ||
      "The policy should verify that the GET method",
  );
  $effect(() => {
    localStorage.setItem("policy_prompt", policyPrompt);
  });
  let apiToken: string = $state(localStorage.getItem("openrouter_token") || "");
  $effect(() => {
    localStorage.setItem("openrouter_token", apiToken);
  });
  let stream: boolean = true;
  let isGenerating = $state(false);
  let isEvaluating = $state(false);
  let stopGeneration = false;
  let maxAttempts = 10;
  let abortController: AbortController | null = null;

  let settingstModal = $state(false);

  function isValidJson(jsonString: string): boolean {
    try {
      JSON.parse(jsonString);
      return true;
    } catch {
      return false;
    }
  }

  function validateInput(): boolean {
    if (!isValidJson(inputJson)) {
      jsonError = "Invalid JSON format!";
      outputResult = "";
      return false;
    } else {
      jsonError = null;
      return true;
    }
  }

  function showOutputFromRego(data: any) {
    if (data.result && data.result.length > 0) {
      outputResult = JSON.stringify(
        data.result[0].expressions[0].value,
        null,
        2,
      );
    } else {
      outputResult = "No result returned from policy evaluation.";
    }
  }

  async function evaluatePolicy() {
    if (!validateInput()) {
      return;
    }

    isEvaluating = true;

    try {
      const policy = editorView.state.doc.toString();
      const data = await evaluateRegoPolicy(policy, inputJson);
      if (data.code && data.message) {
        outputResult = `Error: ${data.message}`;
        return;
      }

      showOutputFromRego(data);
      return;
    } catch (error) {
      if (error instanceof Error) {
        outputResult = `Error: ${error.message}`;
      } else {
        console.error(error);
      }
    } finally {
      isEvaluating = false;
    }
  }

  async function evaluateRegoPolicy(
    policy: string,
    inputJson: string,
  ): Promise<any> {
    const requestBody = {
      input: JSON.parse(inputJson),
      rego_modules: {
        "policy.rego": policy,
      },
      rego_version: 0,
      strict: true,
    };

    const response = await fetch("https://play.openpolicyagent.org/v1/data", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    return data;
  }

  function deleteChatHandler() {
    delete $chatSessions[$currentSessionId];
    switchToNewChat();
  }

  async function tryGeneratePolicy(
    attempt: number,
    signal: AbortSignal,
    prevError?: string,
  ): Promise<any> {
    if (attempt === 0) {
      throw new Error("The limit of generation attempts has been reached.");
    }

    try {
      await generatePolicy(
        policyPrompt,
        inputJson,
        apiToken,
        signal,
        prevError,
      );
      const policy = editorView.state.doc.toString();
      isEvaluating = true;
      const data = await evaluateRegoPolicy(policy, inputJson);
      if (data.code && data.message) {
        console.error("Error:", data.message);
        if (stopGeneration) {
          stopGeneration = false;
          outputResult = `Error: ${data.message}`;
          return;
        }
        const d = await tryGeneratePolicy(attempt - 1, signal, data.message);
        return d;
      } else {
        return data;
      }
    } catch (error) {
      throw new Error("Failed to generate or eval policy: " + error.message, {
        cause: error,
      });
    } finally {
      isEvaluating = false;
    }
  }

  async function generatePolicyHandler() {
    if (isGenerating) {
      stopGeneration = true;
      abortController?.abort();
      abortController = null;
      return;
    }

    isGenerating = true;
    stopGeneration = false;

    abortController = new AbortController();
    const signal = abortController.signal;

    try {
      if (!validateInput()) {
        return;
      }
      const data = await tryGeneratePolicy(maxAttempts, signal);
      if (data) {
        showOutputFromRego(data);
      }
      return;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          console.log("Stream cancelled");
        } else {
          console.error("Error:", error.message);
          outputResult = error.message;
        }
      } else {
        console.error(error);
      }
    } finally {
      isGenerating = false;
      abortController = null;
    }
  }

  type ChatPayload = {
    model: string;
    messages: Message[];
    temperature: number;
    reasoning: { max_tokens: number };
    stream: boolean;
  };

  function buildChatPayload(
    prompt: string,
    inputJson: string,
    stream: boolean,
    messages: Message[],
    prevError?: string,
  ): ChatPayload {
    let userMessage = `Generate an OPA Rego policy for the following prompt: "${prompt}" using input: ${inputJson}. Only return valid Rego code.`;
    if (prevError) {
      userMessage += ` An error in previous policy evaluation: "${prevError}""`;
    }

    let payloadMessages: Message[] = [];

    if (!messages || messages.length === 0) {
      payloadMessages = [
        {
          role: "system",
          content:
            "You are a code generation assistant. Given a user request and input data, respond ONLY with a valid OPA Rego policy. Do NOT include any explanation, comments, or markdown formatting. Output only the Rego code. The request may contain an error from a previous policy evaluation. You must take it into account.",
        },
      ];
    } else {
      payloadMessages = messages;
    }

    return {
      model: "mistralai/mistral-small-3.1-24b-instruct:free",
      messages: [
        ...payloadMessages,
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.7,
      reasoning: { max_tokens: 1024 },
      stream,
    };
  }

  async function handleStreamResponse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let buffer = "";

    let allContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;

        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);

        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return allContent;

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            if (e instanceof Error) {
              console.error("Invalid JSON chunk:", e.message);
            } else {
              console.error(e);
            }
          }

          if (parsed) {
            if (parsed.error) {
              throw new Error(parsed.error.message);
            }
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              applyEditorContent(content);
              allContent += content;
            }
          }
        }
      }
    }

    await reader.cancel();
    return allContent;
  }

  function applyEditorContent(content: string) {
    editorView.dispatch({
      changes: {
        from: editorView.state.doc.length,
        insert: content,
      },
    });
  }

  async function generatePolicy(
    prompt: string,
    inputJson: string,
    token: string,
    signal: AbortSignal,
    prevError?: string,
  ) {
    const sessionId = $currentSessionId;
    const payload = buildChatPayload(
      prompt,
      inputJson,
      stream,
      currentChatSession.messages,
      prevError,
    );

    $chatSessions = {
      ...$chatSessions,
      [sessionId]: {
        ...currentChatSession,
        messages: [...payload.messages],
      },
    };

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: signal,
      },
    );

    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: "" },
    });

    let content = "";

    if (!stream) {
      const data = await response.json();
      content = data.choices?.[0]?.message?.content || "No policy generated.";
      applyEditorContent(content);
    } else {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");
      content = await handleStreamResponse(reader);
    }

    $chatSessions = {
      ...$chatSessions,
      [sessionId]: {
        ...currentChatSession,
        messages: [
          ...currentChatSession.messages,
          {
            role: "assistant",
            content: content,
          },
        ],
      },
    };
  }

  onMount(() => {
    editorView = new EditorView({
      doc: `package policy
  
allow {
  input.method == "GET"
}`,
      extensions: [basicSetup],
      parent: editorContainer,
    });

    inputView = new EditorView({
      doc: `{
  "method": "GET"
}`,
      extensions: [basicSetup, json()],
      parent: inputContainer,
    });

    outputView = new EditorView({
      doc: "",
      extensions: [
        basicSetup,
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
      ],
      parent: outputContainer,
    });

    schemaView = new EditorView({
      extensions: [basicSetup, json()],
      parent: schemaContainer,
    });
  });
</script>

<main class="h-screen w-full">
  <PaneGroup direction="horizontal" class="h-screen w-full">
    <Pane defaultSize={70} class="flex flex-col"
      ><div class="flex flex-row justify-between justify-items-center">
        <ToolbarButton
          class="text-primary-600 dark:text-primary-500 rounded-full items-center content-center"
          onclick={() => (settingstModal = true)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            class="h-6 w-6 stroke-gray-700 fill-gray-700"
            ><path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M11.5677 3.5C11.2129 3.5 10.8847 3.68789 10.7051 3.99377L9.89391 5.37524C9.3595 6.28538 8.38603 6.84786 7.3304 6.85645L5.73417 6.86945C5.3794 6.87233 5.0527 7.06288 4.87559 7.3702L4.43693 8.13135C4.2603 8.43784 4.25877 8.81481 4.43291 9.12273L5.22512 10.5235C5.74326 11.4397 5.74326 12.5603 5.22512 13.4765L4.43291 14.8773C4.25877 15.1852 4.2603 15.5622 4.43693 15.8687L4.87559 16.6298C5.0527 16.9371 5.3794 17.1277 5.73417 17.1306L7.33042 17.1436C8.38605 17.1522 9.35952 17.7146 9.89393 18.6248L10.7051 20.0062C10.8847 20.3121 11.2129 20.5 11.5677 20.5H12.4378C12.7926 20.5 13.1208 20.3121 13.3004 20.0062L14.1116 18.6248C14.646 17.7146 15.6195 17.1522 16.6751 17.1436L18.2714 17.1306C18.6262 17.1277 18.9529 16.9371 19.13 16.6298L19.5687 15.8687C19.7453 15.5622 19.7468 15.1852 19.5727 14.8773L18.7805 13.4765C18.2623 12.5603 18.2623 11.4397 18.7805 10.5235L19.5727 9.12273C19.7468 8.81481 19.7453 8.43784 19.5687 8.13135L19.13 7.3702C18.9529 7.06288 18.6262 6.87233 18.2714 6.86945L16.6751 6.85645C15.6195 6.84786 14.646 6.28538 14.1116 5.37524L13.3004 3.99377C13.1208 3.68788 12.7926 3.5 12.4378 3.5H11.5677ZM8.97978 2.98131C9.5186 2.06365 10.5033 1.5 11.5677 1.5H12.4378C13.5022 1.5 14.4869 2.06365 15.0257 2.98131L15.8369 4.36278C16.015 4.66616 16.3395 4.85365 16.6914 4.85652L18.2877 4.86951C19.352 4.87818 20.3321 5.4498 20.8635 6.37177L21.3021 7.13292C21.832 8.05239 21.8366 9.18331 21.3142 10.1071L20.522 11.5078C20.3493 11.8132 20.3493 12.1868 20.522 12.4922L21.3142 13.893C21.8366 14.8167 21.832 15.9476 21.3021 16.8671L20.8635 17.6282C20.3321 18.5502 19.352 19.1218 18.2877 19.1305L16.6914 19.1435C16.3395 19.1464 16.015 19.3339 15.8369 19.6372L15.0257 21.0187C14.4869 21.9363 13.5022 22.5 12.4378 22.5H11.5677C10.5033 22.5 9.5186 21.9363 8.97978 21.0187L8.16863 19.6372C7.99049 19.3339 7.666 19.1464 7.31413 19.1435L5.71789 19.1305C4.65357 19.1218 3.67347 18.5502 3.14213 17.6282L2.70347 16.8671C2.17358 15.9476 2.16899 14.8167 2.6914 13.893L3.48361 12.4922C3.65632 12.1868 3.65632 11.8132 3.48361 11.5078L2.6914 10.1071C2.16899 9.18331 2.17358 8.05239 2.70347 7.13292L3.14213 6.37177C3.67347 5.4498 4.65357 4.87818 5.71789 4.86951L7.31411 4.85652C7.66599 4.85366 7.99048 4.66616 8.16862 4.36278L8.97978 2.98131Z"
            ></path><path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M12.0028 10.5C11.1741 10.5 10.5024 11.1716 10.5024 12C10.5024 12.8284 11.1741 13.5 12.0028 13.5C12.8315 13.5 13.5032 12.8284 13.5032 12C13.5032 11.1716 12.8315 10.5 12.0028 10.5ZM8.50178 12C8.50178 10.067 10.0692 8.5 12.0028 8.5C13.9364 8.5 15.5038 10.067 15.5038 12C15.5038 13.933 13.9364 15.5 12.0028 15.5C10.0692 15.5 8.50178 13.933 8.50178 12Z"
            ></path></svg
          >
          <span class="sr-only">Settings</span>
        </ToolbarButton>
        <Modal title="Settings" bind:open={settingstModal} autoclose>
          <div class="mb-6">
            <Label for="apiToken" class="mb-2">OpenRouter API Token</Label>
            <Input
              type="password"
              id="apiToken"
              placeholder="Enter your token"
              bind:value={apiToken}
            />
          </div>
          {#snippet footer()}
            <Button color="red" class="me-2" onclick={deleteChatHandler}
              >Delete chat</Button
            >
          {/snippet}
        </Modal>
      </div>

      <PaneGroup direction="horizontal">
        <Pane minSize={20} class="p-2">
          <h3 class="text-base font-semibold">CHAT</h3>
          <div class="mt-2 h-[500px] overflow-y-auto space-y-2 pr-1">
            {#each currentChatSession.messages.filter((m) => m.role != "system") as message}
              <ChatMessage
                content={message.content}
                side={message.role == "assistant" ? "left" : "right"}
              />
            {/each}
          </div>
        </Pane>
        <PaneResizer
          class="relative w-1 items-center justify-center bg-gray-200"
        />
        <Pane minSize={20}>
          <h3 class="text-base font-semibold pl-2">EDITOR</h3>
          <div bind:this={editorContainer} class="h-full"></div>
        </Pane>
      </PaneGroup>

      <form>
        <label for="chat" class="sr-only">Describe your desired policy</label>
        <div
          class="flex items-center px-3 py-2 dark:bg-gray-700 border-2 border-gray-300"
        >
          <Textarea
            id="chat"
            class="mx-4 bg-white dark:bg-gray-800 text-black-500 border-none focus:ring-0"
            rows={2}
            placeholder="Describe your desired policy..."
            bind:value={policyPrompt}
          />
          <ButtonGroup class="*:ring-primary-700!">
            <Button onclick={generatePolicyHandler}>
              {#if isGenerating}
                <Spinner class="me-3" size="4" /> Stop generating...
              {:else}
                Generate
              {/if}
            </Button>

            <Button onclick={evaluatePolicy} disabled={isEvaluating}>
              {#if isEvaluating}
                <Spinner class="me-3" size="4" /> Evaluating...
              {:else}
                Evaluate
              {/if}
            </Button>
          </ButtonGroup>
        </div>
      </form></Pane
    >
    <PaneResizer class="relative w-1 items-center justify-center bg-gray-200" />
    <Pane defaultSize={30} class="flex flex-col gap-5">
      <PaneGroup direction="vertical" class="flex flex-col">
        <CollapsablePane header="INPUT" order={1} defaultSize={1 / 3}>
          <div bind:this={inputContainer} class="h-full"></div>
          {#if jsonError}
            <p class="error">{jsonError}</p>
          {/if}
        </CollapsablePane>
        <PaneResizer class="relative h-1 items-center bg-gray-200" />
        <CollapsablePane header="SCHEMA" order={2} defaultSize={1 / 3}>
          <div bind:this={schemaContainer} class="h-full"></div>
        </CollapsablePane>
        <PaneResizer class="relative h-1 items-center bg-gray-200" />
        <CollapsablePane header="OUTPUT" order={3} defaultSize={1 / 3} class="">
          <div bind:this={outputContainer} class="h-full"></div>
        </CollapsablePane>
        <Pane defaultSize={0} order={4} />
      </PaneGroup>
    </Pane>
  </PaneGroup>
</main>

<style>
  .error {
    color: red;
    font-size: 14px;
    margin-top: 8px;
  }

  div :global {
    .cm-editor {
      height: 100%;
    }

    .cm-gutters {
      background-color: inherit;
      width: 25px;
    }

    .cm-focused {
      outline: none;
    }
  }
</style>
