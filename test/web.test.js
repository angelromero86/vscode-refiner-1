'use strict';
/**
 * The browser engine (`src/web/`) under plain Node, ported from the refiner
 * TUI's `test/web.test.ts`: the page key (pure), source location (git + fs),
 * and the whole loop against a real headless Chrome — inject, create, survive
 * a navigation, re-find a moved element, pick up an agent's reply from disk,
 * and photograph the element again.
 *
 * The browser half is skipped when no Chrome is installed, never faked: the
 * point of those tests is CDP's actual behaviour (isolated worlds, bindings
 * scoped to them, scripts that outlive navigations), and a mock would only pin
 * our assumptions about it.
 *
 * `npm test` compiles first; these load `../out`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { normalizeUrl, pageKey } = require('../out/web/page');
const { findChrome } = require('../out/web/chrome');
const { locateSource, sourceLocation } = require('../out/web/source');
const { WebSession, WEB_STORE_REL } = require('../out/web/session');
const { shotThread } = require('../out/web/cli');
const { isWebThread } = require('../out/types');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRepo = async (prefix) => {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};

describe('pageKey', () => {
  it('collapses ids, keeps words, drops host and query', () => {
    assert.equal(pageKey('http://localhost:4200/users/42/edit?tab=2'), '/users/:id/edit');
    assert.equal(pageKey('https://staging.example.com/users/42/edit'), '/users/:id/edit');
    assert.equal(pageKey('http://x/o/3f2b1c9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'), '/o/:id');
    assert.equal(pageKey('http://x/p/507f1f77bcf86cd799439011'), '/p/:id');
    assert.equal(pageKey('http://x/settings/'), '/settings');
    assert.equal(pageKey('http://x/'), '/');
  });
  it('hash routing is the route', () => {
    assert.equal(pageKey('http://x/index.html#/cart/9'), '/cart/:id');
    assert.equal(pageKey('http://x/#!/cart'), '/cart');
    // An in-page anchor is not a route.
    assert.equal(pageKey('http://x/docs#install'), '/docs');
  });
  it('normalizeUrl', () => {
    assert.equal(normalizeUrl('localhost:4200'), 'http://localhost:4200');
    assert.equal(normalizeUrl(' 127.0.0.1:3000/x '), 'http://127.0.0.1:3000/x');
    assert.equal(normalizeUrl('example.com'), 'https://example.com');
    assert.equal(normalizeUrl('http://a.test/'), 'http://a.test/');
  });
  it('sourceLocation prefers the template line', () => {
    assert.deepEqual(sourceLocation({ file: 'a.ts', line: 3, template: 'a.html:41' }), { file: 'a.html', line: 41 });
    assert.deepEqual(sourceLocation({ file: 'a.ts', line: 3, template: 'a.html' }), { file: 'a.html', line: undefined });
    assert.deepEqual(sourceLocation({ file: 'a.tsx', line: 7 }), { file: 'a.tsx', line: 7 });
    assert.equal(sourceLocation({ component: 'Nope' }), undefined);
    assert.equal(sourceLocation(undefined), undefined);
  });
});

describe('locateSource', () => {
  let repo = '';
  before(async () => {
    repo = await tmpRepo('refiner-src-');
    await fsp.mkdir(path.join(repo, 'src/app/settings'), { recursive: true });
    await fsp.writeFile(
      path.join(repo, 'src/app/settings/settings-form.component.ts'),
      "@Component({\n  selector: 'app-settings-form',\n  templateUrl: './settings-form.component.html',\n})\nexport class SettingsFormComponent {}\n",
    );
    await fsp.writeFile(
      path.join(repo, 'src/app/settings/settings-form.component.html'),
      '<form>\n  <h2>Profile</h2>\n  <button data-testid="save">Save changes</button>\n</form>\n',
    );
    await fsp.writeFile(path.join(repo, 'src/app/settings/settings-form.component.spec.ts'), 'class SettingsFormComponent {}\n');
  });
  after(() => fsp.rm(repo, { recursive: true, force: true }));

  it('angular: class by git grep (not the spec), template line by the element text', async () => {
    const s = await locateSource(repo, { framework: 'angular', component: 'SettingsFormComponent' }, 'Save changes');
    assert.deepEqual(s, {
      framework: 'angular',
      component: 'SettingsFormComponent',
      file: 'src/app/settings/settings-form.component.ts',
      line: 5,
      template: 'src/app/settings/settings-form.component.html:3',
    });
  });
  it('an inspector attribute wins, made repo-relative', async () => {
    const s = await locateSource(repo, { hint: `${repo}/src/x.vue:12:3`, via: 'data-insp-path' }, '');
    assert.deepEqual(s, { file: 'src/x.vue', line: 12 });
  });
  it('a file outside the repo is no hint at all', async () => {
    const s = await locateSource(repo, { file: '/elsewhere/a.tsx', framework: 'react', component: 'Nope' }, '');
    assert.deepEqual(s, { framework: 'react', component: 'Nope' });
  });
});

/**
 * The simplest `WebStore`: the whole file, rewritten on every change, reloaded
 * when somebody else writes it — what the extension's RefinerStore does, minus
 * VSCode.
 */
class FileStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, threads: [] };
    this.seq = 0;
    this.lastWritten = '';
    this.listeners = new Set();
    this.watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name === path.basename(file)) {
        this.reload();
      }
    });
  }
  get threads() {
    return this.data.threads;
  }
  id(prefix) {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq.toString(36)}`;
  }
  onDidChange(fn) {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }
  fire() {
    for (const fn of this.listeners) {
      fn();
    }
  }
  reload() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    if (text === this.lastWritten) {
      return;
    }
    try {
      this.data = JSON.parse(text);
    } catch {
      return;
    }
    this.lastWritten = text;
    this.fire();
  }
  async persist() {
    const text = JSON.stringify(this.data, null, 2) + '\n';
    this.lastWritten = text;
    await fsp.writeFile(this.file, text);
    this.fire();
  }
  addThread(t) {
    this.data.threads.push(t);
    return this.persist();
  }
  addComment(id, c) {
    this.data.threads.find((t) => t.id === id).comments.push(c);
    return this.persist();
  }
  setStatus(id, status) {
    this.data.threads.find((t) => t.id === id).status = status;
    return this.persist();
  }
  deleteThread(id) {
    this.data.threads = this.data.threads.filter((t) => t.id !== id);
    return this.persist();
  }
  dispose() {
    this.watcher.close();
  }
}

let chrome = '';
try {
  chrome = findChrome();
} catch {
  chrome = '';
}

describe('a review session against headless Chrome', { skip: !chrome && 'no Chrome installed' }, () => {
  let repo = '';
  let store;
  let session;
  let server;
  let port = 0;
  const slow = { timeout: 30_000 };

  // `/items/:id` renders a toolbar; `?v=2` re-renders it the way a refactor
  // would — an extra wrapper and a reshuffled class list — so the CSS path
  // recorded at creation no longer matches but the test id and text still do.
  // The CSP forbids every script: the overlay must not care.
  const html = (p, v2) => `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<title>Items</title></head><body style="margin:0;font:16px sans-serif">
<h1>Item ${p}</h1>
${v2 ? '<div class="wrap"><section>' : '<section>'}
  <button class="btn primary" data-testid="save">Save changes</button>
  <button class="btn">Cancel</button>
${v2 ? '</section></div>' : '</section>'}
<a id="next" href="/items/7">next</a>
</body></html>`;

  // Angular's dev-mode debug API, as far as the probe uses it — in the MAIN
  // world, which is the whole point: the overlay cannot see it.
  const ngHtml = `<!doctype html><body><app-settings-form><button>Save changes</button></app-settings-form>
<script>
  class SettingsFormComponent {}
  window.ng = {
    getOwningComponent: () => new SettingsFormComponent(),
    getComponent: () => null,
    getHostElement: () => document.querySelector('app-settings-form'),
  }
</script></body>`;

  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) {
          return v;
        }
      } catch (e) {
        last = e;
      }
      await sleep(100);
    }
    throw new Error(`timed out${last ? `: ${last.message}` : ''}`);
  };
  const state = () => session.evalOverlay('__refinerApi.state()');
  const readStore = async () => JSON.parse(await fsp.readFile(path.join(repo, WEB_STORE_REL), 'utf8'));
  const url = (p) => `http://127.0.0.1:${port}${p}`;

  before(async () => {
    repo = await tmpRepo('refiner-web-');
    await fsp.mkdir(path.join(repo, '.refiner'), { recursive: true });
    await fsp.mkdir(path.join(repo, 'src/settings'), { recursive: true });
    await fsp.writeFile(
      path.join(repo, 'src/settings/settings-form.component.ts'),
      "@Component({ selector: 'app-settings-form', templateUrl: './settings-form.component.html' })\nexport class SettingsFormComponent {}\n",
    );
    await fsp.writeFile(path.join(repo, 'src/settings/settings-form.component.html'), '<h2>Profile</h2>\n<button>Save changes</button>\n');
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      res.setHeader('content-type', 'text/html');
      res.end(u.pathname === '/ng' ? ngHtml : html(u.pathname, u.searchParams.get('v') === '2'));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    store = new FileStore(path.join(repo, WEB_STORE_REL));
    session = await WebSession.start({
      root: repo,
      url: url('/items/42'),
      author: 'tester',
      store,
      headless: true,
      profile: path.join(repo, '.chrome'),
    });
  }, { timeout: 40_000 });

  after(async () => {
    await session?.close();
    store?.dispose();
    server?.close();
    // Chrome's helper processes may still be flushing the profile for a moment.
    await fsp.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('creating a thread writes the store, with a fingerprint and a screenshot', slow, async () => {
    await until(async () => (await state()).page === '/items/:id');
    await session.evalOverlay(`__refinerApi.create('[data-testid=save]', 'make this **blue**')`);
    const data = await until(async () => {
      const d = await readStore();
      return d.threads.length === 1 && d;
    });
    const t = data.threads[0];
    assert.equal(isWebThread(t), true);
    assert.equal(t.file, '/items/:id');
    assert.equal(t.status, 'open');
    assert.deepEqual(t.range, { start: 1, end: 1 });
    assert.equal(t.comments.length, 1);
    assert.deepEqual([t.comments[0].author, t.comments[0].role, t.comments[0].body], ['tester', 'user', 'make this **blue**']);
    assert.equal(t.web.page, '/items/:id');
    assert.equal(t.web.url, url('/items/42'));
    assert.deepEqual([t.web.anchor.tag, t.web.anchor.testid, t.web.anchor.text], ['button', 'save', 'Save changes']);
    assert.match(t.web.shot, /^\.refiner\/shots\/.+\.png$/);
    const png = await fsp.readFile(path.join(repo, t.web.shot));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    // Pictures stay out of git.
    assert.equal(await fsp.readFile(path.join(repo, '.refiner/shots/.gitignore'), 'utf8'), '*\n');
    // The pick token is cleaned off the reviewer's DOM.
    assert.equal(await session.evalOverlay(`!!document.querySelector('[data-refiner-pick]')`), false);
    assert.equal((await state()).pins, 1);
  });

  it('the thread follows to another item of the same page, exactly', slow, async () => {
    await session.navigate(url('/items/7'));
    const s = await until(async () => {
      const s = await state();
      return s.threads[0]?.drift && s.pins === 1 && s;
    });
    assert.equal(s.page, '/items/:id');
    assert.equal(s.threads[0].drift, 'exact');
  });

  it('a refactored DOM: a test id still pins exactly, a bare element is re-found as moved', slow, async () => {
    // Cancel has no id and no test id: only its text, its classes and where it
    // sat in the tree identify it — and the refactor below moves it in the tree.
    await session.evalOverlay(`__refinerApi.create('section > button:nth-of-type(2)', 'wrong label')`);
    await until(async () => (await readStore()).threads.length === 2);
    await until(async () => (await state()).pins === 2);

    await session.navigate(url('/items/7?v=2'));
    const s = await until(async () => {
      const s = await state();
      return s.threads.length === 2 && s.threads.every((t) => t.drift) && s;
    });
    assert.deepEqual(
      s.threads.map((t) => t.drift),
      ['exact', 'moved'],
    );
    assert.equal(s.pins, 2);
  });

  it("an agent's reply on disk reaches the open page", slow, async () => {
    const data = await readStore();
    data.threads[0].comments.push({
      id: 'c-agent001',
      author: 'Claude Code',
      role: 'assistant',
      body: 'Done.',
      createdAt: new Date().toISOString(),
    });
    data.extraRootKey = 'kept';
    await fsp.writeFile(path.join(repo, WEB_STORE_REL), JSON.stringify(data, null, 2) + '\n');
    await until(async () => (await state()).threads[0]?.comments === 2);

    // And a reply from the page lands on top of it rather than over it.
    const id = data.threads[0].id;
    await session.evalOverlay(`__refinerApi.reply(${JSON.stringify(id)}, 'thanks')`);
    const after = await until(async () => {
      const d = await readStore();
      return d.threads[0].comments.length === 3 && d;
    });
    assert.deepEqual(
      after.threads[0].comments.map((c) => c.role),
      ['user', 'assistant', 'user'],
    );
    assert.equal(after.extraRootKey, 'kept');
  });

  it("shot re-finds the element in the reviewer's running Chrome and photographs it", slow, async () => {
    const [save, cancel] = (await readStore()).threads;
    const a = await shotThread(repo, save.id.slice(-4), path.join(repo, '.chrome'));
    assert.equal(a.id, save.id);
    assert.equal(a.status, 'exact');
    assert.equal(a.text, 'Save changes');
    assert.equal(a.before, save.web.shot);
    assert.equal(a.error, undefined);
    assert.ok(fs.existsSync(path.join(repo, a.shot)));
    // The thread's URL is the plain page, so Cancel is back where it was.
    const b = await shotThread(repo, cancel.id, path.join(repo, '.chrome'));
    assert.equal(b.status, 'exact');
    assert.equal(b.text, 'Cancel');
    // The tab it opened is gone again; only the reviewer's remains.
    await until(async () => session.tabs.size === 1);
  });

  it('another page shows none of them', slow, async () => {
    await session.navigate(url('/about'));
    const s = await until(async () => {
      const s = await state();
      return s.page === '/about' && s;
    });
    assert.equal(s.pins, 0);
    assert.equal(s.threads.length, 2); // listed in the panel, pinned nowhere
  });

  it('a thread created in an Angular app knows its component, file and template line', slow, async () => {
    await session.navigate(url('/ng'));
    await until(async () => (await state()).page === '/ng');
    await session.evalOverlay(`__refinerApi.create('button', 'shorter label')`);
    const t = await until(async () => (await readStore()).threads.find((x) => x.file === '/ng'));
    assert.deepEqual(t.web.source, {
      framework: 'angular',
      component: 'SettingsFormComponent',
      file: 'src/settings/settings-form.component.ts',
      line: 2,
      template: 'src/settings/settings-form.component.html:2',
    });
  });

  it('editor → browser: goto opens the page with the card, and the window closing ends the session', slow, async () => {
    const [save] = (await readStore()).threads;
    await session.goto(save.id);
    const s = await until(async () => {
      const s = await state();
      return s.page === '/items/:id' && s.open === save.id && s;
    });
    assert.equal(s.open, save.id);
    const closed = session.done.then(() => 'done');
    await session.close();
    assert.equal(await closed, 'done');
    session = null;
  });
});
