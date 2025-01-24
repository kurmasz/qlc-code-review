import { window, ViewColumn, ExtensionContext, workspace, Range, WebviewPanel, Uri, TextEditor } from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { ReviewCommentService } from './review-comment';
import { createCommentFromObject, CsvEntry, CsvStructure } from './model';
import { CommentListEntry } from './comment-list-entry';
import { clearSelection, getSelectionRanges } from './utils/editor-utils';
import { colorizedBackgroundDecoration } from './utils/decoration-utils';
// Import helper function to get code for file
import { getCodeForFile } from './utils/workspace-util';

export class WebViewComponent {
  /** Store all configured categories */
  private categories: string[] = [];
  /** Store the color for background-highlighting */
  private highlightDecorationColor: string = '';
  /** Panel used to add/edit a comment */
  private panel: WebviewPanel | null = null;
  /** Reference to the working editor during note edition */
  private editor: TextEditor | null = null;

  /**
   * Show the comment edition panel
   *
   * @param title The title of the panel
   * @param fileName The file referenced by the comment
   * @return WebviewPanel The panel object
   */
  private showPanel(title: string, fileName: string): WebviewPanel {
    this.panel?.dispose(); // Dispose existing panel to avoid duplicates
    this.panel = this.createWebView(title);
    this.panel.webview.html = this.getWebviewContent(fileName);

    return this.panel;
  }

  constructor(public context: ExtensionContext) {
    this.categories = workspace.getConfiguration().get('code-review.categories') as string[];
    this.highlightDecorationColor = workspace
      .getConfiguration()
      .get('code-review.codeSelectionBackgroundColor') as string;
  }

  /**
   * Get and store the working text editor
   *
   * @return TextEditor
   */
  private getWorkingEditor(): TextEditor {
    if (this.editor === null) {
      this.editor = window.activeTextEditor ?? window.visibleTextEditors[0];
    }

    return this.editor;
  }

  /**
   * Dispose the stored working editor
   */
  private disposeWorkingEditor() {
    this.editor = null;
  }

  /**
   * Get cached comments from workspace configuration
   */
  private getCachedComments(): CsvEntry[] {
    // Get the workspace folder path
    const workspaceFolders = workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      window.showErrorMessage('No workspace folder is open. Unable to retrieve cached comments.');
      return [];
    }

    // Use the first workspace folder
    const workspacePath = workspaceFolders[0].uri.fsPath;

    // File path in the workspace directory
    const workspaceFile = path.join(workspacePath, 'cached-comments.json');

    // Check if the file exists
    if (!fs.existsSync(workspaceFile)) {
      // Create the file if it doesn't exist
      try {
        fs.writeFileSync(workspaceFile, '[]');
      } catch (error) {
        window.showErrorMessage(`Error creating the cached comments file: ${error}`);
        return [];
      }
    }

    // Read and parse the file content
    try {
      return JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
    } catch (error) {
      window.showErrorMessage(`Error reading the cached comments file: ${error}`);
      return [];
    }
  }

  deleteComment(commentService: ReviewCommentService, entry: CommentListEntry) {
    commentService.deleteComment(entry.id, entry.description);
    this.panel?.dispose();
  }

  editComment(commentService: ReviewCommentService, selections: Range[], data: CsvEntry) {
    const editor = this.getWorkingEditor();
    // Clear the current text selection to avoid unwanted code selection changes.
    // (see `ReviewCommentService::getSelectedLines()`).
    clearSelection(editor);
    // highlight selection
    const decoration = colorizedBackgroundDecoration(selections, editor, this.highlightDecorationColor);

    // initialize new web tab
    const panel = this.showPanel('Edit code review comment', editor.document.fileName);
    // const pathToHtml = Uri.file(path.join(this.context.extensionPath, 'src', 'webview.html'));
    // const pathUri = pathToHtml.with({ scheme: 'vscode-resource' });
    // panel.webview.html = fs.readFileSync(pathUri.fsPath, 'utf8');
    // const priorities = workspace.getConfiguration().get('code-review.priorities') as string[];
    data = CsvStructure.finalizeParse(data);
    panel.webview.postMessage({ comment: { ...data }, cachedComments: this.getCachedComments() }); // send data, cached comments to webview

    // Add logic to include encoded code snippet during editing
    const encodedSnippet = getCodeForFile(data.filename, data.lines, this.context.extensionPath);
    data.code = encodedSnippet;

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'submit':
            const formData = JSON.parse(message.text) as CsvEntry;
            const newEntry: CsvEntry = {
              ...data,
              title: formData.title || '',
              additional: formData.additional || '',
              comment: formData.comment || '',
              category: formData.category || '',
              priority: formData.priority || 0,
              private: formData.private || 0,
              code: encodedSnippet, // Include encoded snippet
            };
            commentService.updateComment(newEntry, this.getWorkingEditor());

            // if comment is private, cache it
            if (newEntry.private) {
              commentService.cacheComment(newEntry, this.context);
            }
            panel.dispose();
            break;

          case 'cancel':
            panel.dispose();
            break;

          case 'delete':
            window
              .showInformationMessage('Do you really want to delete this comment?', ...['Yes', 'No'])
              .then((answer) => {
                if (answer === 'Yes') {
                  commentService.deleteComment(data.id, data.title);
                  panel.dispose();
                } else {
                  // on cancel: load webview again
                  this.editComment(commentService, selections, data);
                }
              });
            break;
        }
      },
      undefined,
      this.context.subscriptions,
    );

    panel.onDidDispose(() => {
      // reset highlight selected lines
      decoration.dispose();
      this.disposeWorkingEditor();
    });
  }

  addComment(commentService: ReviewCommentService) {
    // highlight selected lines
    const editor = this.getWorkingEditor();
    const decoration = colorizedBackgroundDecoration(getSelectionRanges(editor), editor, this.highlightDecorationColor);

    const panel = this.showPanel('Add code review comment', editor.document.fileName);

    // Generate encoded snippet for the selected lines
    const filename = editor.document.fileName;
    const selectionRanges = getSelectionRanges(editor);
    const lineRanges = selectionRanges
      .map((range) => `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`)
      .join('|');
    const encodedSnippet = getCodeForFile(filename, lineRanges, this.context.extensionPath);

    panel.webview.postMessage({ cachedComments: this.getCachedComments() }); // send cached comments to webview

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'submit':
            const newComment: CsvEntry = { ...createCommentFromObject(message.text), code: encodedSnippet }; // Include encoded snippet

            commentService.addComment(newComment, this.getWorkingEditor());

            // if comment is private, cache it
            if (newComment.private) {
              commentService.cacheComment(newComment, this.context);
            }
            break;

          case 'cancel':
            break;
        }

        panel.dispose();
      },
      undefined,
      this.context.subscriptions,
    );

    panel.onDidDispose(() => {
      // reset highlight selected lines
      decoration.dispose();
      this.disposeWorkingEditor();
    });
  }

  private createWebView(title: string): WebviewPanel {
    return window.createWebviewPanel(
      'text',
      title,
      { viewColumn: ViewColumn.Beside },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
  }

  getWebviewContent(fileName: string): string {
    let selectListString = this.categories.reduce((current, category) => {
      return current + `<option value="${category}">${category}</option>`;
    }, '');
    const uri = Uri.joinPath(this.context.extensionUri, 'dist', 'webview.html');
    const pathUri = uri.with({ scheme: 'vscode-resource' });
    return fs
      .readFileSync(pathUri.fsPath, 'utf8')
      .replace('SELECT_LIST_STRING', selectListString)
      .replace('FILENAME', path.basename(fileName));
  }
}
