# Testing the site

Nothing here is published; it is for checking a change before it goes live.

## Unit tests (no browser)

```
node tools/test/test_todo.mjs
```

124 checks on `src/todo.js`: what a spoken phrase becomes ("call the bank at 5 pm tomorrow",
"gym every weekday at 7"), the next day of a repeating task, how two devices' lists merge,
which version of a task belongs on the phone, and what should ring when. It loads the real
file in a VM through the `window.__todoTest` hook. Run it after any change to `todo.js`.

```
node tools/test/test_speak.mjs
```

106 checks on `src/speak.js`: the filler count (and the phrases it must not flag), words a
minute, restarts, topic words, the pauses between timed words, the marked transcript, the
coaching note's markup, streaks, and the choice of a random topic. Same method as above (`window.__speakTest`).

## Several devices in one browser

1. `node tools/test/fake_gh.mjs` — a fake GitHub on :4400 (contents API with real 409/422/304
   behaviour, git refs, file deletes), plus fakes of `raw.githubusercontent.com` (`/raw/...`)
   and `ntfy.sh` (`/ntfy/...`). It seeds from `content/`. Controls: `GET /__state`, `/__log`,
   `/__ntfy`; `POST /__reset`, `/__offline?on=1`, `/__delay?ms=600`, `/__fail?n=2`.
2. `npm run build`, then make test copies of the pages you need (the build wipes `dist/`, so
   again after every build):
   `python tools/test/mk_dev.py tasks/index.html _t_tasks.html`
   `python tools/test/mk_dev.py index.html _t_home.html`
   `python tools/test/mk_dev.py admin/index.html admin/_t_admin.html`
3. Serve `dist/` (`node src/serve.mjs`, port 4321) and open the copies on different origins —
   `localhost`, `127.0.0.1`, `[::1]` — each one a separate device with its own storage.
   Query: `fresh=1` wipes that origin once per tab session, `token=0` is a browser that is not
   signed in, `off=600000` a device clock 10 minutes fast, `ua=iphone`.

Traps met in the Claude browser pane: it blocks `127.0.0.2`; it reports every tab as hidden
(the stub forces `visibilityState`, or the site never polls); its simulated keys cannot type
into native date/time inputs (set `.value` and dispatch `input`/`change`); screenshots time
out while the window is hidden. A race needs the other device's write to land BETWEEN the
page's read and its write — the page waits ~600 ms before saving.

The Speak page needs a fake microphone and the helper. `mk_dev.py` copies take
`mic=tone` (a WebAudio tone as a real MediaStream, so the level bar moves and MediaRecorder
records something), `mic=silent`, `mic=deny`, `mic=none`, `mic=busy`, `lostms=3000` (unplugged
that long after opening) and `devices=2` (two microphones to pick from):
`python tools/test/mk_dev.py speak/index.html _t_speak.html`, then open
`/_t_speak.html?mic=tone`. Run the helper against a scratch folder with the stand-in for Whisper:
`python tools/speakd/speakd.py --fake --data <scratch dir>` (the stand-in answers every take with a
fixed sentence, a 1.7 s pause after the third word, so the highlighting can be checked). In the
page, `localStorage.speak_pref_v1 = '{"think":3,"target":6,"mode":"topic"}'` gives a 3 s think and
a 6 s talk instead of waiting a minute. The helper's own tests need no model:
`python tools/speakd/test_speakd.py` (22 tests: the origin and host guards, saving, transcribing,
restarts, a broken day file, deleting, concurrent takes).

Never point these at the real repo or at the real data folder. `fake_gh.mjs` accepts any token.
