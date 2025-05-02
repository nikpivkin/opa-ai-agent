<script lang="ts">
    import { onMount } from 'svelte';
    import { EditorView, basicSetup } from 'codemirror';
  
    let editorContainer: HTMLDivElement;
    let editorView: EditorView;
  
    let inputJson: string = '{"method": "GET"}';
    let outputResult: string = '';
    let jsonError: string | null = null;

    function isValidJson(jsonString: string): boolean {
      try {
        JSON.parse(jsonString);
        return true;
      } catch (e) {
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
  
      const policy = editorView.state.doc.toString();
      outputResult = await evaluateRegoPolicy(policy, inputJson);
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
  
      try {
        const response = await fetch('https://play.openpolicyagent.org/v1/data', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });
  
        const data = await response.json();
  
        if (data.result && data.result.length > 0) {
          return JSON.stringify(data.result[0].expressions[0].value, null, 2);
        } else {
          return 'No result returned from policy evaluation.';
        }
      } catch (error) {
        return `Error: ${error.message}`;
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
  
      <button on:click={evaluatePolicy}>Evaluate Policy</button>
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
    }
  
    .editor {
      height: 100%;
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
  
    textarea {
      width: 100%;
      font-family: monospace;
      font-size: 14px;
      padding: 8px;
      border: 1px solid #ccc;
      box-sizing: border-box;
    }
  
    .output-container {
      margin-bottom: 16px;
    }
  
    button {
      padding: 10px;
      background-color: #4CAF50;
      color: white;
      border: none;
      cursor: pointer;
      border-radius: 4px;
    }
  
    button:hover {
      background-color: #45a049;
    }
  
    /* Стили для ошибок */
    .error {
      color: red;
      font-size: 14px;
      margin-top: 8px;
    }
  </style>
  