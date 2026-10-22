/**
 * The on-disk data model for Refiner. `.refiner/comments.json` (code threads) and
 * `.refiner/web-comments.json` (UI threads) share it; both are the contract between
 * the VSCode extension, the refiner TUI and Claude Code — keep it simple and
 * human-readable so it can be edited by any side.
 *
 * Line numbers are 1-based (matching the editor gutter) to stay friendly for humans
 * and for Claude Code reading the file.
 */

export type CommentRole = 'user' | 'assistant';
export type ThreadStatus = 'open' | 'resolved';

export interface StoredComment {
  id: string;
  /** Display name of who wrote the comment. */
  author: string;
  /** "user" = a human; "assistant" = Claude Code. Drives styling and permissions. */
  role: CommentRole;
  /** Markdown body of the comment. */
  body: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * A content snapshot used to keep a thread attached to its code as lines shift.
 * Managed automatically by the extension — external tools (Claude Code) can ignore
 * it; the extension backfills it from the current file when missing.
 */
export interface Anchor {
  /** Exact text of the anchored lines when captured. */
  lines: string[];
  /** Up to a few lines immediately above, for disambiguation. */
  before: string[];
  /** Up to a few lines immediately below, for disambiguation. */
  after: string[];
}

export interface StoredThread {
  id: string;
  /** Workspace-relative path, using forward slashes. */
  file: string;
  /** 1-based, inclusive line range the thread is anchored to. */
  range: { start: number; end: number };
  status: ThreadStatus;
  comments: StoredComment[];
  /** Content anchor for drift tracking. Optional; the extension fills it in. */
  anchor?: Anchor;
}

export interface StoreData {
  version: number;
  threads: StoredThread[];
}

// ---- UI threads (`.refiner/web-comments.json`) ---------------------------------
//
// Threads pinned to elements of a running web app live in a SEPARATE file with the
// same shape, shared with the refiner TUI's `refiner web` and the browser overlay.
// In it `file` is the page (a route with ids collapsed, e.g. `/users/:id/edit`),
// `range` is a `1–1` placeholder, and the real target is `web`.

/**
 * What the browser overlay records about an element. It is resolved again on
 * every page load (test id, id, text, classes, CSS path… vote for a candidate),
 * never rewritten — a corrected guess would only drift further next time.
 */
export interface WebAnchor {
  tag: string;
  id: string;
  testid: string;
  role: string;
  name: string;
  text: string;
  classes: string[];
  css: string;
  path: string;
  /** Document coordinates at capture time. */
  rect: { x: number; y: number; w: number; h: number };
  /** Where inside the element the reviewer clicked, as fractions. The pin goes there. */
  at: { fx: number; fy: number };
}

/** Where the element comes from, as far as the framework's dev-mode internals say. */
export interface WebSource {
  framework?: string;
  component?: string;
  /** Repo-relative path. */
  file?: string;
  line?: number;
  /** Angular: the component's external template as `path:line`, when it has one. */
  template?: string;
}

/** The `web` field of a UI thread. */
export interface WebTarget {
  url: string;
  page: string;
  title: string;
  viewport: { w: number; h: number };
  anchor: WebAnchor;
  source?: WebSource;
  /** Repo-relative PNG of the element as the reviewer saw it. */
  shot?: string;
}

export type WebThread = StoredThread & { web: WebTarget };

export function isWebThread(t: StoredThread): t is WebThread {
  const w = (t as { web?: unknown }).web;
  return typeof w === 'object' && w !== null && typeof (w as WebTarget).page === 'string';
}
