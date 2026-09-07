# shyameet.github.io

A personal journal — trading notes, half-formed ideas, whatever the day handed me.
Plain markdown in, static site out. No database, no CMS, no account.

Live at **https://shyameet.github.io**

## Posting

**From the phone.** Open <https://shyameet.github.io/admin/>, type, hit Publish.
Add it to the home screen once and it opens like an app. The draft saves itself to the
phone as you type, so losing signal mid-thought costs nothing — publish again later.

**From the desk.** Drop a `.md` file into `content/posts/` and push. Same result.
The folder is plain markdown, so Obsidian can open it as a vault if that is easier.

Filenames are `YYYY-MM-DD-HHmm-slug.md` — the time keeps two posts on one day from
colliding and makes the folder sort correctly.

## Frontmatter

```
---
title: "Optional — omit it for a quick untitled note"
date: 2026-09-07T10:30:00+05:30
tags: [trading, idea]
draft: true      # optional; keeps the post off the site
---
```

Only `date` really matters, and even that falls back to the date in the filename.

## Connecting the phone editor

The editor writes to this repo through the GitHub API using a token you create yourself.
It lives in your phone's local storage only — it is never in the site's source and never
sent anywhere but `api.github.com`.

1. <https://github.com/settings/personal-access-tokens/new>
2. Repository access → **Only select repositories** → `shyameet/shyameet.github.io`
3. Permissions → Repository permissions → **Contents: Read and write**. Nothing else.
4. Paste it into the ⚙ tab of `/admin/`.

Scoped that way, a leaked token can edit this blog and nothing else. Revoke it at
<https://github.com/settings/tokens> and paste a new one — takes a minute.

## Local development

```bash
npm install
npm run build      # writes dist/
npm run serve      # preview on http://localhost:4321
```

## How it fits together

```
content/posts/*.md   what you write
src/build.mjs        the generator (~250 lines, one dependency: marked)
src/style.css        all the styling
src/app.js           theme toggle + client-side search
public/admin/        the phone editor (static; talks to the GitHub API)
public/              icons, manifests — copied to dist/ verbatim
.github/workflows/   push to main -> build -> GitHub Pages
```

The build generates the feed, per-post pages, tag pages, the archive, `search.json`
and `feed.xml` from the markdown. Nothing else is hand-maintained.

### One deliberate design note

Dates are formatted from the **literal clock time** in the frontmatter, never by
converting through a `Date` object. The build runs on a UTC runner: a post written at
00:30 IST would otherwise render as the previous day at 19:00. `Date` is used only for
sorting and for the RSS `pubDate`, where an absolute instant is what's wanted.

## Changing things

`site.config.json` holds the title, tagline, author, repo, posts-per-page and the
quick-tag chips that show up in the editor. That is the only place any of it is set.
