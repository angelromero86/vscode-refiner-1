---
name: refine-web
description: Open a Chrome window on a running web app with Refiner's review overlay, so the human can pin review threads to UI elements (Figma-style) that /refine-resolve then works through
user-invocable: true
---

# refine-web skill

You are starting a **browser review session**: a Chrome window on the human's running
app with Refiner's overlay on top. In it the human presses `C`, clicks any element and
leaves a thread on it — like a comment in Figma, but anchored to the real DOM. Threads
persist across navigations and reloads, follow the element when the markup is
refactored, and are written to `.refiner/web-comments.json`, where `/refine-resolve`
picks them up and the **Refiner** VSCode extension lists them (panel **Refiner › UI
Threads**, and inline at the element's source file when the dev build revealed it).

No browser extension is involved: the session launches Chrome itself (with its own
profile per repo, under `~/.config/refiner/chrome/`) and injects the overlay over the
DevTools protocol. Two things can start it, and they are the same session on the same
file:

- the VSCode command **Refiner: Review UI in Browser…** (the human runs it; the
  session lives in that VSCode window, with a status bar item while it is open);
- the `refiner` CLI, if installed: `refiner web <url>`.

## Arguments

- `url` (required): the page to open. `localhost:4200`, `127.0.0.1:3000/settings` and
  full URLs all work. **If the human did not give one, ask for it** — don't guess a
  port. A quick look at `package.json` scripts or an `angular.json`/`vite.config.*`
  can tell you the usual dev port, so you can propose it in the question.

## Instructions

1. Confirm you're inside a git repo: `git rev-parse --show-toplevel`. Run everything
   below from that root.
2. Check that the app answers: `curl -sS -o /dev/null -w '%{http_code}' <url>`. If it
   doesn't, say the dev server seems to be down and ask whether to open it anyway.
3. Start the session:
   - If `command -v refiner` finds the CLI, start it **in the background** (it runs
     until the Chrome window is closed): `refiner web <url>`. Use your shell tool's
     background mode; don't wait on it in the foreground.
   - Otherwise, ask the human to run **Refiner: Review UI in Browser…** from the VSCode
     command palette and enter `<url>` — the extension launches Chrome and the
     overlay. Don't try to start a browser yourself.
4. Tell the human, briefly:

   > Chrome is open on `<url>` with the Refiner overlay.
   > - `C` → click any element to leave a thread (`↑` selects the parent, `esc` cancels)
   > - `shift+C` → every thread, on every page; click one to jump there
   > - Threads land in `.refiner/web-comments.json` and in VSCode's **UI Threads** view.
   >   When you're done, run `/refine-resolve` and I'll work through them; my replies
   >   show up live in the page.

5. If the CLI exits immediately, read its output. The usual causes:
   - *a refiner web session is already running for this repo* → there is already a
     window (maybe opened from VSCode); tell the human to use it, or close it and
     re-run.
   - *no Chrome/Chromium found* → `REFINER_CHROME=/path/to/browser refiner web <url>`
     (in VSCode: the `refiner.chromePath` setting).

## Do NOT

- Do **not** write to `.refiner/web-comments.json` from this skill. Threads come from
  the human, in the browser.
- Do **not** open the URL with Claude in Chrome or any other browser tool instead —
  the overlay only exists in the window the session launched.
