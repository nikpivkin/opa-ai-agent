<script lang="ts">
    import { onMount } from 'svelte';
    import { EditorView, basicSetup } from 'codemirror';
  
    let editorContainer: HTMLDivElement;
    let editorView: EditorView;
  
    let inputJson: string = '{"method": "GET"}';
    let outputResult: string = '';
    let jsonError: string | null = null;
    let policyPrompt: string = 'The policy should verify that the GET method';
    let apiToken: string = localStorage.getItem('openrouter_token') || '';
    $: localStorage.setItem('openrouter_token', apiToken);
    let stream: boolean = true;
    let isGenerating = false;
    let isEvaluating = false;
  
    function isValidJson(jsonString: string): boolean {
      try {
        JSON.parse(jsonString);
        return true;
      } catch {
        return false;
      }
    }
  
    async function evaluatePolicy() {
      if (!isValidJson(inputJson)) {
        jsonError = "Invalid JSON format!";
        outputResult = '';
        return;
      } else {
        jsonError = null;
      }
  
     
      isEvaluating = true;

      try {
        const policy = editorView.state.doc.toString();
        outputResult = await evaluateRegoPolicy(policy, inputJson);
      } catch (error) {
        outputResult = `Error: ${error.message}`;
      } finally {
        isEvaluating = false;
      }
    }
  
    async function evaluateRegoPolicy(policy: string, inputJson: string): Promise<string> {
      const requestBody = {
        input: JSON.parse(inputJson),
        rego_modules: {
          "policy.rego": policy
        },
        rego_version: 1,
        strict: true
      };

      const response = await fetch('https://play.openpolicyagent.org/v1/data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (data.code && data.message) {
        return `Error: ${data.message}`;
      }

      if (data.result && data.result.length > 0) {
        return JSON.stringify(data.result[0].expressions[0].value, null, 2);
      } else {
        return 'No result returned from policy evaluation.';
      }
    }
  
    async function generatePolicyHandler() {
      isGenerating = true;
      try {
        await generatePolicy(policyPrompt, inputJson, apiToken);
      } catch (error) {
        console.error("Error:", error.message)
      } finally {
        isGenerating = false
      }
    }
  
    async function generatePolicy(prompt: string, inputJson: string, token: string) {
      const model = "mistralai/mistral-small-3.1-24b-instruct:free";
      const temperature = 0.7;
      const messages = [
        {
          role: "system",
          content: "You are a code generation assistant. Given a user request and input data, respond ONLY with a valid OPA Rego policy. Do NOT include any explanation, comments, or markdown formatting. Output only the Rego code."
        },
        {
          role: "user",
          content: `Generate an OPA Rego policy for the following prompt: "${prompt}" using input: ${inputJson}. Only return valid Rego code. Do not include any explanation or formatting.`
        }
      ];
  
      const payload = {
        model,
        messages,
        temperature,
        reasoning: {
          max_tokens: 1024
        },
        stream: stream,
      };
  
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      editorView.dispatch({
        changes: {from: 0, to: editorView.state.doc.length, insert:''}
      })

      if (!stream) {
        const data = await response.json();

        if (data.choices && data.choices.length > 0) {
          editorView.dispatch({
            changes: {
              from: 0,
              to: editorView.state.doc.length,
              insert: data.choices[0].message.content
              }
          });
          return;
        } else {
          editorView.dispatch({
            changes: {
              from: 0,
              to: editorView.state.doc.length,
              insert: "No policy generated."
            }
          });
          return;
        }
      } else {
        // https://openrouter.ai/docs/api-reference/streaming
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Response body is not readable');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Append new chunk to buffer
            buffer += decoder.decode(value, { stream: true });
            // Process complete lines from buffer
            while (true) {
              const lineEnd = buffer.indexOf('\n');
              if (lineEnd === -1) break;
              const line = buffer.slice(0, lineEnd).trim();
              buffer = buffer.slice(lineEnd + 1);
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') break;
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices[0].delta.content;
                  if (content) {
                    editorView.dispatch({
                      changes: {
                        from: editorView.state.doc.length,
                        insert: content
                        }
                    });
                  }
                } catch (e) {
                  // Ignore invalid JSON
                  console.error("Invalid json:", e.message)
                }
              }
            }
          }
        } finally {
          reader.cancel();
        }
      }
    }
  
    onMount(() => {
      editorView = new EditorView({
        doc: `package policy
  
allow {
  input.method == "GET"
}`,
        extensions: [basicSetup],
        parent: editorContainer
      });
    });
  </script>
  
  <main class="container">
    <div class="editor-container">
      <h1>Policy Editor</h1>
  
      <textarea bind:value={policyPrompt} 
        placeholder="Describe your desired policy" 
        rows="2" 
        class="prompt"
      ></textarea>
      <button on:click={generatePolicyHandler} disabled={isGenerating}>
        {#if isGenerating}
          Generating...
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
        <textarea bind:value={inputJson} placeholder="Enter JSON" rows="6"></textarea>
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
      background-color: #4CAF50;
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
  