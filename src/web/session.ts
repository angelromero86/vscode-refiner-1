/**
 * A UI review session: a Chrome the reviewer drives, with review threads on top.
 *
 * No browser extension. We launch Chrome with a debugging port and a profile of
 * its own (`chrome.ts`), and over CDP:
 *
 *   - every page target is auto-attached PAUSED (`waitForDebuggerOnStart`), so
 *     the overlay is registered before the page runs its first script, in every
 *     tab the reviewer opens;
 *   - `overlay.js` is injected with `addScriptToEvaluateOnNewDocument` into an
 *     isolated world — it survives every navigation, full loads and SPA route
 *     changes alike, the page cannot see it, and the page's CSP does not apply;
 *   - the overlay talks back through `Runtime.addBinding` scoped to that world,
 *     and we answer by evaluating `__refinerRecv(...)` in the context the call
 *     came from.
 *
 * The threads live in `.refiner/web-comments.json`, in the same shape as
 * `comments.json`, so `/refine-resolve` reads both with one set of rules. They
 * are a SEPARATE file because `comments.json` is a contract in which every
 * thread is `file` + line `range`; a thread anchored to a DOM element is
 * neither. Here `file` is the page key (`page.ts`), `range` a placeholder, and
 * the real target is the `web` object (`WebTarget` in `types.ts`).
 *
 * The overlay is a view and never the source of truth: it sends intents, we
 * mutate the store, and broadcast the state back to every open tab. One queue
 * (`chain`) serializes mutations — two of them interleaving lose one.
 *
 * This module knows nothing about VSCode: the store comes in through the
 * `WebStore` interface (the extension's `RefinerStore` implements it), which is
 * what lets `cli.ts` and the tests run it under plain Node.
 */

import { readFileSync } from 'fs';
import { access, mkdir, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { CDP, Json } from './cdp';
import { Browser, launchChrome, profileDir, runningEndpoint, sleep } from './chrome';
import { pageKey } from './page';
import { locateSource, ProbeResult, SOURCE_PROBE } from './source';
import {
  isWebThread,
  StoredComment,
  StoredThread,
  ThreadStatus,
  WebAnchor,
  WebTarget,
  WebThread,
} from '../types';

export const WEB_STORE_REL = '.refiner/web-comments.json';
export const SHOTS_REL = '.refiner/shots';

let overlaySource: string | undefined;

/**
 * `overlay.js` is browser code tsc must not re-emit, so it ships outside `out/`:
 * under `media/` in the extension, and next to this file once "Install Claude
 * Code Skills" has copied the web scripts into the skill's directory.
 */
function readOverlay(): string {
  const candidates = [join(__dirname, 'overlay.js'), join(__dirname, '..', '..', 'media', 'overlay.js')];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      // try the next location
    }
  }
  throw new Error(`overlay.js not found (looked in ${candidates.join(', ')})`);
}

/** The overlay as an injectable script. `core` is the anchor resolver alone. */
export function overlayScript(mode: 'ui' | 'core'): string {
  overlaySource ??= readOverlay();
  return `${overlaySource}(${JSON.stringify(mode)});`;
}

/** What the session needs from a thread store. `RefinerStore` is one. */
export interface WebStore {
  readonly threads: StoredThread[];
  id(prefix: string): string;
  addThread(thread: StoredThread): Promise<void>;
  addComment(threadId: string, comment: StoredComment): Promise<void>;
  setStatus(threadId: string, status: ThreadStatus): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  /** Fires on every change, our own writes included. */
  onDidChange(listener: () => void): { dispose(): void };
}

/** What the overlay sends through the `__refiner` binding. */
type Msg =
  | { type: 'hello'; href: string }
  | {
      type: 'create';
      req: number;
      href: string;
      title: string;
      viewport: { w: number; h: number };
      anchor: WebAnchor;
      pick: string;
      body: string;
    }
  | { type: 'reply'; req: number; threadId: string; body: string }
  | { type: 'status'; req: number; threadId: string; status: ThreadStatus }
  | { type: 'delete'; req: number; threadId: string }
  | { type: 'goto'; req: number; threadId: string };

interface Tab {
  sessionId: string;
  /** The overlay's execution context, learned from its first binding call. */
  ctx: number | null;
  href: string;
  /** A thread to open once the overlay on the next page says hello. */
  focus: string | null;
}

export interface SessionOptions {
  /** Repo root: where `.refiner/` lives and what `web.source` paths are relative to. */
  root: string;
  url: string;
  author: string;
  store: WebStore;
  headless?: boolean;
  /** Browser binary; defaults to `REFINER_CHROME` or the usual install paths. */
  chromePath?: string;
  /** Defaults to the per-repo profile under ~/.config/refiner/chrome. */
  profile?: string;
  log?: (line: string) => void;
}

export class WebSession {
  readonly store: WebStore;
  readonly url: string;
  readonly tabs = new Map<string, Tab>();
  private cdp!: CDP;
  private browser!: Browser;
  private chain: Promise<unknown> = Promise.resolve();
  private storeSub: { dispose(): void } | null = null;
  /** thread id → comment count at the last look, to say who replied. */
  private known = new Map<string, number>();
  private firstTab!: Promise<string>;
  private closing = false;
  /** Resolves when the browser goes away — the window closed, or `close()`. */
  done!: Promise<void>;

  private constructor(private readonly opts: SessionOptions) {
    this.store = opts.store;
    this.url = opts.url;
  }

  static async start(opts: SessionOptions): Promise<WebSession> {
    const s = new WebSession(opts);
    await s.boot();
    return s;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private async boot(): Promise<void> {
    const profile = this.opts.profile ?? profileDir(this.opts.root);
    if (await runningEndpoint(profile)) {
      throw new Error(
        'a browser review session is already running for this repo (from this window or the refiner CLI); close that Chrome window first',
      );
    }
    this.browser = await launchChrome(profile, { headless: this.opts.headless, chromePath: this.opts.chromePath });
    try {
      this.cdp = await CDP.connect(this.browser.wsUrl);
    } catch (err) {
      this.browser.proc.kill();
      throw err;
    }
    this.done = new Promise((resolve) => {
      this.cdp.onClosed(resolve);
      void this.browser.exited.then(resolve);
    });
    void this.done.then(() => this.shutdown());

    let firstResolve!: (s: string) => void;
    this.firstTab = new Promise((r) => (firstResolve = r));
    this.cdp.on('Target.attachedToTarget', (p) => {
      void this.attach(p).then((ok) => {
        if (ok) {
          firstResolve(p.sessionId);
        }
      });
    });
    this.cdp.on('Target.detachedFromTarget', (p) => this.tabs.delete(p.sessionId));
    this.cdp.on('Runtime.bindingCalled', (p, sessionId) => {
      if (p.name !== '__refiner' || !sessionId) {
        return;
      }
      this.onBinding(sessionId, p.executionContextId, p.payload);
    });
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    const sid = await Promise.race([
      this.firstTab,
      sleep(15_000).then(() => {
        throw new Error('Chrome opened no page to review in');
      }),
    ]);
    await this.cdp.send('Page.navigate', { url: this.opts.url }, sid);
    // Chrome's own windows are not where the reviewer works.
    await this.cdp.send('Page.bringToFront', {}, sid).catch(() => undefined);

    this.snapshotKnown();
    // Writes by agents (`/refine-resolve`) and by the editor reach the open
    // pages through the store's own watcher; we only have to push them.
    this.storeSub = this.store.onDidChange(() => void this.enqueue(() => this.broadcast()));
  }

  /** Set a freshly attached target up, then let it run. True for a page. */
  private async attach(p: Json): Promise<boolean> {
    const sid: string = p.sessionId;
    const resume = () => this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => undefined);
    if (p.targetInfo.type !== 'page') {
      await resume();
      return false;
    }
    this.tabs.set(sid, { sessionId: sid, ctx: null, href: p.targetInfo.url, focus: null });
    try {
      await this.cdp.send('Page.enable', {}, sid);
      await this.cdp.send('Runtime.enable', {}, sid);
      await this.cdp.send('Runtime.addBinding', { name: '__refiner', executionContextName: 'refiner' }, sid);
      await this.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: overlayScript('ui'), worldName: 'refiner', runImmediately: true },
        sid,
      );
    } catch (err) {
      this.log(`! could not instrument a tab: ${(err as Error).message}`);
    }
    await resume();
    return true;
  }

  /** Run `fn` after everything queued before it. A failure never jams the queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private onBinding(sessionId: string, ctx: number, payload: string): void {
    const tab = this.tabs.get(sessionId);
    if (!tab) {
      return;
    }
    tab.ctx = ctx;
    let msg: Msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      tab.href = msg.href;
      const page = pageKey(msg.href);
      let focus: string | null = null;
      if (tab.focus) {
        const t = this.store.threads.find((x) => x.id === tab.focus);
        if (t && isWebThread(t) && t.web.page === page) {
          focus = t.id;
        }
        tab.focus = null;
      }
      void this.push(tab, this.stateFor(tab, focus));
      return;
    }
    void this.enqueue(() => this.mutate(tab, msg)).catch(() => undefined);
  }

  private async mutate(tab: Tab, msg: Exclude<Msg, { type: 'hello' }>): Promise<void> {
    const kind = msg.type;
    try {
      let id: string | undefined;
      switch (msg.type) {
        case 'create':
          id = await this.create(tab, msg);
          break;
        case 'reply':
          this.threadOrThrow(msg.threadId);
          await this.store.addComment(msg.threadId, this.comment(msg.body));
          this.log(`↩ reply on ${msg.threadId}`);
          break;
        case 'status':
          this.threadOrThrow(msg.threadId);
          await this.store.setStatus(msg.threadId, msg.status);
          this.log(`${msg.status === 'resolved' ? '✓ resolved' : '↺ reopened'} ${msg.threadId}`);
          break;
        case 'delete':
          this.threadOrThrow(msg.threadId);
          await this.store.deleteThread(msg.threadId);
          this.log(`✕ deleted ${msg.threadId}`);
          break;
        case 'goto':
          // The navigation kills the context an ack would go to; the next
          // page's hello carries the focus instead.
          await this.show(this.threadOrThrow(msg.threadId), tab);
          return;
      }
      this.snapshotKnown();
      // State before the ack: the overlay opens the new thread's card on the
      // ack, and a card for a thread it has not been told about yet is nothing.
      await this.broadcast();
      await this.push(tab, { type: 'ack', kind, req: msg.req, ok: true, id });
    } catch (err) {
      await this.push(tab, { type: 'ack', kind, req: msg.req, ok: false, error: (err as Error).message });
    }
  }

  private threadOrThrow(id: string): WebThread {
    const t = this.store.threads.find((x) => x.id === id);
    if (!t || !isWebThread(t)) {
      throw new Error(`thread ${id} not found`);
    }
    return t;
  }

  private comment(body: string): StoredComment {
    return {
      id: this.store.id('c'),
      author: this.opts.author,
      role: 'user',
      body,
      createdAt: new Date().toISOString(),
    };
  }

  private async create(tab: Tab, msg: Extract<Msg, { type: 'create' }>): Promise<string> {
    const pick = msg.pick.replace(/[^a-z0-9]/gi, '');
    const page = pageKey(msg.href);

    // Main world: the frameworks' debug hooks are only visible from there.
    let probe: ProbeResult | null = null;
    try {
      const r = await this.cdp.send(
        'Runtime.evaluate',
        { expression: SOURCE_PROBE.replace('__PICK__', pick), returnByValue: true },
        tab.sessionId,
      );
      probe = r.result?.value ?? null;
    } catch {
      // A page mid-navigation has no main world to ask; the thread goes without.
    }
    const source = await locateSource(this.opts.root, probe, msg.anchor.text);
    const shot = await this.capture(tab, msg.anchor.rect, pick);

    const web: WebTarget = {
      url: msg.href,
      page,
      title: msg.title,
      viewport: msg.viewport,
      anchor: msg.anchor,
    };
    if (source) {
      web.source = source;
    }
    if (shot) {
      web.shot = shot;
    }
    const thread: WebThread = {
      id: this.store.id('t'),
      file: page,
      range: { start: 1, end: 1 },
      status: 'open',
      comments: [this.comment(msg.body)],
      web,
    };
    await this.store.addThread(thread);
    const where = source?.template ?? (source?.file ? `${source.file}${source.line ? ':' + source.line : ''}` : '');
    this.log(
      `＋ ${thread.id} on ${page}  <${msg.anchor.tag}>${source?.component ? `  ${source.component}` : ''}${where ? `  ${where}` : ''}`,
    );
    return thread.id;
  }

  /**
   * A PNG of the element with some page around it, as the reviewer saw it —
   * which is what lets an agent that cannot see the browser understand "this
   * is misaligned". Our own UI is hidden for the shot, except a dashed outline
   * around the element.
   */
  private async capture(tab: Tab, rect: WebAnchor['rect'], pick: string): Promise<string | undefined> {
    const PAD = 48;
    try {
      await this.push(tab, { type: 'shoot', on: true });
      await sleep(80);
      const r = await this.cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: {
            x: Math.max(0, rect.x - PAD),
            y: Math.max(0, rect.y - PAD),
            width: Math.max(1, rect.w + PAD * 2),
            height: Math.max(1, Math.min(rect.h + PAD * 2, 2400)),
            scale: 1,
          },
        },
        tab.sessionId,
      );
      const dir = join(this.opts.root, SHOTS_REL);
      await mkdir(dir, { recursive: true });
      // Pictures of somebody's local app are not source; keep them out of git.
      const ignore = join(dir, '.gitignore');
      await access(ignore).catch(() => writeFile(ignore, '*\n'));
      const name = `${Date.now().toString(36)}-${pick}.png`;
      const tmp = join(dir, `${name}.tmp`);
      await writeFile(tmp, Buffer.from(r.data, 'base64'));
      await rename(tmp, join(dir, name));
      return `${SHOTS_REL}/${name}`;
    } catch (err) {
      this.log(`! screenshot failed: ${(err as Error).message}`);
      return undefined;
    } finally {
      await this.push(tab, { type: 'shoot', on: false });
    }
  }

  private stateFor(tab: Tab, focus: string | null = null): object {
    return {
      type: 'state',
      author: this.opts.author,
      page: pageKey(tab.href),
      threads: this.store.threads.filter(isWebThread),
      readOnly: false,
      focus,
    };
  }

  private async push(tab: Tab, msg: object): Promise<void> {
    if (tab.ctx === null) {
      return;
    }
    try {
      await this.cdp.send(
        'Runtime.evaluate',
        { expression: `globalThis.__refinerRecv && __refinerRecv(${JSON.stringify(msg)})`, contextId: tab.ctx },
        tab.sessionId,
      );
    } catch {
      // The context died with a navigation; the next page's hello resyncs it.
    }
  }

  private async broadcast(): Promise<void> {
    this.noteChanges();
    await Promise.all(Array.from(this.tabs.values()).map((t) => this.push(t, this.stateFor(t))));
  }

  private snapshotKnown(): void {
    this.known = new Map(this.store.threads.filter(isWebThread).map((t) => [t.id, t.comments.length]));
  }

  /** Say what another writer — an agent, mostly — did since we last looked. */
  private noteChanges(): void {
    for (const t of this.store.threads) {
      if (!isWebThread(t)) {
        continue;
      }
      const n = this.known.get(t.id);
      const last = t.comments[t.comments.length - 1];
      if (n === undefined) {
        this.log(`＋ ${t.id} arrived from another writer`);
      } else if (t.comments.length > n && last?.role === 'assistant') {
        this.log(`✦ ${last.author} replied on ${t.id}`);
      }
    }
    this.snapshotKnown();
  }

  /** The tab to act on from the editor: one with a live overlay, else any. */
  private anyTab(): Tab | undefined {
    const tabs = Array.from(this.tabs.values());
    return tabs.find((t) => t.ctx !== null) ?? tabs[0];
  }

  /** Bring the thread's page up in the browser with its card open. */
  private async show(t: WebThread, tab: Tab): Promise<void> {
    if (tab.ctx !== null && pageKey(tab.href) === t.web.page) {
      await this.push(tab, this.stateFor(tab, t.id));
    } else {
      tab.focus = t.id;
      await this.cdp.send('Page.navigate', { url: t.web.url }, tab.sessionId);
    }
  }

  /** Editor → browser: open a thread's page and card, and raise the window. */
  async goto(threadId: string): Promise<void> {
    const t = this.threadOrThrow(threadId);
    const tab = this.anyTab();
    if (!tab) {
      throw new Error('the browser has no tab open');
    }
    await this.show(t, tab);
    await this.cdp.send('Page.bringToFront', {}, tab.sessionId).catch(() => undefined);
  }

  /** Raise the browser window. */
  async focus(): Promise<void> {
    const tab = this.anyTab();
    if (tab) {
      await this.cdp.send('Page.bringToFront', {}, tab.sessionId).catch(() => undefined);
    }
  }

  /** Test hook: evaluate in the overlay's world of the first tab that has one. */
  async evalOverlay<T = unknown>(expression: string): Promise<T> {
    for (const tab of this.tabs.values()) {
      if (tab.ctx === null) {
        continue;
      }
      const r = await this.cdp.send(
        'Runtime.evaluate',
        { expression, contextId: tab.ctx, returnByValue: true, awaitPromise: true },
        tab.sessionId,
      );
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
      }
      return r.result.value as T;
    }
    throw new Error('no overlay context yet');
  }

  /** Test hook: navigate the first tab. */
  async navigate(url: string): Promise<void> {
    const sid = await this.firstTab;
    const tab = this.tabs.get(sid);
    if (tab) {
      tab.ctx = null;
    }
    await this.cdp.send('Page.navigate', { url }, sid);
  }

  private shutdown(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.storeSub?.dispose();
    this.storeSub = null;
  }

  async close(): Promise<void> {
    this.shutdown();
    await this.chain.catch(() => undefined);
    try {
      await this.cdp.send('Browser.close');
    } catch {
      this.browser.proc.kill();
    }
    await this.done;
    this.cdp.close();
  }
}
