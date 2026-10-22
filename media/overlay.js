/*
 * Copied verbatim from the refiner TUI (src/web/overlay.js, commit ec638de): the
 * same overlay the `refiner web` CLI injects. Keep the two in sync by copying, never
 * by editing here. It lives outside src/ because it is browser code that tsc must
 * not re-emit (the file is an unterminated expression that src/web/session.ts
 * completes with the mode argument). The server side it talks to is src/web/session.ts.
 */
/*
 * The in-page half of `refiner web`: pins, the comment composer, thread cards and
 * the thread panel, drawn over the reviewer's app.
 *
 * Plain browser JS, embedded as TEXT (`import ... with { type: 'text' }`) and
 * injected by `src/web/session.ts` through `Page.addScriptToEvaluateOnNewDocument`
 * into an ISOLATED world named "refiner". Three consequences:
 *
 *   - The page cannot see a line of this. Its `window` is a different object,
 *     its globals are not ours, a page that redefines `Array.prototype.map`
 *     does not break us, and its CSP does not apply: the script never touches
 *     the page's script pipeline.
 *   - The DOM IS shared. Our UI lives in a shadow root under one custom element
 *     (`<refiner-overlay>`) so the app's stylesheets cannot reach it, and every
 *     DOM query skips that host.
 *   - Framework internals (`ng.getOwningComponent`, React fibers, Vue's
 *     `__vueParentComponent`) live in the MAIN world, where we cannot read them.
 *     The server does that part (`SOURCE_PROBE` in session.ts), finding the
 *     element through a `data-refiner-pick` attribute we set — the DOM being
 *     the one thing both worlds share.
 *
 * Nothing here talks to the disk. Every mutation is a message through the
 * `__refiner` binding (CDP `Runtime.addBinding`), and the server answers by
 * calling `__refinerRecv` in this world with the authoritative state. The
 * overlay renders what it was last told and never edits its copy of a thread
 * optimistically: the store merges with agents and other writers, and a
 * thread shown in a state the file does not hold is the very drift the TUI's
 * store rules exist to prevent.
 *
 * MODE is 'ui' for the reviewer's session and 'core' for `refiner web shot`,
 * which only wants the anchor resolver.
 */
;(function (MODE) {
  'use strict'
  if (window.top !== window) return
  if (globalThis.__refinerLoaded) return
  globalThis.__refinerLoaded = true

  // ───────────────────────────── anchors ─────────────────────────────
  //
  // A thread does not point at "an element" — elements are recreated on every
  // render — but at a fingerprint of one, resolved again on every page load and
  // every DOM mutation. The same idea as `src/anchor.ts`, with the DOM in place
  // of lines: several independent signals, a weighted vote, and three verdicts.
  //
  //   exact  the element at the recorded CSS path still carries what it carried
  //   moved  a different element wins, but enough signals agree on it
  //   lost   nothing does; the pin disappears and the panel says so
  //
  // Moved is never written back to the store. The fingerprint is the reviewer's
  // record of what they pointed at; overwriting it with a guess would make the
  // next guess drift further, and there is no `range` here that anything else
  // depends on.

  const HOST_TAG = 'refiner-overlay'
  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s)

  /** Generated class names say nothing about the element across builds. */
  function isHashy(c) {
    if (/^(ng-|_ng|css-|sc-|jsx-|svelte-|emotion-|cdk-)/.test(c)) return true
    return /\d/.test(c) && /[a-z]\d|\d[a-z]/i.test(c) && c.length > 5
  }
  const stableClasses = (el) =>
    Array.from(el.classList || []).filter((c) => !isHashy(c)).slice(0, 8)
  function testidOf(el) {
    for (const a of TESTID_ATTRS) {
      const v = el.getAttribute(a)
      if (v) return v
    }
    return ''
  }
  function nameOf(el) {
    const v =
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      ''
    return clip(norm(v), 80)
  }
  const textOf = (el) => clip(norm(el.textContent), 140)
  const tagOf = (el) => el.tagName.toLowerCase()
  const isHost = (el) => el && el.tagName && el.tagName.toLowerCase() === HOST_TAG

  function docRect(el) {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    }
  }

  function nthOfType(el) {
    let i = 1
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === el.tagName) i++
    }
    return `${tagOf(el)}:nth-of-type(${i})`
  }
  /** Purely structural: what is left when nothing about the element is stable. */
  function domPath(el) {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      parts.unshift(nthOfType(n))
    }
    return parts.join(' > ')
  }
  /** Structural, but short-circuited at the nearest unique id or test id. */
  function cssPath(el) {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const tid = testidOf(n)
      if (tid) {
        const sel = `[${TESTID_ATTRS.find((a) => n.getAttribute(a) === tid)}="${CSS.escape(tid)}"]`
        if (document.querySelectorAll(sel).length === 1) {
          parts.unshift(sel)
          break
        }
      }
      if (n.id && !isHashy(n.id) && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(n.id)}`)
        break
      }
      parts.unshift(nthOfType(n))
    }
    return parts.join(' > ')
  }

  function fingerprint(el, at) {
    return {
      tag: tagOf(el),
      id: el.id && !isHashy(el.id) ? el.id : '',
      testid: testidOf(el),
      role: el.getAttribute('role') || '',
      name: nameOf(el),
      text: textOf(el),
      classes: stableClasses(el),
      css: cssPath(el),
      path: domPath(el),
      rect: docRect(el),
      at: at || { fx: 0.5, fy: 0.5 },
    }
  }

  function safeAll(sel) {
    try {
      return sel ? Array.from(document.querySelectorAll(sel)) : []
    } catch {
      return []
    }
  }
  function safeMatches(el, sel) {
    try {
      return !!sel && el.matches(sel)
    } catch {
      return false
    }
  }

  function candidates(fp) {
    const set = new Set()
    const add = (n) => {
      if (n && n.nodeType === 1 && !isHost(n)) set.add(n)
    }
    if (fp.testid) for (const a of TESTID_ATTRS) safeAll(`[${a}="${CSS.escape(fp.testid)}"]`).forEach(add)
    if (fp.id) add(document.getElementById(fp.id))
    safeAll(fp.css).forEach(add)
    safeAll(fp.path).forEach(add)
    if (fp.text || fp.name) {
      const all = document.getElementsByTagName(fp.tag)
      for (let i = 0; i < all.length && i < 5000; i++) {
        const n = all[i]
        if ((fp.text && textOf(n) === fp.text) || (fp.name && nameOf(n) === fp.name)) add(n)
      }
    }
    return Array.from(set)
  }

  /** 0..1: how much of what the fingerprint recorded this element still has. */
  function score(fp, n) {
    if (tagOf(n) !== fp.tag) return 0
    let s = 0
    let max = 0
    const vote = (present, weight, hit) => {
      if (!present) return
      max += weight
      if (hit) s += weight
    }
    vote(!!fp.testid, 40, testidOf(n) === fp.testid)
    vote(!!fp.id, 25, n.id === fp.id)
    if (fp.text) {
      max += 25
      const t = textOf(n)
      if (t === fp.text) s += 25
      else if (t && (t.includes(fp.text) || fp.text.includes(t))) s += 8
    }
    vote(!!fp.name, 15, nameOf(n) === fp.name)
    vote(!!fp.role, 5, (n.getAttribute('role') || '') === fp.role)
    if (fp.classes.length) {
      max += 10
      const c = stableClasses(n)
      const inter = c.filter((x) => fp.classes.includes(x)).length
      s += (10 * inter) / Math.max(c.length, fp.classes.length)
    }
    vote(true, 15, safeMatches(n, fp.css))
    vote(true, 10, safeMatches(n, fp.path))
    max += 10
    const r = docRect(n)
    s += 10 * Math.max(0, 1 - Math.hypot(r.x - fp.rect.x, r.y - fp.rect.y) / 800)
    return max === 0 ? 0 : s / max
  }

  /** → { status: 'exact'|'moved'|'lost', el, score } */
  function resolve(fp) {
    let best = null
    let bestScore = 0
    for (const n of candidates(fp)) {
      const sc = score(fp, n)
      if (sc > bestScore) {
        best = n
        bestScore = sc
      }
    }
    if (!best || bestScore < 0.5) return { status: 'lost', el: null, score: bestScore }
    const exact = bestScore >= 0.8 && safeMatches(best, fp.css)
    return { status: exact ? 'exact' : 'moved', el: best, score: bestScore }
  }

  globalThis.__refinerCore = { fingerprint, resolve, docRect }
  if (MODE !== 'ui') return

  // ───────────────────────────── transport ─────────────────────────────

  let reqSeq = 0
  function send(msg) {
    try {
      globalThis.__refiner(JSON.stringify(msg))
    } catch {
      toast('refiner is not connected — is `refiner web` still running?')
    }
  }

  // ───────────────────────────── state ─────────────────────────────

  const S = {
    author: '',
    page: '',
    threads: [],
    readOnly: false,
    connected: false,
    mode: 'idle', // idle | pick | compose
    hover: null,
    lockStack: [], // ArrowUp history while picking
    compose: null, // { el, fp, x, y }
    open: null, // thread id whose card is open
    panel: false,
    pinsHidden: false,
    showResolved: false,
    sending: false,
    confirmDelete: false,
    shooting: false,
  }
  /** thread id → { status, el } — rebuilt on load and on DOM mutations. */
  let resolved = new Map()

  // ───────────────────────────── DOM scaffold ─────────────────────────────

  const host = document.createElement(HOST_TAG)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${CSS_TEXT()}</style>
    <div class="hl" hidden><div class="hl-label"></div></div>
    <div class="pins"></div>
    <div class="layer"></div>
    <div class="panel" hidden></div>
    <div class="bar"></div>
    <div class="toast" hidden></div>`
  const $ = (sel) => root.querySelector(sel)
  const hl = $('.hl')
  const pinsEl = $('.pins')
  const layer = $('.layer')
  const panelEl = $('.panel')
  const barEl = $('.bar')
  const toastEl = $('.toast')

  function mount() {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host)
  }
  // At document start there is no <html> yet, and some frameworks replace the
  // whole document on boot; mount as soon as we can and re-mount if we fall out.
  mount()
  document.addEventListener('DOMContentLoaded', mount)
  setInterval(mount, 1000)

  // ───────────────────────────── helpers ─────────────────────────────

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  /** Enough markdown for review prose: fences, `code`, **bold**, lists, paragraphs. */
  function md(src) {
    const out = []
    const blocks = String(src).split(/```/)
    blocks.forEach((chunk, i) => {
      if (i % 2 === 1) {
        const body = chunk.replace(/^[^\n]*\n/, '')
        out.push(`<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`)
        return
      }
      for (const para of chunk.split(/\n{2,}/)) {
        if (!para.trim()) continue
        const lines = para.split('\n')
        const inline = (t) =>
          esc(t)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<i>$2</i>')
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`)
        } else if (lines.every((l) => /^>/.test(l))) {
          out.push(`<blockquote>${lines.map((l) => inline(l.replace(/^>\s?/, ''))).join('<br>')}</blockquote>`)
        } else {
          out.push(`<p>${lines.map(inline).join('<br>')}</p>`)
        }
      }
    })
    return out.join('')
  }

  /** A one-line preview: the markup a card renders, dropped. */
  const plain = (src) => norm(String(src).replace(/```[^\n]*\n?/g, ' ').replace(/[*_`>#]+/g, ''))

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000
    if (!isFinite(s)) return ''
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
  }

  function label(el) {
    let s = tagOf(el)
    if (el.id) s += `#${el.id}`
    const c = stableClasses(el).slice(0, 2)
    if (c.length) s += '.' + c.join('.')
    return s
  }

  const onPage = (t) => t.web && t.web.page === S.page
  const pageThreads = () => S.threads.filter(onPage)
  const visibleOnPage = () => pageThreads().filter((t) => S.showResolved || t.status === 'open')
  const lastRole = (t) => (t.comments.length ? t.comments[t.comments.length - 1].role : 'user')
  const awaitingYou = (t) => t.status === 'open' && lastRole(t) === 'assistant'
  const numberOf = (t) => pageThreads().indexOf(t) + 1
  const byId = (id) => S.threads.find((t) => t.id === id)

  let toastTimer = 0
  function toast(text) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastEl.hidden = true), 4000)
  }

  function inOverlay(e) {
    return e.composedPath().includes(host)
  }

  function isEditable(el) {
    if (!el) return false
    if (el.isContentEditable) return true
    const t = el.tagName
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'
  }

  // ───────────────────────────── resolution ─────────────────────────────

  function resolveAll() {
    const next = new Map()
    for (const t of pageThreads()) {
      const r = resolve(t.web.anchor)
      next.set(t.id, r)
    }
    resolved = next
    renderPanel()
    renderBar()
  }

  let mutTimer = 0
  new MutationObserver((records) => {
    if (records.every((r) => r.target === host)) return
    clearTimeout(mutTimer)
    mutTimer = setTimeout(resolveAll, 250)
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })

  // ───────────────────────────── frame loop: pins & highlight ─────────────────────────────

  const pinNodes = new Map()
  function frame() {
    requestAnimationFrame(frame)
    if (S.shooting) return
    // Pins
    const want = new Set()
    if (!S.pinsHidden) {
      for (const t of visibleOnPage()) {
        const r = resolved.get(t.id)
        if (!r || !r.el || !r.el.isConnected) continue
        const b = r.el.getBoundingClientRect()
        if (b.width === 0 && b.height === 0) continue
        want.add(t.id)
        let p = pinNodes.get(t.id)
        if (!p) {
          p = document.createElement('button')
          p.className = 'pin'
          p.addEventListener('click', (e) => {
            e.stopPropagation()
            openCard(t.id)
          })
          pinsEl.appendChild(p)
          pinNodes.set(t.id, p)
        }
        const at = t.web.anchor.at || { fx: 0.5, fy: 0.5 }
        const x = b.left + b.width * at.fx
        const y = b.top + b.height * at.fy
        // left/top, not a translate: the hover/active `scale` composes with
        // `transform`, and would scale the offset along with the pin.
        p.style.left = `${Math.round(x)}px`
        p.style.top = `${Math.round(y) - 28}px`
        const cls =
          'pin' +
          (t.status === 'resolved' ? ' resolved' : awaitingYou(t) ? ' answered' : '') +
          (S.open === t.id ? ' active' : '') +
          (r.status === 'moved' ? ' moved' : '')
        if (p.className !== cls) p.className = cls
        const n = String(numberOf(t))
        if (p.textContent !== n) p.textContent = n
        p.title = `${t.comments[0] ? t.comments[0].author : ''}: ${clip(plain(t.comments[0] ? t.comments[0].body : ''), 80)}`
      }
    }
    for (const [id, p] of pinNodes) {
      if (!want.has(id)) {
        p.remove()
        pinNodes.delete(id)
      }
    }
    // Highlight: the hovered element while picking, the anchored one while a card is open.
    let target = null
    if (S.mode === 'pick') target = S.lockStack.length ? S.lockStack[S.lockStack.length - 1] : S.hover
    else if (S.mode === 'compose' && S.compose) target = S.compose.el
    else if (S.open) {
      const r = resolved.get(S.open)
      target = r && r.el
    }
    if (target && target.isConnected) {
      const b = target.getBoundingClientRect()
      hl.hidden = false
      hl.style.transform = `translate(${b.left}px, ${b.top}px)`
      hl.style.width = `${b.width}px`
      hl.style.height = `${b.height}px`
      hl.classList.toggle('picking', S.mode === 'pick')
      const lab = hl.firstElementChild
      const text = S.mode === 'pick' ? `${label(target)}  ${Math.round(b.width)}×${Math.round(b.height)}` : ''
      if (lab.textContent !== text) lab.textContent = text
      lab.hidden = !text
    } else {
      hl.hidden = true
    }
    // Keep an open card glued to its pin while the page scrolls.
    if (S.open) placeCard()
  }
  requestAnimationFrame(frame)

  // ───────────────────────────── picking ─────────────────────────────

  function setMode(m) {
    S.mode = m
    S.lockStack = []
    host.classList.toggle('picking', m === 'pick')
    document.documentElement.style.cursor = m === 'pick' ? 'crosshair' : ''
    renderBar()
  }

  function startPick() {
    if (S.readOnly) return toast('the thread store is read-only — repair .refiner/web-comments.json')
    closeCard()
    closeCompose()
    setMode('pick')
  }

  addEventListener(
    'mousemove',
    (e) => {
      if (S.mode !== 'pick' || inOverlay(e)) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (el && !isHost(el) && el !== S.hover) {
        S.hover = el
        S.lockStack = []
      }
    },
    true,
  )

  // While picking, the page must not see the click that picks: no navigation,
  // no submit, no menu opening under the composer.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    addEventListener(
      type,
      (e) => {
        if (S.mode !== 'pick' || inOverlay(e)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type === 'click') {
          const el = S.lockStack.length ? S.lockStack[S.lockStack.length - 1] : S.hover
          if (el) beginCompose(el, e.clientX, e.clientY)
        }
      },
      true,
    )
  }

  function beginCompose(el, cx, cy) {
    const b = el.getBoundingClientRect()
    const at = {
      fx: b.width ? Math.min(1, Math.max(0, (cx - b.left) / b.width)) : 0.5,
      fy: b.height ? Math.min(1, Math.max(0, (cy - b.top) / b.height)) : 0.5,
    }
    S.compose = { el, fp: fingerprint(el, at) }
    setMode('compose')
    renderCompose()
  }

  function closeCompose() {
    S.compose = null
    if (S.mode === 'compose') setMode('idle')
    const c = layer.querySelector('.composer')
    if (c) c.remove()
  }

  function submitCompose(body) {
    if (!S.compose || !body.trim() || S.sending) return
    const token = Math.random().toString(36).slice(2, 10)
    S.compose.el.setAttribute('data-refiner-pick', token)
    S.sending = true
    send({
      type: 'create',
      req: ++reqSeq,
      href: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      anchor: S.compose.fp,
      pick: token,
      body,
    })
  }

  // ───────────────────────────── keyboard ─────────────────────────────

  addEventListener(
    'keydown',
    (e) => {
      const ours = inOverlay(e)
      if (e.key === 'Escape') {
        if (S.mode === 'pick') setMode('idle')
        else if (S.mode === 'compose') closeCompose()
        else if (S.open) closeCard()
        else if (S.panel) togglePanel(false)
        else return
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      if (ours) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          const ta = e.composedPath().find((n) => n.tagName === 'TEXTAREA')
          if (ta) {
            e.preventDefault()
            ta.dispatchEvent(new CustomEvent('submit-chord'))
          }
        }
        // Typing in our textarea must not reach the page's shortcuts.
        e.stopImmediatePropagation()
        return
      }
      if (S.mode === 'pick') {
        const cur = S.lockStack.length ? S.lockStack[S.lockStack.length - 1] : S.hover
        if (e.key === 'ArrowUp' && cur && cur.parentElement && cur.parentElement !== document.documentElement) {
          S.lockStack.push(cur.parentElement)
        } else if (e.key === 'ArrowDown' && S.lockStack.length) {
          S.lockStack.pop()
        } else if (e.key === 'Enter' && cur) {
          const b = cur.getBoundingClientRect()
          beginCompose(cur, b.left + b.width / 2, b.top + b.height / 2)
        } else return
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      if (isEditable(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'c') startPick()
      else if (e.key === 'C') togglePanel()
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true,
  )

  // ───────────────────────────── cards ─────────────────────────────

  function openCard(id, scroll) {
    closeCompose()
    if (S.mode === 'pick') setMode('idle')
    S.open = id
    S.confirmDelete = false
    renderCard()
    const r = resolved.get(id)
    if (scroll && r && r.el) r.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  function closeCard() {
    S.open = null
    const c = layer.querySelector('.card')
    if (c) c.remove()
  }

  /** Where a floating box goes: next to the anchor point, inside the viewport. */
  function anchorPoint() {
    if (S.compose) {
      const b = S.compose.el.getBoundingClientRect()
      return { x: b.left + b.width * S.compose.fp.at.fx, y: b.top + b.height * S.compose.fp.at.fy }
    }
    const t = S.open && byId(S.open)
    const r = S.open && resolved.get(S.open)
    if (t && r && r.el) {
      const b = r.el.getBoundingClientRect()
      const at = t.web.anchor.at || { fx: 0.5, fy: 0.5 }
      return { x: b.left + b.width * at.fx, y: b.top + b.height * at.fy }
    }
    return null
  }

  function place(box) {
    const p = anchorPoint()
    const w = box.offsetWidth || 340
    const h = box.offsetHeight || 200
    let x
    let y
    if (!p) {
      // Lost anchor: dock to the right edge rather than pretend a position.
      x = innerWidth - w - (S.panel ? 360 : 16)
      y = 72
    } else {
      x = p.x + 18
      y = p.y - 24
      if (x + w > innerWidth - 12) x = p.x - w - 18
      if (x < 12) x = 12
      if (y + h > innerHeight - 72) y = innerHeight - 72 - h
      if (y < 12) y = 12
    }
    box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }
  function placeCard() {
    const c = layer.querySelector('.card')
    if (c) place(c)
  }

  function renderCompose() {
    let c = layer.querySelector('.composer')
    if (!c) {
      c = document.createElement('div')
      c.className = 'box composer'
      layer.appendChild(c)
    }
    c.innerHTML = `
      <div class="box-head"><span class="dot"></span><span class="who">${esc(S.author)}</span>
        <span class="muted">on ${esc(label(S.compose.el))}</span></div>
      <textarea placeholder="Leave a thread…  ⌘↵ to post" rows="3"></textarea>
      <div class="row"><span class="muted small">esc cancels</span><span class="grow"></span>
        <button class="ghost" data-a="cancel">Cancel</button>
        <button class="primary" data-a="post">Comment</button></div>`
    const ta = c.querySelector('textarea')
    const go = () => submitCompose(ta.value)
    ta.addEventListener('submit-chord', go)
    c.querySelector('[data-a=post]').addEventListener('click', go)
    c.querySelector('[data-a=cancel]').addEventListener('click', closeCompose)
    place(c)
    setTimeout(() => ta.focus(), 0)
  }

  function renderCard() {
    const t = S.open && byId(S.open)
    let c = layer.querySelector('.card')
    if (!t) {
      if (c) c.remove()
      S.open = null
      return
    }
    // Keep a half-typed reply across re-renders: an agent's reply landing while
    // the reviewer types must not eat the draft.
    const draft = c ? c.querySelector('textarea')?.value || '' : ''
    const hadFocus = c && root.activeElement && root.activeElement.tagName === 'TEXTAREA'
    if (!c) {
      c = document.createElement('div')
      c.className = 'box card'
      layer.appendChild(c)
    }
    const r = resolved.get(t.id)
    const drift = t.web.page !== S.page ? 'other page' : r ? r.status : 'lost'
    const src = t.web.source
    const srcLine =
      src && (src.file || src.component)
        ? `<div class="src">${src.component ? `<b>${esc(src.component)}</b> ` : ''}${src.file ? esc(src.file + (src.line ? ':' + src.line : '')) : ''}</div>`
        : ''
    c.innerHTML = `
      <div class="box-head">
        <span class="num ${t.status}">${numberOf(t) || '·'}</span>
        <span class="who">${esc(t.web.anchor.tag)}${t.web.anchor.text ? ` <span class="muted">“${esc(clip(t.web.anchor.text, 32))}”</span>` : ''}</span>
        <span class="grow"></span>
        ${drift !== 'exact' ? `<span class="chip ${drift === 'lost' ? 'warn' : ''}">${esc(drift)}</span>` : ''}
        ${t.status === 'resolved' ? '<span class="chip ok">resolved</span>' : ''}
        <button class="icon" data-a="close" title="Close (esc)">✕</button>
      </div>
      ${srcLine}
      <div class="comments">${t.comments
        .map(
          (m) => `<div class="cm ${m.role}">
            <div class="cm-head"><span class="avatar ${m.role}">${esc((m.author || '?').slice(0, 1).toUpperCase())}</span>
              <b>${esc(m.author || 'anon')}</b>${m.role === 'assistant' ? '<span class="chip agent">agent</span>' : ''}
              <span class="muted small">${ago(m.createdAt)}</span></div>
            <div class="md">${md(m.body)}</div></div>`,
        )
        .join('')}</div>
      <textarea placeholder="Reply…  ⌘↵ to send" rows="2"></textarea>
      <div class="row">
        <button class="ghost danger" data-a="delete">${S.confirmDelete ? 'Delete thread?' : 'Delete'}</button>
        <span class="grow"></span>
        <button class="ghost" data-a="status">${t.status === 'open' ? '✓ Resolve' : 'Reopen'}</button>
        <button class="primary" data-a="reply">Reply</button>
      </div>`
    const ta = c.querySelector('textarea')
    ta.value = draft
    const reply = () => {
      if (!ta.value.trim()) return
      send({ type: 'reply', req: ++reqSeq, threadId: t.id, body: ta.value })
      ta.value = ''
    }
    ta.addEventListener('submit-chord', reply)
    c.querySelector('[data-a=reply]').addEventListener('click', reply)
    c.querySelector('[data-a=close]').addEventListener('click', closeCard)
    c.querySelector('[data-a=status]').addEventListener('click', () =>
      send({ type: 'status', req: ++reqSeq, threadId: t.id, status: t.status === 'open' ? 'resolved' : 'open' }),
    )
    c.querySelector('[data-a=delete]').addEventListener('click', () => {
      if (!S.confirmDelete) {
        S.confirmDelete = true
        renderCard()
        return
      }
      send({ type: 'delete', req: ++reqSeq, threadId: t.id })
      closeCard()
    })
    const list = c.querySelector('.comments')
    list.scrollTop = list.scrollHeight
    place(c)
    if (hadFocus) ta.focus()
  }

  // ───────────────────────────── panel ─────────────────────────────

  function togglePanel(on) {
    S.panel = on === undefined ? !S.panel : on
    renderPanel()
    renderBar()
  }

  function renderPanel() {
    panelEl.hidden = !S.panel
    if (!S.panel) return
    const list = S.threads.filter((t) => S.showResolved || t.status === 'open')
    const groups = new Map()
    for (const t of list) {
      const k = t.web ? t.web.page : t.file
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(t)
    }
    // The current page first, then the rest alphabetically.
    const keys = Array.from(groups.keys()).sort((a, b) => (a === S.page ? -1 : b === S.page ? 1 : a.localeCompare(b)))
    // Re-rendered on every DOM mutation of the app; keep the reader's place.
    const prevScroll = panelEl.querySelector('.panel-body')?.scrollTop ?? 0
    panelEl.innerHTML = `
      <div class="panel-head"><b>Threads</b><span class="muted">${S.threads.filter((t) => t.status === 'open').length} open</span>
        <span class="grow"></span>
        <label class="small muted"><input type="checkbox" ${S.showResolved ? 'checked' : ''} data-a="resolved"> resolved</label>
        <button class="icon" data-a="close">✕</button></div>
      <div class="panel-body">${
        keys.length === 0
          ? `<div class="empty">No threads yet.<br>Press <kbd>C</kbd> and click anything.</div>`
          : keys
              .map(
                (k) => `<div class="grp"><div class="grp-head ${k === S.page ? 'here' : ''}">${esc(k)}${k === S.page ? ' <span class="chip">this page</span>' : ''}</div>
          ${groups
            .get(k)
            .map((t) => {
              const r = resolved.get(t.id)
              const st = k !== S.page ? '' : r ? r.status : 'lost'
              const first = t.comments[0]
              return `<button class="item ${S.open === t.id ? 'active' : ''}" data-id="${esc(t.id)}">
                <span class="num ${t.status}">${k === S.page ? numberOf(t) : '·'}</span>
                <span class="item-body"><span class="item-text">${esc(clip(plain(first ? first.body : ''), 90))}</span>
                <span class="item-meta muted small">${esc(first ? first.author : '')} · ${t.comments.length} ${t.comments.length === 1 ? 'comment' : 'comments'}
                ${awaitingYou(t) ? '<span class="chip agent">agent replied</span>' : ''}
                ${st === 'moved' ? '<span class="chip">moved</span>' : ''}${st === 'lost' ? '<span class="chip warn">lost</span>' : ''}
                ${t.status === 'resolved' ? '<span class="chip ok">resolved</span>' : ''}</span></span></button>`
            })
            .join('')}</div>`,
              )
              .join('')
      }</div>`
    panelEl.querySelector('.panel-body').scrollTop = prevScroll
    panelEl.querySelector('[data-a=close]').addEventListener('click', () => togglePanel(false))
    panelEl.querySelector('[data-a=resolved]').addEventListener('change', (e) => {
      S.showResolved = e.target.checked
      renderPanel()
    })
    panelEl.querySelectorAll('.item').forEach((b) =>
      b.addEventListener('click', () => {
        const t = byId(b.dataset.id)
        if (!t) return
        if (t.web && t.web.page === S.page) openCard(t.id, true)
        else send({ type: 'goto', req: ++reqSeq, threadId: t.id })
      }),
    )
  }

  // ───────────────────────────── toolbar ─────────────────────────────

  function renderBar() {
    const open = S.threads.filter((t) => t.status === 'open').length
    const answered = S.threads.filter(awaitingYou).length
    const here = pageThreads().filter((t) => t.status === 'open').length
    barEl.innerHTML = `
      <span class="brand" title="refiner web — threads in .refiner/web-comments.json"><span class="logo ${S.connected ? 'on' : ''}"></span>refiner</span>
      <button class="tb ${S.mode === 'pick' ? 'on' : ''}" data-a="pick" title="Comment on an element (C)">
        <svg viewBox="0 0 16 16"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z"/></svg>
        Comment<kbd>C</kbd></button>
      <button class="tb ${S.panel ? 'on' : ''}" data-a="panel" title="All threads (shift+C)">
        <svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h6"/></svg>
        ${here}<span class="muted">/${open}</span>${answered ? `<span class="badge" title="${answered} answered by the agent">${answered}</span>` : ''}</button>
      <button class="tb icon-only ${S.pinsHidden ? '' : 'on'}" data-a="pins" title="${S.pinsHidden ? 'Show' : 'Hide'} pins">
        <svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg></button>
      ${S.readOnly ? '<span class="chip warn">read-only</span>' : ''}
      ${S.mode === 'pick' ? '<span class="hint">click an element · ↑ parent · esc</span>' : ''}`
    barEl.querySelector('[data-a=pick]').addEventListener('click', () => (S.mode === 'pick' ? setMode('idle') : startPick()))
    barEl.querySelector('[data-a=panel]').addEventListener('click', () => togglePanel())
    barEl.querySelector('[data-a=pins]').addEventListener('click', () => {
      S.pinsHidden = !S.pinsHidden
      renderBar()
    })
  }

  // ───────────────────────────── server → overlay ─────────────────────────────

  globalThis.__refinerRecv = (msg) => {
    switch (msg.type) {
      case 'state': {
        S.connected = true
        S.author = msg.author
        S.page = msg.page
        S.threads = msg.threads
        S.readOnly = msg.readOnly
        if (msg.error) toast(msg.error)
        resolveAll()
        if (S.open) renderCard()
        if (msg.focus && byId(msg.focus)) {
          // A goto lands before the app has rendered; give it a moment.
          const id = msg.focus
          let tries = 0
          const tryOpen = () => {
            resolveAll()
            const r = resolved.get(id)
            if ((r && r.el) || tries++ > 20) openCard(id, true)
            else setTimeout(tryOpen, 150)
          }
          tryOpen()
        }
        break
      }
      case 'ack': {
        if (msg.kind === 'create') {
          S.sending = false
          const el = document.querySelector('[data-refiner-pick]')
          if (el) el.removeAttribute('data-refiner-pick')
          if (msg.ok) {
            closeCompose()
            if (msg.id) openCard(msg.id)
          }
        }
        if (!msg.ok) toast(msg.error || 'refiner could not save that')
        break
      }
      case 'shoot': {
        // Screenshots must show the app, not our chrome — except an outline
        // around the element, which is the point of the picture.
        S.shooting = msg.on
        root.querySelectorAll('.pins, .layer, .panel, .bar, .toast').forEach((n) => (n.style.visibility = msg.on ? 'hidden' : ''))
        if (msg.on) {
          const el = document.querySelector('[data-refiner-pick]')
          if (el) {
            const b = el.getBoundingClientRect()
            hl.hidden = false
            hl.classList.add('shot')
            hl.style.transform = `translate(${b.left}px, ${b.top}px)`
            hl.style.width = `${b.width}px`
            hl.style.height = `${b.height}px`
            hl.firstElementChild.hidden = true
          }
        } else {
          hl.classList.remove('shot')
        }
        break
      }
    }
  }

  /** Test hook: the same paths the UI takes, minus the mouse. */
  globalThis.__refinerApi = {
    create(selector, body) {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`no element for ${selector}`)
      const b = el.getBoundingClientRect()
      beginCompose(el, b.left + b.width / 2, b.top + b.height / 2)
      submitCompose(body)
    },
    reply(threadId, body) {
      send({ type: 'reply', req: ++reqSeq, threadId, body })
    },
    state() {
      return {
        page: S.page,
        threads: S.threads.map((t) => ({
          id: t.id,
          comments: t.comments.length,
          status: t.status,
          drift: resolved.has(t.id) ? resolved.get(t.id).status : null,
        })),
        pins: pinNodes.size,
        open: S.open,
      }
    },
  }

  let lastHref = ''
  function hello() {
    lastHref = location.href
    send({ type: 'hello', href: location.href })
  }
  // SPAs navigate without a page load; the route decides which threads show.
  setInterval(() => {
    if (location.href !== lastHref) {
      closeCard()
      closeCompose()
      hello()
    }
  }, 300)
  hello()
  renderBar()

  // ───────────────────────────── styles ─────────────────────────────

  function CSS_TEXT() {
    return `
:host { all: initial; }
:host, * { box-sizing: border-box; }
.pins, .layer, .hl { position: fixed; inset: 0 auto auto 0; z-index: 2147483646; pointer-events: none; }
* { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
:host {
  --bg: #1c1c1f; --bg2: #26262b; --bg3: #303036; --fg: #ececf1; --mut: #9a9aa6; --line: #3a3a42;
  --acc: #a78bfa; --acc2: #7c5cff; --ok: #4ade80; --agent: #34d399; --warn: #fbbf24; --danger: #f87171;
}
.hl { border: 2px solid var(--acc); border-radius: 4px; background: rgba(167,139,250,.08); transition: transform .06s, width .06s, height .06s; }
.hl.picking { border-style: solid; background: rgba(167,139,250,.14); }
.hl.shot { background: transparent; border: 2px dashed #ff3d7f; }
.hl-label { position: absolute; top: -24px; left: -2px; background: var(--acc2); color: white; font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 5px 7px; border-radius: 4px; white-space: nowrap; }
.pin { position: fixed; top: 0; left: 0; pointer-events: auto; cursor: pointer; width: 28px; height: 28px; border: 2px solid white;
  border-radius: 14px 14px 14px 3px; background: var(--acc2); color: white; font: 700 12px/1 system-ui, sans-serif; display: grid; place-items: center;
  box-shadow: 0 4px 14px rgba(0,0,0,.35); transition: scale .12s; transform-origin: 0 100%; padding: 0; }
.pin:hover, .pin.active { scale: 1.15; }
.pin.answered { background: #10b981; }
.pin.resolved { background: #6b7280; opacity: .7; }
.pin.active { background: #ff3d7f; opacity: 1; }
.pin.moved { border-style: dashed; }
.box { position: fixed; top: 0; left: 0; pointer-events: auto; width: 340px; max-height: min(520px, calc(100vh - 100px)); display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.45); font-size: 13px; line-height: 1.45; overflow: hidden; }
.box-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); min-height: 44px; }
.who { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: var(--acc); }
.src { padding: 6px 12px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--mut); border-bottom: 1px solid var(--line); background: var(--bg2); word-break: break-all; }
.src b { color: var(--acc); font-weight: 600; }
.comments { overflow-y: auto; padding: 4px 0; flex: 1; }
.cm { padding: 8px 12px; }
.cm + .cm { border-top: 1px solid rgba(255,255,255,.04); }
.cm.assistant { background: rgba(52,211,153,.05); }
.cm-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.avatar { width: 20px; height: 20px; border-radius: 10px; display: grid; place-items: center; font-size: 10px; font-weight: 700; background: var(--acc2); color: white; }
.avatar.assistant { background: #10b981; }
.md p, .md ul, .md pre, .md blockquote { margin: 4px 0; }
.md ul { padding-left: 18px; }
.md code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg3); padding: 1px 4px; border-radius: 4px; }
.md pre { background: #121214; padding: 8px; border-radius: 6px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md blockquote { border-left: 3px solid var(--line); padding-left: 8px; color: var(--mut); }
textarea { margin: 8px 12px 0; width: calc(100% - 24px); resize: vertical; min-height: 44px; background: var(--bg2); color: var(--fg); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 10px; font-size: 13px; line-height: 1.4; outline: none; }
textarea:focus { border-color: var(--acc); box-shadow: 0 0 0 3px rgba(167,139,250,.2); }
.row { display: flex; align-items: center; gap: 6px; padding: 8px 12px 10px; }
.grow { flex: 1; }
button { font: inherit; cursor: pointer; border: 0; }
.primary { background: var(--acc2); color: white; padding: 6px 12px; border-radius: 7px; font-weight: 600; }
.primary:hover { background: #6d48ff; }
.ghost { background: transparent; color: var(--fg); padding: 6px 10px; border-radius: 7px; }
.ghost:hover { background: var(--bg3); }
.ghost.danger { color: var(--danger); }
.icon { background: transparent; color: var(--mut); width: 26px; height: 26px; border-radius: 6px; }
.icon:hover { background: var(--bg3); color: var(--fg); }
.muted { color: var(--mut); font-weight: 400; }
.small { font-size: 11px; }
.chip { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 2px 6px; border-radius: 999px; background: var(--bg3); color: var(--mut); white-space: nowrap; }
.chip.warn { color: var(--warn); background: rgba(251,191,36,.12); }
.chip.ok { color: var(--ok); background: rgba(74,222,128,.12); }
.chip.agent { color: var(--agent); background: rgba(52,211,153,.12); }
.num { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px 11px 11px 3px; background: var(--acc2); color: white; font-size: 11px; font-weight: 700; display: inline-grid; place-items: center; }
.num.resolved { background: #6b7280; }
.bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 4px; padding: 5px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.4); font-size: 13px; pointer-events: auto; }
.brand { display: flex; align-items: center; gap: 7px; padding: 0 10px 0 8px; font-weight: 700; letter-spacing: -.01em; border-right: 1px solid var(--line); margin-right: 2px; }
.logo { width: 10px; height: 10px; border-radius: 3px; background: #6b7280; transform: rotate(45deg); }
.logo.on { background: linear-gradient(135deg, #a78bfa, #ff3d7f); }
.tb { display: flex; align-items: center; gap: 6px; background: transparent; color: var(--fg); padding: 7px 10px; border-radius: 8px; position: relative; }
.tb:hover { background: var(--bg3); }
.tb.on { background: var(--acc2); color: white; }
.tb.on .muted { color: rgba(255,255,255,.7); }
.tb svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.tb.icon-only { padding: 7px; }
.tb:not(.on).icon-only { color: var(--mut); }
kbd { font: 600 10px ui-monospace, monospace; padding: 2px 5px; border-radius: 4px; background: rgba(255,255,255,.12); }
.badge { position: absolute; top: -5px; right: -5px; box-shadow: 0 0 0 2px var(--bg); min-width: 15px; height: 15px; border-radius: 8px; background: #10b981; color: white; font-size: 9px; font-weight: 700; display: grid; place-items: center; padding: 0 3px; }
.hint { color: var(--mut); font-size: 12px; padding: 0 8px; }
.panel { position: fixed; top: 12px; right: 12px; bottom: 76px; width: 340px; z-index: 2147483647; pointer-events: auto; display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.45); font-size: 13px; overflow: hidden; }
.panel[hidden] { display: none; }
.panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.panel-head label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.panel-body { overflow-y: auto; flex: 1; padding: 6px; }
.grp-head { font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--mut); padding: 10px 8px 4px; display: flex; gap: 6px; align-items: center; }
.grp-head.here { color: var(--acc); }
.item { display: flex; gap: 10px; width: 100%; text-align: left; background: transparent; color: var(--fg); padding: 8px; border-radius: 8px; align-items: flex-start; }
.item:hover, .item.active { background: var(--bg2); }
.item-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.item-text { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.item-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.empty { color: var(--mut); text-align: center; padding: 40px 20px; line-height: 1.8; }
.toast { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 2147483647; background: #3b1d1d; color: #fecaca; border: 1px solid #7f1d1d;
  padding: 8px 14px; border-radius: 8px; font-size: 13px; pointer-events: none; max-width: 80vw; }
.toast[hidden], .hl[hidden], .hl-label[hidden] { display: none; }
`
  }
})
