import { window, ViewColumn, WebviewPanel, ExtensionContext } from 'vscode';
import OpenAI from 'openai';

export class ChatWebview {
  private panel: WebviewPanel | undefined;

  constructor(private context: ExtensionContext) {}

  public async show(scriptContent: string) {
    // Dispose any existing panel
    if (this.panel) {
      this.panel.dispose();
    }
    this.panel = window.createWebviewPanel('chat', 'Coding Questions Chat', ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    });
    this.panel.webview.html = this.getHtmlForWebview();

    // Listen for messages from the webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'ask') {
        // Retrieve stored API key (if any)
        let apiKey = await this.context.secrets.get('openaiApiKey');
        if (!apiKey) {
          // Prompt the user for the API key if not already saved
          apiKey = await window.showInputBox({
            prompt: 'Please enter your OpenAI API Key',
            placeHolder: 'YOUR_OPENAI_API_KEY',
            password: true,
          });
          if (!apiKey) {
            window.showErrorMessage('No API key provided.');
            return;
          }
          // Save the API key for later use
          await this.context.secrets.store('openaiApiKey', apiKey);
        }
        // Generate questions using the modern OpenAI API call
        const answer = await this.generateQuestions(apiKey, scriptContent, message.text);

        // Send error message to the webview if the API key is invalid
        if (answer.includes('Error generating questions:')) {
          this.panel?.webview.postMessage({ command: 'error', text: answer });
        } else {
          // Send the answer back to the webview
          this.panel?.webview.postMessage({ command: 'answer', text: answer });
        }
      } else if (message.command === 'updateKey') {
        // Prompt the user for a new API key, and store it.
        const newApiKey = await window.showInputBox({
          prompt: 'Enter a new OpenAI API Key',
          placeHolder: 'YOUR_OPENAI_API_KEY',
          password: true,
        });
        if (!newApiKey) {
          window.showErrorMessage('No new API key provided.');
          this.panel?.webview.postMessage({ command: 'keyUpdateResult', text: 'Update canceled.' });
          return;
        }
        await this.context.secrets.store('openaiApiKey', newApiKey);
        window.showInformationMessage('API key updated successfully.');
        this.panel?.webview.postMessage({ command: 'keyUpdateResult', text: 'API key updated successfully.' });
      }
    });
  }

  private getHtmlForWebview(): string {
    // Inline HTML that builds the chat UI with a "Send" button (always enabled)
    // and an "Update API Key" button.
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Chat</title>
        <!-- Load marked.js for markdown parsing -->
        <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      </head>
      <body>
        <h2>Generate Coding Questions</h2>
        <div id="chat" style="height:300px; overflow:auto; border:1px solid #ccc; padding:10px;"></div>
        <input id="userInput" type="text" placeholder="Ask something..." style="width:80%;" />
        <button id="sendButton" onclick="sendMessage()">Send</button>
        <button id="updateKeyButton" onclick="updateKey()">Update API Key</button>
        <script>
          const vscode = acquireVsCodeApi();
          function sendMessage() {
            const input = document.getElementById('userInput');
            vscode.postMessage({ command: 'ask', text: input.value });
            input.value = '';
          }
          function updateKey() {
            vscode.postMessage({ command: 'updateKey' });
          }
          window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'answer') {
              // Convert Markdown to HTML using marked
              const htmlContent = marked.parse(message.text);
              const chatDiv = document.getElementById('chat');
              chatDiv.innerHTML += '<div><strong>Questions:</strong><br/>' + htmlContent + '</div>';
            }
            if (message.command === 'error') {
              const chatDiv = document.getElementById('chat');
              chatDiv.innerHTML += '<p><em><strong>Error:</strong><br/>' + message.text + '</em></p>';
            }
            if (message.command === 'keyUpdateResult') {
              const chatDiv = document.getElementById('chat');
              chatDiv.innerHTML += '<p><em>' + message.text + '</em></p>';
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Uses the modern OpenAI client library to generate coding questions.
   *
   * @param apiKey The API key for authentication.
   * @param scriptContent The content of the script file.
   * @param userPrompt Additional user text.
   * @returns A promise that resolves with the generated questions.
   */
  private async generateQuestions(apiKey: string, scriptContent: string, userPrompt: string): Promise<string> {
    // Build a prompt that includes the script content and the user's additional message.
    const prompt = `
    Given the following script:
    ==================
    ${scriptContent}
    ==================
    ${userPrompt ? userPrompt : 'Generate some coding questions that test understanding of the script.'}
    `;

    try {
      // Create a new OpenAI client instance with the API key.
      const openai = new OpenAI({
        apiKey: apiKey.trim(),
      });

      // Call the chat completions endpoint using the new API format.
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // Replace with your desired model
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt },
        ],
        store: true,
      });

      // Return the generated message (if available)
      const generatedMessage = completion.choices[0].message?.content;
      return generatedMessage ? generatedMessage.trim() : 'No response received.';
    } catch (error: any) {
      //   console.error(error);
      const errorMessage = error.response?.data?.error?.message || error.message;

      // If the error response exists and has a status of 401,
      // it indicates an authentication error (invalid or incorrect API key).
      if (errorMessage.includes('401')) {
        // Clear the stored API key.
        await this.context.secrets.delete('openaiApiKey');
        // Inform the user about the authentication error.
        window.showErrorMessage(
          'Authentication Error (401): The API key provided is invalid or incorrect. Please update your API key.',
        );
        // Notify the webview that a key update is needed.
        this.panel?.webview.postMessage({ command: 'keyUpdateResult', text: 'Please update your API key.' });
        return 'Error generating questions: Invalid API key.';
      }
      return 'Error generating questions: ' + errorMessage;
    }
  }
}
