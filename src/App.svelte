<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";

  let editorContainer: HTMLDivElement;
  let editorView: EditorView;

  let inputJson: string =
    localStorage.getItem("input_json") || '{"method": "GET"}';
  $: localStorage.setItem("input_json", inputJson);
  let outputResult: string = "";
  let jsonError: string | null = null;
  let policyPrompt: string =
    localStorage.getItem("policy_prompt") ||
    "The policy should verify that the GET method";
  $: localStorage.setItem("policy_prompt", policyPrompt);
  let apiToken: string = localStorage.getItem("openrouter_token") || "";
  $: localStorage.setItem("openrouter_token", apiToken);
  let stream: boolean = true;
  let isGenerating = false;
  let isEvaluating = false;
  let stopGeneration = false;
  let maxAttempts = 10;
  let abortController: AbortController | null = null;

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
        return `Error: ${data.message}`;
      }

      showOutputFromRego(data);
      return;
    } catch (error) {
      outputResult = `Error: ${error.message}`;
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

  async function tryGeneratePolicy(
    attempt: number,
    signal: AbortSignal,
    prevError?: string,
  ): Promise<any> {
    if (attempt === 0) {
      throw new Error("The limit of generation attempts has been reached.");
    }
    await generatePolicy(policyPrompt, inputJson, apiToken, signal, prevError);
    const policy = editorView.state.doc.toString();
    isEvaluating = true;
    try {
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
      if (error.name === "AbortError") {
        console.log("Stream cancelled");
      } else {
        console.error("Error:", error.message);
        outputResult = error.message;
      }
    } finally {
      isGenerating = false;
      abortController = null;
    }
  }

  function buildChatPayload(
    prompt: string,
    inputJson: string,
    stream: boolean,
    prevError?: string,
  ) {
    let userMessage = `Generate an OPA Rego policy for the following prompt: "${prompt}" using input: ${inputJson}. Only return valid Rego code.`;
    if (prevError) {
      userMessage += `An error in previous policy evaluation: "${prevError}""`;
    }
    return {
      model: "mistralai/mistral-small-3.1-24b-instruct:free",
      messages: [
        {
          role: "system",
          content:
            "You are a code generation assistant. Given a user request and input data, respond ONLY with a valid OPA Rego policy. Do NOT include any explanation, comments, or markdown formatting. Output only the Rego code. The request may contain an error from a previous policy evaluation. You must take it into account.",
        },
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
  ) {
    const decoder = new TextDecoder();
    let buffer = "";

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
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) applyEditorContent(content);
          } catch (e) {
            console.error("Invalid JSON chunk:", e.message);
          }
        }
      }
    }

    await reader.cancel();
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
    const payload = buildChatPayload(prompt, inputJson, stream, prevError);
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

    if (!stream) {
      const data = await response.json();
      const content =
        data.choices?.[0]?.message?.content || "No policy generated.";
      applyEditorContent(content);
    } else {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");
      await handleStreamResponse(reader);
    }
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
  });
</script>

<main class="container">
  <div class="editor-container">
    <h1>Policy Editor</h1>

    <textarea
      bind:value={policyPrompt}
      placeholder="Describe your desired policy"
      rows="2"
      class="prompt"
    ></textarea>
    <button on:click={generatePolicyHandler}>
      {#if isGenerating}
        Stop generation
      {:else}
        Generate
      {/if}
    </button>

    <div class="token-container">
      <label for="apiToken">OpenRouter API Token</label>
      <input
        id="apiToken"
        type="password"
        bind:value={apiToken}
        placeholder="Enter your token"
      />
    </div>

    <div bind:this={editorContainer} class="editor"></div>
  </div>

  <div class="right-container">
    <div class="input-container">
      <h2>Input JSON</h2>
      <textarea bind:value={inputJson} placeholder="Enter JSON" rows="6"
      ></textarea>
      {#if jsonError}
        <p class="error">{jsonError}</p>
      {/if}
    </div>

    <div class="output-container">
      <h2>Output</h2>
      <textarea value={outputResult} readonly rows="6"></textarea>
    </div>

    <button on:click={evaluatePolicy} disabled={isEvaluating}>
      {#if isEvaluating}
        Evaluating...
      {:else}
        Evaluate Policy
      {/if}
    </button>
  </div>
</main>

<style>
  .container {
    display: flex;
    height: 100vh;
  }

  .editor-container {
    flex: 1;
    padding: 16px;
    border-right: 1px solid #ccc;
    display: flex;
    flex-direction: column;
  }

  .editor {
    flex: 1;
    border: 1px solid #ccc;
  }

  .right-container {
    display: flex;
    flex-direction: column;
    width: 300px;
    padding: 16px;
  }

  .input-container {
    margin-bottom: 16px;
  }

  .output-container {
    margin-bottom: 16px;
  }

  textarea {
    width: 100%;
    font-family: monospace;
    font-size: 14px;
    padding: 8px;
    border: 1px solid #ccc;
    box-sizing: border-box;
  }

  .prompt {
    margin-bottom: 8px;
  }

  button {
    padding: 10px;
    background-color: #4caf50;
    color: white;
    border: none;
    cursor: pointer;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  button:hover {
    background-color: #45a049;
  }

  button:disabled {
    background-color: #cccccc;
    cursor: not-allowed;
  }

  .error {
    color: red;
    font-size: 14px;
    margin-top: 8px;
  }

  .token-container {
    margin-bottom: 16px;
  }

  input[type="password"] {
    width: 100%;
    padding: 8px;
    font-size: 14px;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-sizing: border-box;
  }
</style>
