# Handoff — where the journal site stands (21 Oct 2026)

Written when the work moved from the laptop to the desktop (19 Oct), updated 21 Oct. Read this, then
`README.md` (how every part works), then `tools/test/README.md` (how to check a change).

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
- **21 Oct — Speak v2** (`/speak/`, `src/speak.js`, the helper in `tools/speakd/`, a card on Today).
  v1 (19 Oct) used live dictation and a private GitHub repo; the owner reported that the microphone
  stopped after the 30 s thinking time and that fixed rules were not real analysis. v2 records
  AUDIO (the tap opens the microphone; a level bar proves it is alive; warnings for a flat bar,
  muted / busy / blocked / unplugged, a Reconnect button, a microphone picker), hands each take to
  **speakd** on the PC (127.0.0.1:4777, started at login), which writes it out with Whisper medium
  (English + Hindi mixed, fillers kept, a time per word). Audio, words and notes stay in
  `C:\Users\shyam\SpeechJournal`; no GitHub, no token. The page shows facts (pace, fillers, pauses,
  first word, the transcript with fillers and pauses marked); the ADVICE is Claude's, written to
  `coaching/YYYY-MM-DD.md` after reading the output of `tools/speakd/review_pack.py`.
  Open it at `http://localhost:4777/speak/` (the helper serves the page too, so no browser rule
  about a public page reaching a local program can block it; the https page may be blocked, and then
  links there). README → *Speak* has the whole design.
- **24 Oct — installing as an app** (README → *Installing as an app*). He could not install the site
  on his tablet (model and browser not yet known). A real headless Chrome reported NO installability
  errors on the live site before or after the change, so it is specific to his tablet/browser.
  Added `/install/` (steps for Android Chrome, Samsung Internet, iPad Safari, desktop, plus an
  Install button where the browser allows), a footer link, Apple meta tags, manifest id/scope/maskable
  icons, a service-worker fetch handler. His tablet is an Android tablet in Chrome with a stale,
  unopenable earlier install ("could not open app" / "already installed", nothing in Settings → Apps).
  Fixed by giving the manifest a NEW `id` (`/journal-app-2`); it installed fine after that. Do not
  change `id` again casually: a new id makes Chrome treat it as a different app.
- **21 Oct — sign-in keeper** (top of `src/app.js`, and the Write page): asks the browser to keep
  the site's storage, mirrors the sign-in into IndexedDB and puts it back once per tab if
  localStorage lost it; signing out on purpose clears both. Why: "not connected" kept coming back
  on his Windows Chrome. The real cause is not proven; if it persists, check Chrome → Settings →
  Privacy → *Clear cookies and site data when you close all windows* (add shyameet.github.io to
  the allowed list).

## Still open

- **Speak: a real talk on the real microphone** is the first thing to check. The pipeline was
  tested with a fake microphone and a spoken test clip; Hinglish accuracy is untested.
- **Speak from the tablet works through an ENCRYPTED branch of the journal repo** (24 Oct; built, tested,
  not yet run on the real tablet). The owner refused any GitHub setup ("I'm not going to waste my time"),
  so there is none: files go to the `speech-drop` branch of this repo with the journal's own sign-in,
  locked with a key made from that sign-in (README → *From the tablet (the drop box)* has the design). The
  one thing that must happen on the PC: a **signed-in page on the Windows PC hands the helper the key**
  (automatic; open the journal on the PC once). Check with `curl localhost:4777/health`: `dropbox.has_key`
  must be true and `last_error` empty. The private repo `shyameet/speech-log` he made is now unused and
  holds plain copies of his first two takes and note (the helper pushed them before the redesign); he
  can delete it (GitHub → the repo → Settings → Delete). Not done: audio replay and instant delete on the
  tablet.
- **The timer did not sync with the tablet because the tablet was never signed in** (24 Oct: every
  `timer:` commit on the `sync` branch said "Windows PC", none from the tablet). Cross-device timer sync
  was re-tested with two signed-in devices and works both ways. Added a banner "This device is not signed
  in" on every page (not Write, not the helper's own address). He forgot the password he set on 11 Oct: use
  Write → ⚙ → *Copy connect link* on a signed-in device, open it on the tablet, then set a new password.
- **Speak, ideas and tasks by voice:** the one-button capture that files a spoken idea or task for
  him (instead of choosing a section) is not built; Free talk stores a talk like any other.
- **Scheduled tasks on this PC** (they run while the Claude app is open): `speech-nightly-review`
  (~22:08, follows `tools/speakd/REVIEW.md`) and `speech-evening-nudge` (~20:44, one push notification
  if no take exists today). The first real review was written by hand on 22 Oct
  (`SpeechJournal\coaching\2026-10-22.md`): his habit is starting half his sentences with "So"/"And"
  (7 of 14), he gives reasons before the answer, and he said no "um" that Whisper caught.
- **Helps him improve (22 Oct):** a shape per topic kind while thinking and talking, *Same topic again*,
  the "So / And starters" chip, and a "How to get better, fast" card on the page.
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
  site's files never go into any other repo. Speech audio and transcripts never go in any repo.

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
- A microphone started by a timer with no tap is not reliable in Chrome: open it in the tap.
- Whisper invents text over silence or noise (the hint repeated, or "Thanks for watching!"): keep VAD
  on and `keep_segment`; re-check with a tone through `try_whisper.py` after any change to the settings.
- faster-whisper 1.2.1 needs `av==16.0.1` (av 19 breaks decoding); see `tools/speakd/requirements.txt`.
- "I saved a take but it is not in the folder": read `C:\Users\shyam\SpeechJournal\speakd.log` (every
  write and every failed request is logged) and the saved screen (it now says why a send failed).
- Dictation (SpeechRecognition) is no longer used anywhere: it drops "um" and "uh" and gives no
  pauses; do not bring it back as the source of the words.
