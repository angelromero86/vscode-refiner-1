import * as vscode from 'vscode';
import { RefinerStore } from './store';
import { isWebThread } from './types';
import { normalizeUrl } from './web/page';
import { WebSession } from './web/session';

const LAST_URL_KEY = 'refiner.web.lastUrl';

/** `http://localhost:4200/settings` → `localhost:4200`, for the status bar. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The browser half of Refiner inside VSCode: starts and stops the UI review
 * session (a Chrome window with the review overlay, see `web/session.ts`), shows
 * it in the status bar, and logs what happens to the "Refiner" output channel.
 * At most one session per window — Chrome allows one debugger per profile, and
 * the profile is per repo.
 */
export class BrowserReview implements vscode.Disposable {
  private session: WebSession | null = null;
  private starting = false;
  private readonly status: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when a session starts or ends. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    /** The `web-comments.json` store. */
    private readonly store: RefinerStore,
    private readonly authorName: () => string,
  ) {
    this.output = vscode.window.createOutputChannel('Refiner');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'refiner.webSessionMenu';
    void vscode.commands.executeCommand('setContext', 'refiner.webSession', false);
  }

  get running(): boolean {
    return this.session !== null;
  }

  /** Ask for a URL (remembering the last one) and open the session on it. */
  async open(): Promise<void> {
    if (this.session) {
      await this.menu();
      return;
    }
    if (this.starting) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: 'Refiner: Review UI in Browser',
      prompt: 'URL of your running app. Chrome opens on it with the review overlay: press C and click any element to leave a thread.',
      placeHolder: 'localhost:4200',
      value: this.context.workspaceState.get<string>(LAST_URL_KEY) ?? '',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter the URL of your running app'),
    });
    if (input === undefined) {
      return;
    }
    await this.context.workspaceState.update(LAST_URL_KEY, input.trim());
    await this.start(normalizeUrl(input));
  }

  async start(url: string): Promise<void> {
    if (this.session || this.starting) {
      return;
    }
    this.starting = true;
    try {
      const session = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Refiner: opening Chrome on ${url}…` },
        () =>
          WebSession.start({
            root: this.folder.uri.fsPath,
            url,
            author: this.authorName(),
            store: this.store,
            chromePath: vscode.workspace.getConfiguration('refiner').get<string>('chromePath'),
            log: (line) => this.log(line),
          }),
      );
      this.session = session;
      this.log(`session open on ${url}`);
      this.status.text = `$(browser) Refiner: ${hostOf(url)}`;
      this.status.tooltip = new vscode.MarkdownString(
        `**UI review session** on ${url}\n\n` +
          'In the page: `C` comment on an element · `shift+C` all threads · `esc` cancel\n\n' +
          'Click for actions.',
      );
      this.status.show();
      void vscode.commands.executeCommand('setContext', 'refiner.webSession', true);
      this._onDidChange.fire();
      void session.done.then(() => this.ended(session));
    } catch (err) {
      const message = (err as Error).message;
      this.log(`! ${message}`);
      const pick = await vscode.window.showErrorMessage(`Refiner: ${message}`, 'Show Log');
      if (pick) {
        this.output.show();
      }
    } finally {
      this.starting = false;
    }
  }

  private ended(session: WebSession): void {
    if (this.session !== session) {
      return;
    }
    this.session = null;
    this.status.hide();
    void vscode.commands.executeCommand('setContext', 'refiner.webSession', false);
    this.log('browser closed');
    vscode.window.setStatusBarMessage('Refiner: browser review session ended', 4000);
    this._onDidChange.fire();
  }

  async stop(): Promise<void> {
    await this.session?.close(); // -> done -> ended()
  }

  /** The status bar item's menu. */
  async menu(): Promise<void> {
    const session = this.session;
    if (!session) {
      await this.open();
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(eye) Focus Browser Window', action: 'focus' },
        { label: '$(list-tree) Show UI Threads', action: 'threads' },
        { label: '$(output) Show Log', action: 'log' },
        { label: '$(debug-stop) Stop Session', action: 'stop' },
      ],
      { title: `Refiner: UI review on ${session.url}` },
    );
    switch (pick?.action) {
      case 'focus':
        await session.focus();
        break;
      case 'threads':
        await vscode.commands.executeCommand('refiner.uiThreads.focus');
        break;
      case 'log':
        this.output.show();
        break;
      case 'stop':
        await this.stop();
        break;
    }
  }

  /** Editor → browser: show a thread's page with its card open, starting a session if needed. */
  async show(threadId: string): Promise<void> {
    if (!this.session) {
      const thread = this.store.threads.find((t) => t.id === threadId);
      if (!thread || !isWebThread(thread)) {
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        `Refiner: no browser review session is open. Open Chrome on ${thread.web.url}?`,
        'Open Browser',
      );
      if (!pick) {
        return;
      }
      await this.start(thread.web.url);
      if (!this.session) {
        return;
      }
    }
    try {
      await this.session.goto(threadId);
    } catch (err) {
      void vscode.window.showErrorMessage(`Refiner: ${(err as Error).message}`);
    }
  }

  private log(line: string): void {
    this.output.appendLine(`${new Date().toTimeString().slice(0, 8)} ${line}`);
  }

  dispose(): void {
    // Closing VSCode (or reloading the window) takes the browser with it: an
    // overlay with nobody behind it could only say "not connected".
    void this.session?.close();
    this.status.dispose();
    this.output.dispose();
    this._onDidChange.dispose();
  }
}
