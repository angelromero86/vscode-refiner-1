/**
 * Finding and launching the browser a UI review session drives.
 *
 * Always with a profile of its own (`--user-data-dir`): since Chrome 136 the
 * remote-debugging switch is ignored on the default profile, by design. The
 * dedicated profile is persistent, so the reviewer logs into their app once and
 * stays logged in, and their everyday Chrome is never touched.
 *
 * The port is chosen by Chrome (`--remote-debugging-port=0`) and read back from
 * the `DevToolsActivePort` file it writes into the profile, so two sessions —
 * two repos — never fight over 9222. The same file is how `cli.js shot` (and the
 * refiner CLI's `refiner web shot`) finds a session that is already running.
 */

import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, rm } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** The browser binary: an explicit path wins, then `REFINER_CHROME`, then the usual install paths. */
export function findChrome(configured?: string): string {
  const explicit = configured?.trim() || process.env['REFINER_CHROME'];
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`the configured browser (${explicit}) does not exist`);
    }
    return explicit;
  }
  for (const p of CANDIDATES[process.platform] ?? []) {
    if (existsSync(p)) {
      return p;
    }
  }
  throw new Error('no Chrome/Chromium found; set refiner.chromePath (or REFINER_CHROME) to the browser binary');
}

/**
 * One profile per repo, outside the repo: a Chrome profile is hundreds of MB of
 * cache that has no business in a working tree, and per repo because two
 * projects usually mean two logins. Same path as the refiner CLI, so either
 * tool reuses the other's running Chrome.
 */
export function profileDir(repoRoot: string): string {
  const slug = repoRoot.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return join(homedir(), '.config', 'refiner', 'chrome', slug);
}

export interface Browser {
  wsUrl: string;
  proc: ChildProcess;
  /** Resolves when the process is gone, however it went. */
  exited: Promise<void>;
}

/** The endpoint of a Chrome already running on `profile`, or null. */
export async function runningEndpoint(profile: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  } catch {
    return null;
  }
  const [port, path] = text.trim().split('\n');
  if (!port || !path) {
    return null;
  }
  try {
    // The file outlives a crashed browser; only a live answer counts.
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      return null;
    }
    return `ws://127.0.0.1:${port}${path}`;
  } catch {
    return null;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function launchChrome(
  profile: string,
  opts: { headless?: boolean; chromePath?: string } = {},
): Promise<Browser> {
  const binary = findChrome(opts.chromePath);
  await mkdir(profile, { recursive: true });
  // A stale port file from a crashed session would be read back as ours.
  await rm(join(profile, 'DevToolsActivePort'), { force: true });
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    ...(opts.headless ? ['--headless=new', '--window-size=1280,900'] : []),
    'about:blank',
  ];
  const proc = spawn(binary, args, { stdio: 'ignore' });
  let spawnError: Error | null = null;
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    proc.on('error', (err) => {
      spawnError = err;
      resolve();
    });
    proc.on('exit', (code) => {
      exitCode = code ?? -1;
      resolve();
    });
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ws = await runningEndpoint(profile);
    if (ws) {
      return { wsUrl: ws, proc, exited };
    }
    if (spawnError) {
      throw new Error(`could not start ${binary}: ${(spawnError as Error).message}`);
    }
    if (exitCode !== null) {
      throw new Error(
        `Chrome exited (${exitCode}) before opening its debugging port — is another window using profile ${profile}?`,
      );
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error('Chrome did not open its debugging port within 15s');
}
