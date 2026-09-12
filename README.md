# shyameet.github.io

A spoken journal. I talk into my phone, it files itself into a fixed set of sections,
and it is on the web a minute later. Plain markdown in, static site out — no database,
no CMS, no account.

Live at **https://shyameet.github.io**

## The sections

Fixed on purpose. Inventing a category every time is how you stop posting by Thursday.

| Section | For |
|---|---|
| **Daily** | The schedule, and how the day actually went |
| **Goals** | Anything pointed at where I am trying to get |
| **Feynman** | Learn it by explaining it back in plain words |
| **Wins** | What went well, for re-reading on a bad day |
| **Mistakes** | What went wrong — and what I will do instead |
| **Speaking** | Spoken sessions, thinking out loud |
| **Vocabulary** | Words and openers to actually use |
| **Blabber** | Everything else |

Sections live in `site.config.json`. Add, rename or reorder them there and the whole
site — nav strip, home board, editor buttons — follows. Renaming an `id` orphans
existing posts, so change `name` and leave `id` alone.

**Mistakes** carries a second field (`lessonLabel`), which renders as a callout at the
end of the post. The lesson is the part that stops it happening twice.

## Posting

**From the phone.** Open <https://shyameet.github.io/admin/>, pick a section, tap the
mic on the keyboard and talk. Hit Publish. Add it to the home screen once and it opens
like an app. The draft saves to the phone as you speak, so losing signal costs nothing.

**From the desk.** Drop a `.md` file into `content/posts/` and push. Same result. The
folder is plain markdown, so Obsidian can open it as a vault.

Filenames are `YYYY-MM-DD-HHmm-slug.md` — the time keeps two posts on one day from
colliding and makes the folder sort correctly.

## Frontmatter

```
---
title: "Optional — omit it for a quick untitled note"
date: 2026-09-12T10:30:00+05:30
section: mistakes
lesson: "Only used by sections that define lessonLabel"
tags: [quant, people]
draft: true      # optional; keeps the post off the site
---
```

Only `section` and `date` really matter, and both fall back sensibly — an unknown or
missing section lands in Blabber, and a missing date comes from the filename.

## Connecting the phone editor

The editor writes to this repo through the GitHub API using a token you create yourself.
It lives in your phone's local storage only — never in the site's source, never sent
anywhere but `api.github.com`.

1. <https://github.com/settings/personal-access-tokens/new>
2. Repository access -> **Only select repositories** -> `shyameet/shyameet.github.io`
3. Permissions -> Repository permissions -> **Contents: Read and write**. Nothing else.
4. Paste it into the gear tab of `/admin/`.

Scoped that way, a leaked token can edit this blog and nothing else. Revoke at
<https://github.com/settings/tokens> and paste a new one — takes a minute.

## Local development

```
npm install
npm run build      # writes dist/
npm run serve      # preview on http://localhost:4321
```

## How it fits together

```
content/posts/*.md   what you say
site.config.json     sections, title, tags -- the only config
src/build.mjs        the generator (one dependency: marked)
src/style.css        all the styling
src/app.js           theme toggle + client-side search
public/admin/        the phone editor (static; talks to the GitHub API)
.github/workflows/   push to main -> build -> GitHub Pages
```

The build generates the home board, section pages, per-post pages, tag pages, the
archive, `search.json` and `feed.xml` from the markdown. Nothing else is hand-maintained.

### One deliberate design note

Dates are formatted from the **literal clock time** in the frontmatter, never by
converting through a `Date` object. The build runs on a UTC runner: a post spoken at
00:30 IST would otherwise render as the previous day at 19:00. `Date` is used only for
sorting and for the RSS `pubDate`, where an absolute instant is what is wanted.
