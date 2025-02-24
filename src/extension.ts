// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import { commands, workspace, ExtensionContext, WorkspaceFolder, window } from 'vscode';
import { getWorkspaceFolder, isProperSubpathOf } from './utils/workspace-util';
import { WorkspaceContext } from './workspace';
import { ChatWebview } from './chatWebview';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  let workspaceRoot: string = getWorkspaceFolder(
    workspace.workspaceFolders as WorkspaceFolder[],
    window.activeTextEditor,
  );
  const workspaceContext = new WorkspaceContext(context, workspaceRoot);
  workspaceContext.registerCommands();

  /**
   * detect when active editor changes and the workspace too
   */
  const activeTextEditorWorkspaceChangesRegistration = window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document.uri) {
      const newWorkspaceRoot = getWorkspaceFolder(
        [workspace.getWorkspaceFolder(editor.document.uri)] as WorkspaceFolder[],
        window.activeTextEditor,
      );

      if (workspaceContext.workspaceRoot === newWorkspaceRoot) {
        // Prevent refresh everything when workspace stays the same as before
        return;
      }

      if (isProperSubpathOf(newWorkspaceRoot, workspaceContext.workspaceRoot)) {
        // Prevents workspace refresh when commenting on a file in a diff view which, apparently, points to a
        // (temporary?) workspace inside the current one.
        return;
      }

      workspaceContext.workspaceRoot = newWorkspaceRoot;
      workspaceContext.refreshCommands();
    }
  });

  const chatWebview = new ChatWebview(context);

  const activateChat = commands.registerCommand('codeReview.generateQuestions', async () => {
    // For instance, use the active editor's file content:
    const editor = window.activeTextEditor;
    if (!editor) {
      window.showErrorMessage('Please open a script file first.');
      return;
    }
    const scriptContent = editor.document.getText();
    const scriptFileName = editor.document.fileName;
    const highlightedText = editor.document.getText(editor.selection);
    // Show the chat webview with the script content in context
    chatWebview.show(highlightedText, scriptContent, scriptFileName);
  });

  // Register the new command
  context.subscriptions.push(activateChat);

  context.subscriptions.push(activeTextEditorWorkspaceChangesRegistration);
}

// this method is called when your extension is deactivated
export function deactivate() {}
