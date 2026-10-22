#!/usr/bin/env node
/**
 * The agent's half of the browser loop, as a plain Node script (no VSCode, no
 * Bun), run from the repo root:
 *
 *   node cli.js shot <thread-id>   screenshot a UI thread's element as it is NOW
 *   node cli.js list               the UI threads, one JSON line each
 *
 * `shot` is how `/refine-resolve` checks a fix with its own eyes: after the code
 * change it re-finds the element the reviewer pointed at and photographs it. It
 * reuses the reviewer's running Chrome when there is one (same cookies, same
 * session) and starts a headless one on the same profile otherwise.
 *
 * "Refiner: Install Claude Code Skills" copies this directory to
 * `~/.claude/skills/refine-web/scripts/`, which is where the skills call it.
 * The refiner CLI's `refiner web shot` does exactly the same thing.
 */

import { execFileSync } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { CDP, Json } from './cdp';
import { launchChrome, profileDir, runningEndpoint, sleep } from './chrome';
import { overlayScript, SHOTS_REL, WEB_STORE_REL } from './session';
import { isWebThread, StoreData, WebThread } from '../types';

const USAGE = `refiner web — the UI threads of this repo, for agents

usage:
  node cli.js shot <thread-id>   screenshot a UI thread's element as it is now
  node cli.js list               print the UI threads as JSON lines

threads: ${WEB_STORE_REL}   screenshots: ${SHOTS_REL}/
browser: REFINER_CHROME overrides which Chrome is launched
`;

async function loadThreads(root: string): Promise<WebThread[]> {
  let text: string;
  try {
    text = await readFile(join(root, WEB_STORE_REL), 'utf8');
  } catch {
    return [];
  }
  const data = JSON.parse(text) as Partial<StoreData>;
  return (Array.isArray(data.threads) ? data.threads : []).filter(isWebThread);
}

/** One summary object per UI thread, in file order. */
export async function listThreads(root: string): Promise<object[]> {
  return (await loadThreads(root)).map((t) => {
    const last = t.comments[t.comments.length - 1];
    return {
      id: t.id,
      status: t.status,
      page: t.web.page,
      url: t.web.url,
      element: `<${t.web.anchor.tag}>${t.web.anchor.text ? ` "${t.web.anchor.text.slice(0, 60)}"` : ''}`,
      source: t.web.source ?? null,
      shot: t.web.shot ?? null,
      comments: t.comments.length,
      lastRole: last?.role ?? null,
    };
  });
}

/** Matches the skills: a full id or a unique suffix. */
function findThread(threads: WebThread[], ref: string): WebThread {
  const exact = threads.find((t) => t.id === ref);
  if (exact) {
    return exact;
  }
  const hits = threads.filter((t) => ref !== '' && t.id.endsWith(ref));
  if (hits.length === 1) {
    return hits[0];
  }
  throw new Error(hits.length ? `"${ref}" matches ${hits.length} threads` : `no UI thread "${ref}"`);
}

export interface ShotResult {
  id: string;
  url: string;
  /** What the anchor resolver made of the page now: exact | moved | lost. */
  status: string;
  score: number;
  /** The element's text now, to compare with the anchor's. */
  text: string | null;
  /** Repo-relative PNG of the element now (the whole viewport when lost). */
  shot: string;
  /** The reviewer's original picture, if one was taken. */
  before: string | null;
  /** Why the page itself failed to load (dev server down, DNS…), if it did. */
  error?: string;
}

export async function shotThread(root: string, ref: string, profile = profileDir(root)): Promise<ShotResult> {
  if (!ref) {
    throw new Error('usage: cli.js shot <thread-id>');
  }
  const t = findThread(await loadThreads(root), ref);
  let ws = await runningEndpoint(profile);
  const launched = ws ? null : await launchChrome(profile, { headless: true });
  ws ??= launched?.wsUrl ?? '';
  const cdp = await CDP.connect(ws);
  let targetId = '';
  try {
    targetId = (await cdp.send('Target.createTarget', { url: 'about:blank', background: true })).targetId;
    const sid: string = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await cdp.send('Page.enable', {}, sid);
    // The reviewer's viewport, so a responsive layout breaks the same way.
    const vp = t.web.viewport ?? { w: 1280, h: 900 };
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false },
      sid,
    );
    const loaded = new Promise<void>((resolve) => {
      const off = cdp.on('Page.loadEventFired', (_p, s) => {
        if (s !== sid) {
          return;
        }
        off();
        resolve();
      });
    });
    const nav = await cdp.send('Page.navigate', { url: t.web.url }, sid);
    // `lost` alone would read as "your change removed the element".
    const navError: string | undefined = nav.errorText || undefined;
    await Promise.race([loaded, sleep(15_000)]);
    // SPAs render after `load`; give the app a moment to settle.
    await sleep(1200);

    // Main world, one shot: the resolver only reads the DOM. A running
    // session's overlay (if any) is in this tab too — hide it for the picture.
    const expr = `(() => {
      ${overlayScript('core')}
      const host = document.querySelector('refiner-overlay'); if (host) host.style.display = 'none'
      const r = globalThis.__refinerCore.resolve(${JSON.stringify(t.web.anchor)})
      if (!r.el) return { status: r.status, score: r.score }
      r.el.scrollIntoView({ block: 'center' })
      r.el.style.outline = '2px dashed #ff3d7f'
      r.el.style.outlineOffset = '2px'
      return { status: r.status, score: r.score, rect: globalThis.__refinerCore.docRect(r.el), text: (r.el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140) }
    })()`;
    const res = (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid)).result
      ?.value as {
      status: string;
      score: number;
      rect?: { x: number; y: number; w: number; h: number };
      text?: string;
    };
    await sleep(100);
    const PAD = 48;
    const params: Json = { format: 'png' };
    if (res?.rect) {
      params.captureBeyondViewport = true;
      params.clip = {
        x: Math.max(0, res.rect.x - PAD),
        y: Math.max(0, res.rect.y - PAD),
        width: Math.max(1, res.rect.w + PAD * 2),
        height: Math.max(1, Math.min(res.rect.h + PAD * 2, 2400)),
        scale: 1,
      };
    }
    const png = (await cdp.send('Page.captureScreenshot', params, sid)).data as string;
    await mkdir(join(root, SHOTS_REL), { recursive: true });
    const out = `${SHOTS_REL}/${t.id}-now.png`;
    await writeFile(join(root, out), Buffer.from(png, 'base64'));
    return {
      id: t.id,
      url: t.web.url,
      status: res?.status ?? 'lost',
      score: Math.round((res?.score ?? 0) * 100) / 100,
      text: res?.text ?? null,
      shot: out,
      before: t.web.shot ?? null,
      ...(navError ? { error: `page did not load: ${navError}` } : {}),
    };
  } finally {
    if (targetId) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    if (launched) {
      await cdp.send('Browser.close').catch(() => launched.proc.kill());
      await launched.exited;
    }
    cdp.close();
  }
}

/** The repo root, like the refiner CLI: git's toplevel, else the cwd. */
function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

async function main(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  const root = repoRoot();
  if (cmd === 'shot') {
    process.stdout.write(JSON.stringify(await shotThread(root, rest[0] ?? '')) + '\n');
    return;
  }
  if (cmd === 'list') {
    for (const line of await listThreads(root)) {
      process.stdout.write(JSON.stringify(line) + '\n');
    }
    return;
  }
  throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
