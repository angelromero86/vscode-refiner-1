/**
 * From "the element the reviewer clicked" to "the file an agent should open".
 *
 * Half of it runs in the page's MAIN world (`SOURCE_PROBE`), because that is
 * where the frameworks keep their bookkeeping: Angular's `ng` debug API, React
 * fibers, Vue's component instance, Svelte's `__svelte_meta`, and the `data-*`
 * attributes that inspector plugins stamp on elements. All of it only exists in
 * development builds — in production the probe finds nothing and the thread
 * simply carries no `source`, which is a missing hint, never a wrong one.
 *
 * The other half (`locateSource`) turns what the probe found into a
 * repo-relative path: directly when the framework knows the file, otherwise by
 * asking `git grep` where the component's class is declared — git, not a walk
 * of the tree, so `.gitignore` decides what is source.
 */

import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative } from 'path';
import { WebSource } from '../types';

export interface ProbeResult {
  framework?: 'angular' | 'react' | 'vue' | 'svelte';
  component?: string;
  /** The host element's selector, for Angular. */
  selector?: string;
  file?: string;
  line?: number;
  /** A `file:line[:col]` from an inspector attribute, and which attribute. */
  hint?: string;
  via?: string;
}

/**
 * Evaluated in the main world with `__PICK__` replaced by the token the overlay
 * stamped on the element. Returns a `ProbeResult` or null. Self-contained and
 * defensive: it runs inside somebody else's app.
 */
export const SOURCE_PROBE = `(() => {
  const el = document.querySelector('[data-refiner-pick="__PICK__"]')
  if (!el) return null
  const out = {}
  const ATTRS = ['data-insp-path', 'data-inspector-relative-path', 'data-source', 'data-source-file', 'data-component-file', 'data-sentry-source-file']
  outer: for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    for (const a of ATTRS) {
      const v = n.getAttribute(a)
      if (v) { out.hint = v; out.via = a; const ln = n.getAttribute('data-inspector-line'); if (ln) out.hint += ':' + ln; break outer }
    }
  }
  try {
    if (window.ng && typeof ng.getOwningComponent === 'function') {
      const own = ng.getOwningComponent(el)
      const c = own || ng.getComponent(el)
      if (c) {
        out.framework = 'angular'
        out.component = c.constructor && c.constructor.name
        const h = ng.getHostElement && ng.getHostElement(c)
        if (h) out.selector = h.tagName.toLowerCase()
      }
    }
  } catch (e) {}
  if (!out.framework) {
    try {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
      for (let f = key ? el[key] : null; f; f = f.return) {
        const t = f.type
        if (!t || typeof t === 'string') continue
        const name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name))
        if (!name) continue
        out.framework = 'react'
        out.component = name
        const s = f._debugSource
        if (s) { out.file = s.fileName; out.line = s.lineNumber }
        break
      }
    } catch (e) {}
  }
  if (!out.framework) {
    try {
      let n = el
      while (n && !n.__vueParentComponent) n = n.parentElement
      if (n) {
        const t = n.__vueParentComponent.type
        out.framework = 'vue'
        out.component = t.name || t.__name
        if (t.__file) out.file = t.__file
      }
    } catch (e) {}
  }
  if (!out.framework) {
    try {
      for (let n = el; n; n = n.parentElement) {
        const m = n.__svelte_meta
        if (m && m.loc) { out.framework = 'svelte'; out.file = m.loc.file; out.line = m.loc.line + 1; break }
      }
    } catch (e) {}
  }
  return out
})()`;

/** `git <args>` in `root`; stdout, or '' when git has nothing (no match is exit 1). */
function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

/** A path the probe reported, made repo-relative — or null if it is not ours. */
function inRepo(root: string, file: string): string | null {
  let f = file
    .replace(/^file:\/\//, '')
    .replace(/^webpack:\/\/\/?(\.\/)?/, '')
    .replace(/[?#].*$/, '');
  if (isAbsolute(f)) {
    const rel = relative(root, f);
    if (rel.startsWith('..')) {
      return null;
    }
    f = rel;
  }
  return f.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** `src/a.vue:12:3` → { file, line } */
function parseHint(hint: string): { file: string; line?: number } {
  const m = hint.match(/^(.*?):(\d+)(?::\d+)?$/);
  return m ? { file: m[1], line: Number(m[2]) } : { file: hint };
}

/** Where `class Name` / `function Name` / `const Name =` is declared. */
async function grepDeclaration(root: string, name: string): Promise<{ file: string; line: number } | null> {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return null;
  }
  const out = await git(root, [
    'grep',
    '-n',
    '-E',
    '--untracked',
    // POSIX classes, not `\s`/`\b`: git's ERE is the platform's, and macOS's
    // libc matches neither — the grep just comes back empty.
    `(class|function|interface)[[:space:]]+${name}([^A-Za-z0-9_$]|$)|(const|let|var)[[:space:]]+${name}[[:space:]]*[=:]`,
    '--',
    '*.ts',
    '*.tsx',
    '*.js',
    '*.jsx',
    '*.mjs',
    '*.vue',
    '*.svelte',
  ]);
  const hits = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(.*?):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null;
    })
    .filter((h): h is { file: string; line: number; text: string } => h !== null)
    // Tests and stories declare look-alikes; the real one is what an agent wants.
    .sort((a, b) => rank(a) - rank(b));
  return hits[0] ? { file: hits[0].file, line: hits[0].line } : null;
}

function rank(h: { file: string; text: string }): number {
  let r = 0;
  if (/\.(spec|test|stories)\.|__tests__|\/e2e\//.test(h.file)) {
    r += 10;
  }
  if (/^\s*(export\s+)?(default\s+)?class\b/.test(h.text)) {
    r -= 1;
  }
  return r;
}

/**
 * Angular components with `templateUrl` keep their markup in a sibling file —
 * which is the one an agent changes for a layout comment.
 */
async function angularTemplate(root: string, file: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(root, file), 'utf8');
    const m = text.match(/templateUrl\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!m) {
      return undefined;
    }
    return join(dirname(file), m[1]).replace(/\\/g, '/');
  } catch {
    return undefined;
  }
}

/** First line of `file` containing `needle`, to point at the element's own markup. */
async function lineOf(root: string, file: string, needle: string): Promise<number | undefined> {
  if (needle.length < 3) {
    return undefined;
  }
  try {
    const lines = (await readFile(join(root, file), 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes(needle));
    return i >= 0 ? i + 1 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a probe into a source location. Never throws: a thread without a
 * source is still a perfectly good thread.
 *
 * `text` is the element's own text (from the anchor); when the source is a
 * template it narrows the line down to the element itself.
 */
export async function locateSource(
  root: string,
  probe: ProbeResult | null,
  text: string,
): Promise<WebSource | undefined> {
  if (!probe) {
    return undefined;
  }
  try {
    const out: WebSource = {};
    if (probe.framework) {
      out.framework = probe.framework;
    }
    if (probe.component) {
      out.component = probe.component;
    }
    const direct = probe.hint
      ? parseHint(probe.hint)
      : probe.file
        ? { file: probe.file, line: probe.line }
        : null;
    if (direct) {
      const f = inRepo(root, direct.file);
      if (f) {
        out.file = f;
        if (direct.line) {
          out.line = direct.line;
        }
      }
    }
    if (!out.file && probe.component) {
      const hit = await grepDeclaration(root, probe.component);
      if (hit) {
        out.file = hit.file;
        out.line = hit.line;
      }
    }
    if (out.file && probe.framework === 'angular') {
      const tpl = await angularTemplate(root, out.file);
      if (tpl) {
        const ln = await lineOf(root, tpl, text.split(' ').slice(0, 4).join(' '));
        out.template = ln ? `${tpl}:${ln}` : tpl;
      }
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The editor location a UI thread's source points at: the Angular template
 * (with the element's line) when there is one, else the component file.
 */
export function sourceLocation(source: WebSource | undefined): { file: string; line?: number } | undefined {
  if (!source) {
    return undefined;
  }
  if (source.template) {
    const m = source.template.match(/^(.*?)(?::(\d+))?$/);
    if (m) {
      return { file: m[1], line: m[2] ? Number(m[2]) : undefined };
    }
  }
  return source.file ? { file: source.file, line: source.line } : undefined;
}
