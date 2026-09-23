# shyameet.github.io

A spoken journal and a habit tracker in one. I talk into my phone, it files itself into a
fixed set of sections, and it is on the web a minute later. Plain markdown in, static
site out — no database, no CMS, no account.

Live at **https://shyameet.github.io**

## The pages

| Page | What it is |
|---|---|
| **Today** (`/`) | The date, the day's deity and mantra, the week as rings, today's habits (tappable), focus so far, this week's list, the latest entries |
| **Habits** (`/habits/`) | The week as a grid — tap any circle to tick a day, past ones too — plus four weeks per habit and focus hours per day |
| **Focus** (`/focus/`) | A block timer with an alarm, and the day's focused time |
| **Journal** (`/journal/`) | The ten sections as tiles, and the latest entries |
| **Darshan** (`/darshan/`) | All seven medallions, one per weekday |
| **Write** (`/admin/`) | The phone editor |

A phone gets a bottom tab bar (Today · Habits · Focus · Journal · Write); a desk gets the
same links along the top.

## The sections

Fixed on purpose. Inventing a category every time is how you stop posting by Thursday.

| Section | For |
|---|---|
| **Day Tasks** | One page per day, made at 05:00 with the routine on it |
| **Week Tasks** | The week's list, re-read on Sunday |
| **Daily** | The schedule, and how the day actually went |
| **Goals** | Anything pointed at where I am trying to get |
| **Feynman** | Learn it by explaining it back in plain words |
| **Wins** | What went well, for re-reading on a bad day |
| **Mistakes** | What went wrong — and what I will do instead |
| **Speaking** | Spoken sessions, thinking out loud |
| **Vocabulary** | Words and openers to actually use |
| **Blabber** | Everything else |

Sections live in `site.config.json`. Add, rename or reorder them there and the whole
site — tiles, chips, editor buttons — follows. Renaming an `id` orphans existing posts,
so change `name` and leave `id` alone.

**Mistakes** carries a second field (`lessonLabel`), which renders as a callout at the
end of the post. The lesson is the part that stops it happening twice.

Sections marked `"tasks": true` count `- [ ]` / `- [x]` lines. The editor gets a button
that inserts a task line, since you cannot dictate square brackets.

Checkboxes and habit circles are **tappable on the live site**, but only for whoever holds
the token. `/admin/` and the site share an origin, so any page can read the token out of
local storage; if one is there, ticking rewrites the markdown and commits it. Each box
carries its task's text, and the write finds the line **by that text**, not by position —
so it still hits the right line after the page was edited elsewhere. With no token the
boxes stay `disabled`, so a visitor never sees a control that would fail.

**Word sprint**, under the Speaking section: `wordSprint: true` on a section shows a
New word / countdown / Talk panel, drawn from `public/admin/words.json` via a shuffle bag
in local storage (no repeat until the list has gone round once).

## Habits

The routine is `routine` in `site.config.json` — plain names, or `{ "name": "Gym",
"target": 5 }` for something counted per week instead of daily. `weeklyRoutine` fills
the Monday week page. The newday workflow writes each day's page at 05:00 IST and
redeploys, so the site turns over to the new day on its own.

The grid marks a past unticked day as missed and says so; a daily habit shows its streak,
a targeted one shows how many it still needs this week.

## Focus

`/focus/`: pick a length (the presets in `focus.presets`, or Custom), Start. Pause, +5
min, or Stop & log. When a block ends: a temple bell (synthesised — there is no sound
file), a notification with an *Another block* button, a vibration on phones, and a
flashing tab title. Space starts and pauses.

- **Timing never counts ticks.** A block is a start time and a length; the clock is
  recomputed from `Date.now()`, so a background tab or a sleeping laptop cannot make it
  drift. The tick comes from a Worker, because browsers slow a hidden tab's own timers
  to about once a minute. A block that finished while the page was closed is logged
  when the page next opens.
- **Where blocks go.** Local storage first, always. Then — if the browser holds the token —
  `content/focus/YYYY-MM-DD.json`, merged by block id, so the phone and the desk add up
  to one total. A write that races another device (409) refetches and merges again.
  Offline, blocks wait on the device and go up next time.
- **Where the total shows.** Live on `/focus/` and on Today's focus card; per day on the
  Habits grid and on each day page, with a timeline of the blocks.
- The daily target is `focus.dailyTargetHours`.
- On iPhone a web page cannot ring in the background: keep the page open (the *keep the
  screen on* switch helps), or add the site to the Home Screen for notifications.

`src/sw.js` is the smallest service worker that makes those notifications work (Android
refuses the plain `Notification` constructor). It has no fetch handler and caches nothing.

## The medallions

`deities` in `site.config.json` pairs each weekday with a deity and a mantra:
Ravivar Surya, Somvar Shiva, Mangalvar Hanuman, Budhvar Ganesha, Guruvar Vishnu,
Shukravar Kali Mata, Shanivar Kal Bhairav. Change the pairing there.

The art is drawn in code by `src/make_art.py` into `src/art/<id>.svg` — symbols, not
faces: the trishul and damaru over Kailash, the conch, namam, chakra and lotus, the gada
and the tail, Ganesha's crown and single tusk, the khadga in a ring of fire with a jaba flower,
Bhairav's dog at the foot of the trishul. Line art in one ink plus an accent, so every
medallion follows the light/dark theme. `src/make_icons.py` renders the Om app icons.

## Posting

**From the phone.** Open <https://shyameet.github.io/admin/>, pick a section, hit
**Talk** and speak. Dictation is built into the editor via the Web Speech API and
restarts itself on every pause, so thinking mid-sentence does not end the session.
Language is `speechLang` in `site.config.json` (default `en-IN`). Hit Publish. Add it to
the home screen once and it opens like an app. The draft saves to the phone as you speak,
so losing signal costs nothing.

**From the desk.** Drop a `.md` file into `content/posts/` and push. Same result. The
folder is plain markdown, so Obsidian can open it as a vault.

Filenames are `YYYY-MM-DD-HHmm-slug.md` — the time keeps two posts on one day from
colliding and makes the folder sort correctly.

## Frontmatter

```
---
title: "Optional — omit it for a quick untitled note"
date: 2026-09-12T10:30:00+05:30
day: 2026-09-11   # optional: the day this is ABOUT, when it was filed later
section: mistakes
lesson: "Only used by sections that define lessonLabel"
tags: [quant, people]
draft: true      # optional; keeps the post off the site
---
```

Only `section` and `date` really matter, and both fall back sensibly — an unknown or
missing section lands in Blabber, and a missing date comes from the filename. `day`
puts the post on that day's page and marks it "about Tuesday 22 September".

A post can end with the raw transcript, folded away:

```
<details class="asspoken">
<summary>As spoken</summary>
<div class="raw">exactly what was said, one paragraph, no blank lines</div>
</details>
```

## Connecting the phone editor

The editor writes to this repo through the GitHub API using a token you create yourself.
It lives in the browser's local storage only — never in the site's source, never sent
anywhere but `api.github.com`. Connect once per browser (phone, desk) that should tick
habits or save focus blocks.

1. <https://github.com/settings/personal-access-tokens/new>
2. Repository access -> **Only select repositories** -> `shyameet/shyameet.github.io`
3. Permissions -> Repository permissions -> **Contents: Read and write**. Nothing else.
4. Paste it into the gear tab of `/admin/`.

Scoped that way, a leaked token can edit this journal and nothing else. Revoke at
<https://github.com/settings/tokens> and paste a new one — takes a minute.

## Local development

```
npm install
npm run build      # writes dist/
npm run serve      # preview on http://localhost:4321
```

`BUILD_TODAY=2026-09-23 npm run build` builds the site as it looks on a given morning.

## How it fits together

```
content/posts/*.md      what you say (and the day pages)
content/focus/*.json    focus blocks, one file per day, written by /focus/
site.config.json        sections, routine, focus, deities -- the only config
src/build.mjs           the generator (one dependency: marked)
src/style.css           all the styling
src/app.js              theme, tappable tasks, search
src/focus.js            the timer, and the live focus total
src/sw.js               notifications for the timer
src/art/*.svg           the medallions (made by src/make_art.py)
src/newday.mjs          makes the day's page (run by .github/workflows/newday.yml)
public/admin/           the phone editor (static; talks to the GitHub API)
.github/workflows/      push to main -> build -> GitHub Pages
```

### One deliberate design note

Dates are formatted from the **literal clock time** in the frontmatter, never by
converting through a `Date` object. The build runs on a UTC runner: a post spoken at
00:30 IST would otherwise render as the previous day at 19:00. `Date` is used only for
sorting and for the RSS `pubDate`, where an absolute instant is what is wanted. "Today"
is the date in `timezone` at build time.
