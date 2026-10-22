---
name: refine-resolve
description: Read open review threads from .refiner/comments.json (code) and .refiner/web-comments.json (UI elements, from the browser review session), apply the requested changes, and reply in-thread (never resolves or deletes)
user-invocable: true
---

# refine-resolve skill

You are reading open review threads and acting on each one — making the code change
the human requested, then **replying** in the thread with what you did. They live in
two files at the repo root, and you process both:

- `.refiner/comments.json` — threads on **lines of code**, written in the **Refiner**
  VSCode extension (or the refiner TUI). Your replies show up inline for them.
- `.refiner/web-comments.json` — threads on **elements of the running UI**, written in
  the browser through **Refiner: Review UI in Browser** / `refiner web` (see **Web
  threads** below). Your replies show up live in that browser window, and in VSCode's
  **UI Threads** view.

## Arguments

- `thread-id` (optional): process a single thread by id (full id or unique suffix,
  e.g. `/refine-resolve a3f9c1b8`). If omitted, process every actionable open thread.

## Critical rule — read this twice

**You NEVER set `status` to `"resolved"` and you NEVER delete a thread or comment.**

Resolving is the human's job: they click the ✓ (Resolve) button in the Refiner
extension — or **✓ Resolve** on the thread's card in the browser — once they've
verified your change. Your job ends at: code change applied + reply comment appended.
If you set `status` to `"resolved"` or remove any thread or comment, you've broken the
workflow. Don't.

## Storage format

Each file is one JSON object: `{ "version": 1, "threads": [ ... ] }`. Each thread:

```json
{
  "id": "t-a3f9c1b8",
  "file": "src/foo.ts",
  "range": { "start": 42, "end": 45 },
  "status": "open",
  "comments": [
    {
      "id": "c-1",
      "author": "angel",
      "role": "user",
      "body": "this loop is O(n²)",
      "createdAt": "2026-07-17T10:30:00.000Z"
    }
  ]
}
```

You add a reply by **appending** a comment to that thread's `comments` array:

```json
{
  "id": "c-91b2e4d0",
  "author": "Claude Code",
  "role": "assistant",
  "body": "Replaced the scan with a lookup against `byFile`.",
  "createdAt": "2026-07-18T15:10:00.000Z"
}
```

- `role` — always `"assistant"` for your replies. This is how both the extension and
  this skill tell your messages from the human's.
- `id` — unique. Use `c-` + 8 hex: `python3 -c "import secrets; print(secrets.token_hex(4))"`.
- `createdAt` — ISO-8601 UTC (current time).
- Leave `status`, `range`, `file`, the human's comments, and any `anchor` or `web`
  field untouched. Append only.

## Web threads

`.refiner/web-comments.json` has exactly the same shape — `version`, `threads[]`,
`id`, `status`, `comments[]` with the same roles and ids — and exactly the same rules:
append a reply, never resolve, never delete. Two fields mean something else:

- `file` is the **page** (a URL path with ids collapsed, e.g. `/users/:id/edit`),
  **not** a source path. `range` is a placeholder (`1–1`). Never edit either.
- `web` is the real target. **Never edit it** — the browser re-finds the element from
  it on every load:

```json
"web": {
  "url": "http://localhost:4200/settings",
  "page": "/settings",
  "title": "Acme · Settings",
  "viewport": { "w": 1280, "h": 800 },
  "anchor": { "tag": "button", "testid": "save", "text": "Save changes",
              "classes": ["btn", "primary"], "css": "[data-testid=\"save\"]", "...": "..." },
  "source": { "framework": "angular", "component": "SettingsFormComponent",
              "file": "src/app/settings/settings-form.component.ts", "line": 12,
              "template": "src/app/settings/settings-form.component.html:41" },
  "shot": ".refiner/shots/mf3k2-ab12cd.png"
}
```

How to work one:

1. **Look at the picture.** `web.shot` is a PNG of the element as the human saw it,
   outlined in dashed pink. Read it (it's an image file) before anything else: "this
   is misaligned" means nothing without it.
2. **Find the code.** `web.source` is the best hint — `template` (Angular, with the
   element's line), else `file`:`line`. It is captured from the framework's dev-mode
   internals and can be missing (production build, unknown framework) or point at
   the owning component rather than the exact markup. Without it, search for the
   element's text (`anchor.text`), its test id (`anchor.testid`), its classes, or the
   page's route (`page`) in the router config.
3. **Apply the change**, scoped to the thread, as for any thread.
4. **Verify with your own eyes** when the app is running (it usually is — the human
   just used it). Re-photograph the element with whichever of these exists:
   - `refiner web shot <thread-id>` (the refiner CLI), or
   - `node ~/.claude/skills/refine-web/scripts/cli.js shot <thread-id>` (the copy the
     Refiner extension installs next to the `refine-web` skill).

   Either reopens the page, re-finds the element and prints JSON with `status`
   (`exact` / `moved` / `lost`), the element's current `text`, and `shot` — a fresh
   PNG next to the original (`before`). Read both images and compare. A dev server
   with hot reload has picked your edit up by then; if the result says `lost`, the
   element is gone or the page didn't load — say so in the reply rather than claiming
   success. If neither tool is available, say in the reply that you could not verify
   visually.
5. **Reply** in the web thread. Mention which file you changed (the human is looking
   at the browser, not the code) and, if you verified it, that you did.

`refiner web list` / `node ~/.claude/skills/refine-web/scripts/cli.js list` prints one
JSON line per web thread (id, status, page, element, source, shot, last role) — a quick
way to survey them.

## Formatting the `body`

The extension renders `body` as **Markdown**; so does the browser overlay (paragraphs,
`code`, **bold**, lists, quotes, fenced blocks). Write your reply as well-formatted
prose, not a wall of text — the human reads it in a narrow bubble beside their code or
on a card over their app.

**`body` is a JSON string, so line breaks are `\n`.** A blank line between paragraphs
is `\n\n`. Getting this wrong is the most common mistake: it collapses your whole
reply into one run-on paragraph.

Use, where they genuinely help:

- **Paragraph breaks** (`\n\n`) — separate what you changed from why, and from any
  caveat. One idea per paragraph.
- **`` `code` ``** — every identifier, file path, flag, type, and literal value.
  Write `` `byFile` `` and `` `null` ``, never bare byFile or null.
- **Fenced code blocks** — when the change is subtle enough that the shape matters
  (a tricky condition, a new signature). Tag the language: ` ```ts `. Keep them to a
  few lines — the human sees the full diff in their editor, so don't paste it back.
- **Bullet lists** — when you touched several files or made several distinct changes
  under one thread.
- **Blockquotes** (`> `) — when quoting the human's own words back to confirm which
  part you're answering, or citing a rule you followed.
- **Bold** — sparingly, for the one phrase that matters most.

A well-formatted reply:

```json
{
  "body": "Replaced the linear scan in `resolveThread` with a lookup against the `byFile` index.\n\nThe old loop walked every thread on each keystroke; the index is built once in `load()`, so this is O(1) per lookup and the O(n²) you flagged is gone.\n\n[suggestion] `findComment` just below has the same pattern, but it's off the hot path — left it alone. Say the word and I'll do it too."
}
```

Don't over-format: a one-line reply to a `[nit]` needs no bullets and no code block.
Match the structure to the size of what you did.

## Prerequisites

1. Confirm you're inside a git repo: `git rev-parse --show-toplevel`.
2. Read `.refiner/comments.json` and `.refiner/web-comments.json` from the repo root
   (either may be missing). If neither has a thread, tell the user there's nothing to
   do and stop.

## Instructions

### Step 1 — Collect actionable threads

Parse both files. For each thread, decide whether to act:

| Condition | Action |
|---|---|
| `status` ≠ `"open"` | **Skip** (already resolved) |
| Last comment has `role: "assistant"` | **Skip** — you already replied; awaiting the human. |
| Last comment is a `[question]` you'd need the human to answer | **Skip and note** in the final summary. |
| Last comment has `role: "user"` with an actionable request | **Process** |
| Body starts with `[nit]` | **Process** — minor but actionable |

A `thread-id` argument overrides the loop — process only that thread (after the check).

### Step 2 — For each actionable thread, plan and apply the change

1. **Read the thread's full conversation**, not just the latest comment — earlier
   messages may carry context.
2. **Open the file at the thread's anchor** (`file`, `range.start`, `range.end`; the
   lines are 1-based). Read enough surrounding code — often the whole file. For a web
   thread, follow **Web threads** above instead: the picture first, then `web.source`.
3. **Interpret the request**:
   - Direct suggestion ("use a map instead of a slice") → make the change.
   - Question phrased as a suggestion ("should we add X?", "can we rename this?") →
     treat as a request, make the change.
   - Explicit `[question]` from the human → answer in your reply, no code change.
   - Truly unclear → reply asking for clarification (Step 4). Don't silently skip.
4. **Apply the change** with Edit. Stay scoped to the thread's intent — don't
   refactor neighbors or fix unrelated issues. If you spot something else, mention it
   in the reply but don't touch it.
5. **Verify**: run whatever fits (build, type check, tests; for a web thread, the
   screenshot in **Web threads** step 4). If your change breaks something, fix it. If
   it fails for a pre-existing reason, note it and move on.

### Step 3 — Append a reply comment to the thread

Edit the file the thread came from (`.refiner/comments.json` or
`.refiner/web-comments.json`) to append an `{ "role": "assistant", ... }` comment to
the thread you acted on. Do it in place — preserve every other thread and every
existing comment. The reply `body` should:
- State **what changed** (file + the gist).
- State **why it addresses the thread** (one sentence).
- Mention any related-but-out-of-scope thing as a `[suggestion]` for the human.

Format it per **Formatting the `body`** above — real paragraph breaks (`\n\n`),
identifiers in backticks, code blocks only where the shape matters.

After writing, re-read the file and confirm it's still valid JSON (no trailing
commas, balanced quotes). Invalid JSON makes the extension stop loading.

The extension picks your replies up by itself: the thread re-renders inline, and a
browser review window shows the reply on the card within a fraction of a second — the
pin turns green.

### Step 4 — When you can't proceed

If a thread is genuinely unclear, append a reply asking for what you need — a
specific question ("did you mean X or Y?"), not a guess. Then move to the next
thread. Do not invent intent.

### Step 5 — Hand off

Summarize for the user:

> Processed N threads:
> - Applied changes: A
> - Asked for clarification: B
> - Skipped (already replied / awaiting you): C
>
> Nothing was resolved or deleted — that's your call. In VSCode, verify each change
> and click ✓ (Resolve) on the threads you're happy with (inline, or in the **UI
> Threads** view; **✓ Resolve** on the card in the browser works too).

## Do NOT

- Do **not** change `status` on any thread. Leave it `"open"`.
- Do **not** delete any thread or comment — yours or the human's.
- Do **not** edit the human's comments, the `range`, `file`, `anchor` or `web` fields —
  the extension and the browser overlay re-anchor threads on their own.
- Do **not** batch unrelated changes under one thread's reply.
- Do **not** skip verification. If your change doesn't build/pass, fix it first.
- Do **not** leave the JSON invalid. Re-read your write and confirm it parses.
