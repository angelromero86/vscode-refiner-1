import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { captureAnchor, relocate, splitLines } from './anchor';
import { BrowserReview } from './browser';
import { RefinerStore, ThreadPatch, WEB_FILE } from './store';
import { UiNode, UiThreadsTree } from './tree';
import { CommentRole, isWebThread, StoredComment, StoredThread, ThreadStatus, WebThread } from './types';
import { sourceLocation } from './web/source';

const CONTROLLER_ID = 'refiner.commentController';
const RECONCILE_DEBOUNCE_MS = 300;

/** A CommentThread we created, tagged with its stored counterpart and the store it lives in. */
interface ThreadWithId extends vscode.CommentThread {
  refinerId?: string;
  refinerStore?: RefinerStore;
}

/** Cached, re-anchored position for display (may differ from what's on disk). */
interface AnchorState {
  start: number;
  end: number;
  outdated: boolean;
}

/** Where a stored thread is rendered in the editor. */
interface Placement {
  uri: vscode.Uri;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  outdated: boolean;
  /** Shown in the thread header, before the status. */
  label?: string;
}

/** Our implementation of a single comment shown inline in the editor. */
class RefinerComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  savedBody: string | vscode.MarkdownString;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue: string;
  timestamp?: Date;
  label?: string;

  constructor(
    readonly storeId: string,
    readonly parentThreadId: string,
    readonly role: CommentRole,
    body: string,
    authorName: string,
    createdAt?: string,
  ) {
    this.body = new vscode.MarkdownString(body);
    this.savedBody = this.body;
    this.author = { name: authorName };
    // Used by menu `when` clauses (e.g. `comment == user`).
    this.contextValue = role;
    this.timestamp = createdAt ? new Date(createdAt) : undefined;
    if (role === 'assistant') {
      this.label = 'Claude Code';
    }
  }
}

function bodyToString(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    console.log('[Refiner] no workspace folder open — extension idle.');
    return;
  }
  console.log(`[Refiner] activated for ${folder.uri.fsPath}`);

  const relPath = (uri: vscode.Uri): string =>
    path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  const absUri = (rel: string): vscode.Uri =>
    vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
  const authorName = (): string => {
    const configured = vscode.workspace
      .getConfiguration('refiner')
      .get<string>('authorName')
      ?.trim();
    return configured || os.userInfo().username;
  };
  const getDocLines = (uri: vscode.Uri): string[] | undefined => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    return doc ? splitLines(doc.getText()) : undefined;
  };
  const newComment = (body: string): StoredComment => ({
    id: store.id('c'),
    author: authorName(),
    role: 'user',
    body,
    createdAt: new Date().toISOString(),
  });

  // Two stores, one shape: threads on lines of code, and threads on elements of
  // the running app (left in the browser, see `web/session.ts`).
  const store = new RefinerStore(folder);
  const webStore = new RefinerStore(folder, WEB_FILE);
  const browser = new BrowserReview(context, folder, webStore, authorName);
  const tree = new UiThreadsTree(webStore, folder);
  const treeView = vscode.window.createTreeView('refiner.uiThreads', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Refiner');
  controller.options = {
    prompt: 'Comment…',
    placeHolder: 'Leave a comment for Claude Code',
  };
  // Allow commenting on any line of any file in the workspace (except the stores themselves).
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document) => {
      if (document.uri.scheme !== 'file') {
        return [];
      }
      if (!document.uri.fsPath.startsWith(folder.uri.fsPath)) {
        return [];
      }
      if (document.uri.fsPath === store.uri.fsPath || document.uri.fsPath === webStore.uri.fsPath) {
        return [];
      }
      return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    },
  };

  // Maps stored thread id -> the live CommentThread rendered in the editor.
  const threads = new Map<string, vscode.CommentThread>();
  // Re-anchored display positions, keyed by stored thread id.
  const anchors = new Map<string, AnchorState>();
  // Debounce timers for live re-anchoring while typing, keyed by file path.
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();

  /** The store a thread id belongs to. */
  const storeOf = (threadId: string): RefinerStore =>
    (threads.get(threadId) as ThreadWithId | undefined)?.refinerStore ??
    (webStore.threads.some((t) => t.id === threadId) ? webStore : store);

  function placeCode(st: StoredThread): Placement {
    const pos = anchors.get(st.id);
    return {
      uri: absUri(st.file),
      start: pos?.start ?? st.range.start,
      end: pos?.end ?? st.range.end,
      outdated: pos?.outdated ?? false,
    };
  }

  /**
   * A UI thread is shown at the source location the browser resolved for its
   * element (the Angular template line, else the component file) — a hint the
   * dev build gave us, so there is nothing to re-anchor. Without one, the
   * thread is only in the UI Threads view.
   */
  function placeWeb(st: WebThread): Placement | undefined {
    const loc = sourceLocation(st.web.source);
    if (!loc) {
      return undefined;
    }
    const a = st.web.anchor;
    const line = loc.line ?? 1;
    return {
      uri: absUri(loc.file),
      start: line,
      end: line,
      outdated: false,
      label: `UI · ${st.web.page} · <${a.tag}>${a.text ? ` “${clip(a.text, 40)}”` : ''}`,
    };
  }

  /** Reconcile the live CommentThreads with what's stored on disk. */
  function sync(): void {
    const seen = new Set<string>();
    const render = (st: StoredThread, owner: RefinerStore, p: Placement): void => {
      seen.add(st.id);
      const range = new vscode.Range(Math.max(0, p.start - 1), 0, Math.max(0, p.end - 1), 0);
      let thread = threads.get(st.id) as ThreadWithId | undefined;
      if (!thread) {
        thread = controller.createCommentThread(p.uri, range, []) as ThreadWithId;
        threads.set(st.id, thread);
      } else {
        thread.range = range;
      }
      thread.refinerId = st.id;
      thread.refinerStore = owner;
      thread.comments = st.comments.map(
        (c) => new RefinerComment(c.id, st.id, c.role, c.body, c.author, c.createdAt),
      );
      // contextValue drives the resolve/reopen menu buttons.
      thread.contextValue = st.status;
      thread.canReply = st.status !== 'resolved';
      const status =
        st.status === 'resolved'
          ? 'Resolved'
          : p.outdated
            ? 'Outdated · code changed'
            : undefined;
      thread.label = [p.label, status].filter(Boolean).join(' · ') || undefined;
      thread.state =
        st.status === 'resolved'
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
    };
    for (const st of store.threads) {
      render(st, store, placeCode(st));
    }
    for (const st of webStore.threads) {
      const p = isWebThread(st) ? placeWeb(st) : undefined;
      if (p) {
        render(st, webStore, p);
      }
    }
    // Drop threads that no longer exist on disk.
    for (const [id, thread] of threads) {
      if (!seen.has(id)) {
        thread.dispose();
        threads.delete(id);
        anchors.delete(id);
      }
    }
  }

  /** The count of open UI threads on the view's container. */
  function updateBadge(): void {
    const open = tree.threads.filter((t) => t.status === 'open').length;
    treeView.badge = open ? { value: open, tooltip: `${open} open UI thread${open === 1 ? '' : 's'}` } : undefined;
  }

  /**
   * Re-anchor every code thread that lives in `uri` against the file's current
   * content. Updates the in-memory display positions, and (when `persist`) writes
   * corrected ranges and backfilled anchors to disk. UI threads are not touched:
   * their position is a hint from the browser, not a content anchor.
   */
  async function reconcileDoc(uri: vscode.Uri, persist: boolean): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }
    const lines = getDocLines(uri);
    if (!lines) {
      return;
    }
    const rel = relPath(uri);
    const patches: ThreadPatch[] = [];
    for (const st of store.threads) {
      if (st.file !== rel) {
        continue;
      }
      if (!st.anchor) {
        // First time we see this thread with the file open: snapshot its anchor.
        anchors.set(st.id, { start: st.range.start, end: st.range.end, outdated: false });
        if (persist) {
          patches.push({ id: st.id, anchor: captureAnchor(lines, st.range.start, st.range.end) });
        }
        continue;
      }
      const res = relocate(lines, st.anchor, st.range.start);
      anchors.set(st.id, { start: res.start, end: res.end, outdated: res.status === 'lost' });
      if (persist && res.status === 'moved' && (res.start !== st.range.start || res.end !== st.range.end)) {
        patches.push({ id: st.id, range: { start: res.start, end: res.end } });
      }
    }
    if (patches.length) {
      await store.patchThreads(patches); // -> onDidChange -> sync()
    } else {
      sync();
    }
  }

  function scheduleReconcile(uri: vscode.Uri): void {
    const key = uri.fsPath;
    const existing = debounce.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    debounce.set(
      key,
      setTimeout(() => {
        debounce.delete(key);
        void reconcileDoc(uri, false);
      }, RECONCILE_DEBOUNCE_MS),
    );
  }

  store.onDidChange(() => sync());
  webStore.onDidChange(() => {
    sync();
    updateBadge();
  });

  // ---- Command handlers: comment threads ------------------------------------

  // "+" on an empty commenting range: create a brand-new thread.
  async function createThread(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread as ThreadWithId;
    const storedThreadId = store.id('t');
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const start1 = range.start.line + 1;
    const end1 = range.end.line + 1;
    const lines = getDocLines(thread.uri);
    const stored: StoredThread = {
      id: storedThreadId,
      file: relPath(thread.uri),
      range: { start: start1, end: end1 },
      status: 'open',
      comments: [newComment(reply.text)],
      anchor: lines ? captureAnchor(lines, start1, end1) : undefined,
    };
    // Reuse the thread VSCode just created so sync() updates it in place
    // instead of creating a duplicate.
    thread.refinerId = storedThreadId;
    thread.refinerStore = store;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    threads.set(storedThreadId, thread);
    anchors.set(storedThreadId, { start: start1, end: end1, outdated: false });
    await store.addThread(stored);
  }

  async function replyThread(reply: vscode.CommentReply): Promise<void> {
    const id = (reply.thread as ThreadWithId).refinerId;
    if (!id) {
      return;
    }
    await storeOf(id).addComment(id, newComment(reply.text));
  }

  async function resolveThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as ThreadWithId).refinerId;
    if (id) {
      await storeOf(id).setStatus(id, 'resolved');
    }
  }

  async function reopenThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as ThreadWithId).refinerId;
    if (id) {
      await storeOf(id).setStatus(id, 'open');
    }
  }

  async function deleteThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as ThreadWithId).refinerId;
    if (id) {
      await storeOf(id).deleteThread(id);
    }
  }

  function editComment(comment: RefinerComment): void {
    const thread = threads.get(comment.parentThreadId);
    if (!thread) {
      return;
    }
    // Reassign to a new array so VSCode re-renders in edit mode.
    thread.comments = thread.comments.map((c) => {
      if ((c as RefinerComment).storeId === comment.storeId) {
        c.mode = vscode.CommentMode.Editing;
      }
      return c;
    });
  }

  async function saveComment(comment: RefinerComment): Promise<void> {
    const thread = threads.get(comment.parentThreadId);
    if (!thread) {
      return;
    }
    const live = thread.comments.find(
      (c) => (c as RefinerComment).storeId === comment.storeId,
    ) as RefinerComment | undefined;
    if (!live) {
      return;
    }
    // VSCode wrote the edited text into `live.body`; persist it. The resulting
    // store change re-renders the thread back in Preview mode via sync().
    await storeOf(comment.parentThreadId).updateComment(
      comment.parentThreadId,
      comment.storeId,
      bodyToString(live.body),
    );
  }

  function cancelEdit(): void {
    // Rebuild everything from disk, discarding any in-progress edit.
    sync();
  }

  async function deleteComment(comment: RefinerComment): Promise<void> {
    await storeOf(comment.parentThreadId).deleteComment(comment.parentThreadId, comment.storeId);
  }

  async function refresh(): Promise<void> {
    await Promise.all([store.init(), webStore.init()]);
  }

  async function reanchor(): Promise<void> {
    for (const doc of vscode.workspace.textDocuments) {
      await reconcileDoc(doc.uri, true);
    }
    void vscode.window.showInformationMessage('Refiner: re-anchored comments to current code.');
  }

  // ---- Command handlers: UI threads view -------------------------------------

  const threadOf = (node?: UiNode): WebThread | undefined =>
    node && node.kind !== 'page' ? node.thread : undefined;

  /** Open the element's source in the editor, with its comment thread expanded. */
  async function uiOpenSource(node?: UiNode): Promise<void> {
    const t = threadOf(node);
    if (!t) {
      return;
    }
    const loc = sourceLocation(t.web.source);
    if (!loc) {
      void vscode.window.showInformationMessage(
        'Refiner: this thread has no source location — the app was not a dev build, or its framework is not recognised. The screenshot and the element’s text are in the thread.',
      );
      return;
    }
    const line = Math.max(0, (loc.line ?? 1) - 1);
    try {
      await vscode.window.showTextDocument(absUri(loc.file), {
        selection: new vscode.Range(line, 0, line, 0),
      });
    } catch {
      void vscode.window.showErrorMessage(`Refiner: ${loc.file} is not in this workspace.`);
      return;
    }
    const thread = threads.get(t.id);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  async function uiShowInBrowser(node?: UiNode): Promise<void> {
    const t = threadOf(node);
    if (t) {
      await browser.show(t.id);
    }
  }

  async function uiOpenShot(node?: UiNode): Promise<void> {
    const t = threadOf(node);
    if (!t) {
      return;
    }
    if (!t.web.shot) {
      void vscode.window.showInformationMessage('Refiner: this thread has no screenshot.');
      return;
    }
    await vscode.commands.executeCommand('vscode.open', absUri(t.web.shot));
  }

  /** Click on a thread: its source if known, else its screenshot. */
  async function uiOpen(node?: UiNode): Promise<void> {
    const t = threadOf(node);
    if (!t) {
      return;
    }
    if (sourceLocation(t.web.source)) {
      await uiOpenSource(node);
    } else if (t.web.shot) {
      await uiOpenShot(node);
    }
  }

  async function uiReply(node?: UiNode): Promise<void> {
    const t = threadOf(node);
    if (!t) {
      return;
    }
    const a = t.web.anchor;
    const body = await vscode.window.showInputBox({
      title: `Refiner: reply on ${t.web.page} · <${a.tag}>${a.text ? ` “${clip(a.text, 40)}”` : ''}`,
      prompt: 'Markdown. The reply shows up in the browser card and in the thread.',
      placeHolder: 'Reply…',
      ignoreFocusOut: true,
    });
    if (!body?.trim()) {
      return;
    }
    await webStore.addComment(t.id, newComment(body));
  }

  async function uiSetStatus(node: UiNode | undefined, status: ThreadStatus): Promise<void> {
    const t = threadOf(node);
    if (t) {
      await webStore.setStatus(t.id, status);
    }
  }

  async function uiDelete(node?: UiNode): Promise<void> {
    const t = threadOf(node);
    if (!t) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Refiner: delete this UI thread and its ${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}?`,
      { modal: true },
      'Delete',
    );
    if (answer === 'Delete') {
      await webStore.deleteThread(t.id);
    }
  }

  /**
   * Copy the bundled Claude Code skills into ~/.claude/skills so the review loop
   * works out of the box. The extension is only half the system — without the
   * skills, Claude Code has no `/refine-review`, `/refine-resolve` or `/refine-web`.
   *
   * `refine-web` also gets the compiled browser scripts (`out/web` + the overlay)
   * as `scripts/`, so `/refine-resolve` can re-photograph an element with
   * `node ~/.claude/skills/refine-web/scripts/cli.js shot <id>` — no refiner CLI needed.
   */
  async function installSkills(): Promise<void> {
    const src = vscode.Uri.joinPath(context.extensionUri, 'skills');
    const dst = vscode.Uri.file(path.join(os.homedir(), '.claude', 'skills'));

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(src);
    } catch {
      void vscode.window.showErrorMessage('Refiner: no bundled skills found in this build.');
      return;
    }
    const names = entries.filter(([, type]) => type === vscode.FileType.Directory).map(([n]) => n);
    if (names.length === 0) {
      void vscode.window.showErrorMessage('Refiner: no bundled skills found in this build.');
      return;
    }

    // Warn before clobbering anything already there (e.g. a dev symlink).
    const existing: string[] = [];
    const links: string[] = [];
    for (const name of names) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(dst, name));
        existing.push(name);
        if (stat.type & vscode.FileType.SymbolicLink) {
          links.push(name);
        }
      } catch {
        // not present — nothing to overwrite
      }
    }
    const detail =
      `Installs ${names.join(', ')} into ~/.claude/skills.` +
      (links.length ? ` ${links.join(', ')}: a symlink there is replaced by a copy; its target is not touched.` : '');
    const answer = await vscode.window.showWarningMessage(
      existing.length
        ? `Refiner: overwrite existing ${existing.join(', ')} in ~/.claude/skills?`
        : 'Refiner: install Claude Code skills?',
      { modal: true, detail },
      'Install',
    );
    if (answer !== 'Install') {
      return;
    }

    await vscode.workspace.fs.createDirectory(dst);
    for (const name of names) {
      const target = vscode.Uri.joinPath(dst, name);
      // Copying "through" a symlink would write into whatever repo it points at.
      if (links.includes(name)) {
        await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
      }
      await vscode.workspace.fs.copy(vscode.Uri.joinPath(src, name), target, { overwrite: true });
    }
    if (names.includes('refine-web')) {
      const scripts = vscode.Uri.joinPath(dst, 'refine-web', 'scripts');
      await vscode.workspace.fs.copy(vscode.Uri.joinPath(context.extensionUri, 'out', 'web'), scripts, {
        overwrite: true,
      });
      await vscode.workspace.fs.copy(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'overlay.js'),
        vscode.Uri.joinPath(scripts, 'overlay.js'),
        { overwrite: true },
      );
    }
    void vscode.window.showInformationMessage(
      `Refiner: installed ${names.join(', ')}. Restart Claude Code to pick them up.`,
    );
  }

  context.subscriptions.push(
    controller,
    store,
    webStore,
    browser,
    treeView,
    vscode.commands.registerCommand('refiner.createThread', createThread),
    vscode.commands.registerCommand('refiner.replyThread', replyThread),
    vscode.commands.registerCommand('refiner.resolveThread', resolveThread),
    vscode.commands.registerCommand('refiner.reopenThread', reopenThread),
    vscode.commands.registerCommand('refiner.deleteThread', deleteThread),
    vscode.commands.registerCommand('refiner.editComment', editComment),
    vscode.commands.registerCommand('refiner.saveComment', saveComment),
    vscode.commands.registerCommand('refiner.cancelEdit', cancelEdit),
    vscode.commands.registerCommand('refiner.deleteComment', deleteComment),
    vscode.commands.registerCommand('refiner.refresh', refresh),
    vscode.commands.registerCommand('refiner.reanchor', reanchor),
    vscode.commands.registerCommand('refiner.installSkills', installSkills),
    // The browser review session.
    vscode.commands.registerCommand('refiner.openWeb', () => browser.open()),
    vscode.commands.registerCommand('refiner.stopWeb', () => browser.stop()),
    vscode.commands.registerCommand('refiner.webSessionMenu', () => browser.menu()),
    // The UI Threads view.
    vscode.commands.registerCommand('refiner.ui.open', uiOpen),
    vscode.commands.registerCommand('refiner.ui.openSource', uiOpenSource),
    vscode.commands.registerCommand('refiner.ui.showInBrowser', uiShowInBrowser),
    vscode.commands.registerCommand('refiner.ui.openShot', uiOpenShot),
    vscode.commands.registerCommand('refiner.ui.reply', uiReply),
    vscode.commands.registerCommand('refiner.ui.resolve', (node?: UiNode) => uiSetStatus(node, 'resolved')),
    vscode.commands.registerCommand('refiner.ui.reopen', (node?: UiNode) => uiSetStatus(node, 'open')),
    vscode.commands.registerCommand('refiner.ui.delete', uiDelete),
    // Track code changes so bubbles follow the code they were written against.
    vscode.workspace.onDidOpenTextDocument((doc) => void reconcileDoc(doc.uri, true)),
    vscode.workspace.onDidSaveTextDocument((doc) => void reconcileDoc(doc.uri, true)),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleReconcile(e.document.uri)),
  );

  void refresh().then(() => {
    for (const doc of vscode.workspace.textDocuments) {
      void reconcileDoc(doc.uri, true);
    }
    updateBadge();
  });
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
