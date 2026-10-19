# Handoff — where the journal site stands (19 Oct 2026)

Written when the work moved from the laptop to the desktop. Read this, then `README.md`
(how every part works), then `tools/test/README.md` (how to check a change).

## What is live

- **Site:** <https://shyameet.github.io>, built from `main` by the *build & deploy* workflow.
- **7 Oct — one set of data across devices.** The running focus timer is shared
  (`focus-run.json` on the `sync` branch); focus blocks merge by id into `content/focus/`;
  the header lamp shows whether a browser is signed in and in step.
- **8 Oct — Tasks** (`/tasks/` and a card on Today; `src/todo.js`). Today / Upcoming / Done,
  said-or-typed tasks with day, time and repeat, an editor sheet, reminders that ring in the
  page (bell, banner, nudges, 20:00 check-in, quiet hours) and optional **phone alerts via
  ntfy** for when the site is closed. The list is `todos.json` on `sync` (no deploy per tick).
- **8 Oct — the lamp panel** (tap the header dot): signed in?, this page's version against
  the newest, when ticks / focus / tasks last agreed with the repo, *Refresh now*, a name
  for the device. The footer shows the page's version; a newer build shows a button that stays.
- **11 Oct — sign in with a password.** Write → ⚙ on a signed-in browser sets it; the token is
  kept locked with it in `public/admin/vault.json` (AES-256-GCM, PBKDF2-SHA256 600,000 rounds),
  and a new browser opens Write on *Sign in*. The password was set on 11 Oct; since then the
  devices save normally (by 19 Oct: 51 focus blocks, tasks, a journal entry).

- **19 Oct — Speak** (`/speak/`, `src/speak.js`, a card on Today). Random topic or free talk, a
  thinking timer, a speaking timer, dictation, and a read-out (pace, fillers, restarts, first
  word, topic words, tips). Takes are saved as TEXT to a **private** repo, `shyameet/speech-log`
  (`takes/YYYY-MM-DD.json`), through the owner's own token; a take waits in the browser's queue
  until it can be sent. See README → *Speak*. Tested against the fake GitHub (race, no access,
  offline, delete, typed fallback, blocked mic, phone width) and 92 unit checks; **not yet run
  against the real private repo or a real microphone**, because the repo has to be made by the
  owner (see below).

## Still open

- **Speak needs the owner's two steps:** create the **private** repo `shyameet/speech-log` on
  GitHub (tick *Add a README*), then add it to the journal's fine-grained token (Repository
  access, Contents: Read and write). Until then the page says "cannot see the private repo" and
  takes wait on the device. Then one real take from the phone confirms it end to end.
- **Speak phase 2 (not built):** record audio and transcribe with Whisper on a private machine,
  to catch the "um"/"uh" that browser dictation drops and to measure pauses. Audio must never go
  in a public repo; delete it after transcribing unless the owner wants it kept.
- **Speak phase 3 (not built):** a nightly job that reads the day's takes and writes
  `coaching/YYYY-MM-DD.md` in the private repo (the page already shows the newest), naming the
  top habits and one drill for tomorrow; plus an evening nudge if nothing was spoken.
- **Speak, ideas and tasks by voice:** the one-button capture that files a spoken idea or task
  for him (instead of choosing a section) is not built; Free talk only stores the text.

- **Phone alerts** are built but not known to be set up: install ntfy, subscribe to the topic
  shown under Tasks → *Reminders & phone alerts*, press *Send a test*. No session has ever sent
  anything to the real ntfy.sh — the owner's test is the first real one.
- **Offered, not built:** unfinished Write drafts following you between devices (they would
  have to be encrypted with the same password — the repo is public).
- **Asked, never answered:** Sunday's "guild thing"; a Sunday weekly review, an Ideas
  section, or auto-ticking the 7 focus hours; whether to keep the shloka on the empty Write page.

## How the owner wants the work done

- Commit as `git -c user.name=Shyam -c user.email=shyameet2@gmail.com …` (including
  `pull --rebase`), push after every commit, and `git pull --rebase origin main` first —
  the phone, the timer and the nightly job all commit to this repo.
- Check before deploying (`npm run build && npm run check`, `tools/test/`), watch the deploy,
  then look at the live site. Say plainly what was and was not tested.
- Posts stay as spoken, never tidied. Scripture is never typed from memory. No personal
  name on the site. Only public-domain or openly licensed images.
- Never ask for, paste or reuse a GitHub token; never put a broad token in the vault; this
  site's files never go into any other repo.

## Traps already met

- The working tree has CRLF line endings: normalise them before splicing text by a marker
  (a splice once cut `style.css` mid-rule and dropped half the stylesheet).
- `/admin/#setup` and `/admin/#signin` are handled by script, not by an element id, so a
  static `<a>` to them fails `npm run check`; build such links in JS.
- On a desk, Chrome opens a date/time picker only from its icon: keep the inputs visible and
  call `showPicker()` on click (the first Tasks chips hid them, so they did nothing).
- One row wider than a phone pushes `innerWidth` past the screen and every fixed element
  overflows with it — check `document.documentElement.scrollWidth` at 375 px.
- In `todos.json`, `ps`/`pt` (what is on the phone for a task) merge by `pt`, not `mod`;
  merging them by content made a cleared record reappear and cancels repeat forever.
- GitHub Pages lets browsers keep HTML for 10 minutes; pages reload themselves when
  `/build.json` is newer (or show the staying button while in use).
