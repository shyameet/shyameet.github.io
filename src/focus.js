/* Focus: a block timer, and a running total of focused time.

   Two jobs, one file:
   1. On /focus/ -- the timer. Presets or a custom length, pause, +5, and an
      alarm when a block ends: a bell, a notification, a vibration, a flashing
      tab title. Every finished (or stopped) block goes into the log.
   2. On any page with [data-focus-card] -- keep "Focus today" live.

   What is shared between devices, and how
   ---------------------------------------
   Everything lives in the repo, so a block follows him from phone to laptop:

   - The LOG of finished blocks: content/focus/YYYY-MM-DD.json on main, merged by
     block id, so every device adds up to one total. localStorage holds the same
     log first (instant, offline) and anything not yet uploaded.
   - The RUNNING block -- started, paused, resumed, extended, stopped -- is
     focus-run.json on a branch called "sync". Start it on the phone, pause it,
     resume it on the laptop: both show the same clock. It sits on its own branch
     so that a pause does not trigger a deploy of the whole site.
   - Whoever finds a block that has run out (any device that is open, or the next
     one to open) logs it, with the time it REALLY ended -- not the time somebody
     happened to open the page.

   A device that has no token cannot write, so it stays local and says so. Each
   device keeps its own sound / screen-on / block-length choices.

   Timing never counts ticks. A block is a start time plus a length, and the
   clock is recomputed from the time -- so a throttled background tab, a
   sleeping laptop or a closed page cannot make it drift. The time is the
   server's, not the device's (the offset is measured against the site itself),
   so two devices whose clocks disagree still show the same minutes left. The
   tick comes from a Worker, because browsers slow a hidden tab's own timers to
   about once a minute and the bell would ring late. */
(function () {
  'use strict';

  var dataEl = document.getElementById('focusdata');
  if (!dataEl) return;
  var DATA = {};
  try { DATA = JSON.parse(dataEl.textContent) || {}; } catch (e) { DATA = {}; }

  var LS_SESSIONS = 'focus_sessions_v1';
  var LS_RUN = 'focus_running_v1';
  var LS_META = 'focus_runmeta_v1';
  var LS_PREFS = 'focus_prefs_v1';
  var LS_GONE = 'focus_deleted_v1';
  var RUN_PATH = 'focus-run.json';
  var SYNC_BRANCH = DATA.syncBranch || 'sync';

  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function save(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  var token = '';
  try { token = localStorage.getItem('gh_token') || ''; } catch (e) {}
  var canSync = function () { return !!(token && DATA.repo); };

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /* wall-clock time with the device's offset baked in, like the posts */
  function localIso(ms) {
    var d = new Date(ms);
    var off = -d.getTimezoneOffset();
    return dayKey(ms) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      + (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
  }
  function clockText(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }
  function dur(sec) {
    var m = Math.round((sec || 0) / 60);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + pad(m % 60) + 'm' : '');
  }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- the clock ----------
     "Now" is the server's now: the device's clock plus a measured offset. */
  var skew = 0;
  var nowMs = function () { return Date.now() + skew; };
  var today = function () { return dayKey(nowMs()); };
  function measureSkew() {
    var t0 = Date.now();
    return fetch('/build.json?t=' + t0, { cache: 'no-store' }).then(function (r) {
      var t1 = Date.now();
      var d = Date.parse(r.headers.get('date'));
      var age = +r.headers.get('age') || 0;
      if (isNaN(d) || age > 5) return;
      /* the header has whole seconds; the middle of the request is the best guess */
      var s = Math.round(d + 500 + age * 1000 - (t0 + t1) / 2);
      skew = (Math.abs(s) < 2000 || Math.abs(s) > 6 * 3600 * 1000) ? 0 : s;
    }).catch(function () {});
  }

  /* what to call this device when another one shows the block */
  var DEV = (function () {
    var ua = navigator.userAgent || '';
    var touch = navigator.maxTouchPoints > 1;
    var kind = /iPhone/.test(ua) ? 'iPhone'
      : (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) ? 'iPad'
        : /Android/.test(ua) ? 'Android phone'
          : /Windows/.test(ua) ? 'Windows PC'
            : /Macintosh/.test(ua) ? 'Mac'
              : /Linux|X11/.test(ua) ? 'Linux PC' : 'another device';
    var app = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
    return kind + (app ? ' app' : '');
  })();

  /* ---------- the log ----------
     a session: { id, start, end (ms), sec (focused seconds), day, synced, syncedAt }
     Its day is the day it ENDED: a block that ran across midnight, or sat paused
     overnight, counts where it was finished. */
  var sessions = load(LS_SESSIONS, []);
  var gone = load(LS_GONE, []);            // [{id, day}] deleted here, not yet in the repo
  var remote = {};                          // day -> sessions as the repo has them

  function fromRepo(s, day) {
    var a = Date.parse(s && s.start);
    if (!s || !s.id || isNaN(a) || !(+s.sec > 0)) return null;
    var b = Date.parse(s.end);
    var end = isNaN(b) ? a + s.sec * 1000 : b;
    return { id: s.id, start: a, end: end, sec: +s.sec, day: day || dayKey(end), synced: true };
  }
  function toRepo(s) {
    return { id: s.id, start: localIso(s.start), end: localIso(s.end), sec: Math.round(s.sec) };
  }
  /* what the build already knew about its "today" */
  if (DATA.today && Array.isArray(DATA.sessions)) {
    remote[DATA.today] = DATA.sessions.map(function (s) { return fromRepo(s, DATA.today); }).filter(Boolean);
  }

  function persist() {
    var cutoff = Date.now() - 60 * 864e5;               // keep two months on the device
    sessions = sessions.filter(function (s) { return s.end > cutoff || !s.synced; });
    save(LS_SESSIONS, sessions);
    save(LS_GONE, gone);
  }

  function dayList(day) {
    var byId = {};
    (remote[day] || []).forEach(function (s) { byId[s.id] = s; });
    sessions.forEach(function (s) { if (s.day === day) byId[s.id] = s; });
    var goneIds = gone.map(function (g) { return g.id; });
    return Object.keys(byId).map(function (k) { return byId[k]; })
      .filter(function (s) { return goneIds.indexOf(s.id) < 0; })
      .sort(function (a, b) { return a.end - b.end; });
  }
  var sumSec = function (list) { return list.reduce(function (t, s) { return t + s.sec; }, 0); };

  /* A day this device has read from the repo: that list, plus anything logged here
     that has not reached it yet. Otherwise the build's total for the day. */
  function secOn(day) {
    if (day === today() || remote[day]) return sumSec(dayList(day));
    var base = (DATA.days && DATA.days[day] && DATA.days[day].sec) || 0;
    return base + sumSec(sessions.filter(function (s) { return s.day === day && !s.synced; }));
  }

  /* the repo's list for a day, taken as the truth: a block this device thought was
     saved but the repo no longer has was deleted on another device */
  function reconcile(day, list) {
    var seen = {};
    remote[day] = list.map(function (s) { return fromRepo(s, day); }).filter(Boolean);
    remote[day].forEach(function (s) { seen[s.id] = 1; });
    var now = Date.now();
    sessions = sessions.filter(function (s) {
      /* give a fresh upload two minutes to be visible to a read that may be stale */
      return !(s.day === day && s.synced && !seen[s.id] && now - (s.syncedAt || 0) > 120000);
    });
    persist();
  }

  /* ---------- the repo ---------- */
  function b64decode(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  var backoffUntil = 0;
  function api(method, url, body, etag) {
    var headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (etag) headers['If-None-Match'] = etag;
    return fetch(url, {
      method: method,
      cache: 'no-store',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 304) return { notModified: true, etag: etag };
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((data && data.message) || ('HTTP ' + r.status));
          err.status = r.status;
          /* out of requests: stop asking for a minute rather than make it worse */
          if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) {
            backoffUntil = Date.now() + 60000;
          }
          throw err;
        }
        if (data && typeof data === 'object') data.__etag = r.headers.get('etag');
        return data;
      });
    }, function (e) {
      var err = new Error('No connection');
      err.offline = true;
      throw err;
    });
  }
  var base = function () { return 'https://api.github.com/repos/' + DATA.repo; };
  var fileUrl = function (day) { return base() + '/contents/content/focus/' + day + '.json'; };
  /* A read for looking (useEtag) asks "has it changed?" and is answered 304 -- which
     GitHub does not count against the hourly allowance -- when it has not. A read
     before a write must be the whole file, for its sha. */
  var dayEtag = {};
  function getDay(day, useEtag) {
    return api('GET', fileUrl(day) + '?ref=' + encodeURIComponent(DATA.branch || 'main'), null, useEtag ? dayEtag[day] : null)
      .then(function (file) {
        if (file.notModified) return { same: true };
        if (useEtag) dayEtag[day] = file.__etag || null;
        var list = [];
        try { list = (JSON.parse(b64decode(file.content)).sessions || []); } catch (e) { list = []; }
        return { sha: file.sha, list: list };
      })
      .catch(function (err) {
        if (err.status === 404) { if (useEtag) dayEtag[day] = null; return { sha: null, list: [] }; }
        throw err;
      });
  }

  var chain = Promise.resolve();
  var syncState = token ? 'ok' : 'local';
  var lastSyncAt = 0;
  function setSync(st) {
    syncState = st;
    if (st === 'ok') lastSyncAt = Date.now();
    if (window.__rdx) window.__rdx.mark('focus', st === 'syncing' ? 'ok' : st);
  }

  /* Merge this device's blocks for one day into the repo's file, one write at
     a time. A 409 means another device wrote in between: fetch and merge again.
     Only blocks this device has not uploaded yet are added; one that was uploaded
     and has since vanished from the file was deleted somewhere else, and stays
     deleted. */
  function syncDay(day) {
    if (!canSync()) { setSync('local'); renderSync(); return Promise.resolve(false); }
    var attempt = function (triesLeft) {
      return getDay(day).then(function (got) {
        var byId = {};
        got.list.forEach(function (s) { if (s && s.id) byId[s.id] = s; });
        var inRepo = {};
        Object.keys(byId).forEach(function (k) { inRepo[k] = 1; });
        var addedSec = 0;
        var removed = 0;
        sessions.forEach(function (s) {
          if (s.day === day && !s.synced && !byId[s.id]) { byId[s.id] = toRepo(s); addedSec += s.sec; }
        });
        gone.forEach(function (g) {
          if (g.day === day && byId[g.id]) { delete byId[g.id]; removed++; }
        });
        var list = Object.keys(byId).map(function (k) { return byId[k]; })
          .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
        var finish = function () {
          var now = Date.now();
          remote[day] = list.map(function (s) { return fromRepo(s, day); }).filter(Boolean);
          sessions.forEach(function (s) {
            if (s.day === day && !s.synced) { s.synced = true; s.syncedAt = now; }
          });
          sessions = sessions.filter(function (s) {
            return !(s.day === day && s.synced && !byId[s.id] && now - (s.syncedAt || 0) > 120000);
          });
          gone = gone.filter(function (g) { return g.day !== day; });
          persist();
          setSync('ok');
          return true;
        };
        if (!addedSec && !removed) return finish();
        var total = list.reduce(function (t, s) { return t + (+s.sec || 0); }, 0);
        var body = {
          message: 'focus: ' + (addedSec ? '+' + dur(addedSec) : 'removed a block') + ' · ' + dur(total) + ' on ' + day,
          content: b64encode(JSON.stringify({ date: day, sessions: list }, null, 1) + '\n'),
          branch: DATA.branch || 'main'
        };
        if (got.sha) body.sha = got.sha;
        return api('PUT', fileUrl(day), body).then(finish, function (err) {
          if ((err.status === 409 || err.status === 422) && triesLeft > 0) return attempt(triesLeft - 1);
          throw err;
        });
      });
    };
    setSync('syncing');
    chain = chain.then(function () { return attempt(2); }).catch(function (err) {
      setSync(err.status === 401 ? 'badtoken' : 'offline');
      return false;
    }).then(function (ok) { renderAll(); return ok; });
    return chain;
  }

  function syncPending() {
    var days = {};
    sessions.forEach(function (s) { if (!s.synced) days[s.day] = 1; });
    gone.forEach(function (g) { days[g.day] = 1; });
    Object.keys(days).forEach(syncDay);
  }

  /* read a day from the repo (not more than once per `every` ms) */
  var fetched = {};
  function fetchDay(day, force, every) {
    if (!canSync() || Date.now() < backoffUntil) return;
    var now = Date.now();
    if (!force && now - (fetched[day] || 0) < (every || 15000)) return;
    fetched[day] = now;
    getDay(day, !force).then(function (got) {
      setSync('ok');
      if (got.same) return;
      reconcile(day, got.list);
      renderAll();
    }, function (err) {
      setSync(err.status === 401 ? 'badtoken' : 'offline');
      renderSync();
    });
  }
  var fetchToday = function (force) { fetchDay(today(), force, 15000); };
  /* the other days of this week, for the bars */
  function fetchWeek() {
    var now = new Date(nowMs());
    var back = DATA.weekStartsMonday === false ? now.getDay() : (now.getDay() + 6) % 7;
    for (var i = 1; i <= back; i++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      fetchDay(dayKey(d.getTime()), false, 5 * 60 * 1000);
    }
  }

  /* ---------- the timer ---------- */
  var prefs = load(LS_PREFS, {});
  if (prefs.sound == null) prefs.sound = true;
  if (prefs.wake == null) prefs.wake = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  var presets = Array.isArray(DATA.presets) && DATA.presets.length ? DATA.presets : [25, 30, 45, 60, 90];
  var minutes = +prefs.minutes || +DATA.defaultMinutes || 30;

  /* the running block: { id, startedAt, planned (sec), acc (sec banked before
     the current stretch), seg (ms the current stretch began, null = paused),
     dev (which device started it) } -- all times are server time */
  var run = load(LS_RUN, null);
  var state = 'idle';
  var alarmAt = 0;
  var bellsRung = 0;

  function elapsed() {
    if (!run) return 0;
    return run.acc + (run.seg ? (nowMs() - run.seg) / 1000 : 0);
  }
  function remaining() { return run ? run.planned - elapsed() : minutes * 60; }

  var app = $('focusapp');

  /* ---------- the running block, shared ----------
     meta: what this device last agreed with the repo, and whether it has a
     change waiting to go up.
       rev        the revision of focus-run.json it last read or wrote
       updated    when that revision was written
       localAt    when THIS device last changed the block
       dirty      a change that has not been written yet
       pendingClose  id of a block this device finished and has not reported
       ended      { id, at, ack } the block that just ran out, and whether the
                  alarm has been dismissed (so another device stops ringing) */
  var meta = load(LS_META, null) || { rev: 0, updated: 0, localAt: 0, dirty: false, pendingClose: null, ended: null };
  var runEtag = null;
  var runChain = Promise.resolve();
  var lastPoll = 0;

  var runUrl = function () { return base() + '/contents/' + RUN_PATH; };
  var runOut = function (r) {
    return r ? { id: r.id, startedAt: r.startedAt, planned: r.planned, acc: Math.round(r.acc * 1000) / 1000, seg: r.seg || null, dev: r.dev || '' } : null;
  };
  var runIn = function (o) {
    return o && o.id ? { id: o.id, startedAt: +o.startedAt, planned: +o.planned, acc: +o.acc || 0, seg: o.seg ? +o.seg : null, dev: o.dev || '' } : null;
  };

  function getRunDoc(useEtag) {
    return api('GET', runUrl() + '?ref=' + encodeURIComponent(SYNC_BRANCH), null, useEtag ? runEtag : null).then(function (f) {
      if (f.notModified) return { same: true };
      var doc = null;
      try { doc = JSON.parse(b64decode(f.content)); } catch (e) { doc = null; }
      return { sha: f.sha, doc: doc, etag: f.__etag };
    }, function (err) {
      if (err.status === 404) return { missing: true };
      throw err;
    });
  }
  /* the branch is made on first use */
  function ensureSyncBranch() {
    var g = base() + '/git/';
    return api('GET', g + 'ref/heads/' + encodeURIComponent(SYNC_BRANCH)).then(function () { return true; }, function (err) {
      if (err.status !== 404) throw err;
      return api('GET', g + 'ref/heads/' + encodeURIComponent(DATA.branch || 'main')).then(function (ref) {
        return api('POST', g + 'refs', { ref: 'refs/heads/' + SYNC_BRANCH, sha: ref.object.sha });
      }).then(function () { return true; }, function (e2) { if (e2.status === 422) return true; throw e2; });
    });
  }
  function putRunDoc(doc, sha, retry) {
    var body = {
      message: 'timer: ' + (doc.run ? (doc.run.seg ? 'running' : 'paused') + ' ' + dur(doc.run.planned) : 'idle') + ' (' + DEV + ')',
      content: b64encode(JSON.stringify(doc) + '\n'),
      branch: SYNC_BRANCH
    };
    if (sha) body.sha = sha;
    return api('PUT', runUrl(), body).catch(function (err) {
      if (err.status === 404 && retry !== false) return ensureSyncBranch().then(function () { return putRunDoc(doc, sha, false); });
      throw err;
    });
  }

  /* a change this device just made: remember it, and send it */
  function touch(extra) {
    meta.localAt = nowMs();
    meta.dirty = true;
    if (extra) Object.keys(extra).forEach(function (k) { meta[k] = extra[k]; });
    save(LS_META, meta);
    pushRun();
  }

  function pushRun() {
    if (!canSync()) return runChain;
    runChain = runChain.then(function () { return pushOnce(3); }).catch(function (err) {
      if (err && !err.status && !err.offline && window.console) console.warn('focus: push failed', err);
      setSync(err && err.status === 401 ? 'badtoken' : 'offline');
    }).then(function () { renderSync(); });
    return runChain;
  }

  function pushOnce(tries) {
    if (!meta.dirty) return Promise.resolve();
    return getRunDoc(false).then(function (got) {
      var remoteDoc = got.doc || { rev: 0, updated: 0, run: null, ended: null };
      var sha = got.sha || null;
      var theirs = remoteDoc.run;
      if (meta.pendingClose) {
        /* I finished block X. That is only news if the shared timer still shows X --
           if it shows another block, someone has moved on and must not be undone */
        if (!(theirs && theirs.id === meta.pendingClose)) {
          adoptRemote(remoteDoc, got.etag);
          meta.dirty = false; meta.pendingClose = null; save(LS_META, meta);
          return;
        }
      } else if (remoteDoc.rev !== meta.rev && remoteDoc.updated > meta.localAt) {
        /* the shared timer was changed after I last looked AND after my own change:
           the later action wins, so take theirs */
        adoptRemote(remoteDoc, got.etag);
        meta.dirty = false; save(LS_META, meta);
        return;
      }
      var doc = { v: 1, rev: remoteDoc.rev + 1, updated: nowMs(), by: DEV, run: runOut(run), ended: meta.ended || null };
      return putRunDoc(doc, sha).then(function () {
        meta.rev = doc.rev; meta.updated = doc.updated; meta.dirty = false; meta.pendingClose = null;
        save(LS_META, meta);
        runEtag = null;
        setSync('ok');
      }, function (err) {
        if ((err.status === 409 || err.status === 422) && tries > 0) return pushOnce(tries - 1);
        throw err;
      });
    });
  }

  /* look at the shared timer; send my own change first if I have one */
  function pollRun(force) {
    if (!canSync() || Date.now() < backoffUntil) return;
    var now = Date.now();
    var fast = state === 'alarm' ? 2500 : (state === 'running' || state === 'paused' || app) ? 7000 : 25000;
    if (!force && now - lastPoll < fast) return;
    lastPoll = now;
    runChain = runChain.then(function () {
      if (meta.dirty) return pushOnce(3);
      return getRunDoc(true).then(function (got) {
        setSync('ok');
        if (got.same) return;
        if (got.missing || !got.doc) {
          /* nothing shared yet: if this device has a block running, put it there */
          if (run) { meta.dirty = true; meta.localAt = meta.localAt || nowMs(); save(LS_META, meta); return pushOnce(3); }
          return;
        }
        runEtag = got.etag || null;
        if (got.doc.rev !== meta.rev || stateOf(got.doc) !== state) adoptRemote(got.doc, got.etag);
      });
    }).catch(function (err) {
      /* a bug of ours is not an outage: say so where a developer can see it */
      if (err && !err.status && !err.offline && window.console) console.warn('focus: poll failed', err);
      setSync(err && err.status === 401 ? 'badtoken' : 'offline');
    }).then(function () { settle(); renderSync(); });
  }

  /* On opening, a block of this device's own that has already run out is not closed
     at once: another device may have extended it, or finished it. The shared timer
     is asked first (and if it cannot be reached, the block is closed on its own
     evidence after a few seconds). */
  var settling = false;
  function settle() {
    if (!settling) return;
    settling = false;
    if (run && run.seg && remaining() <= 0 && state !== 'alarm') complete(true);
  }
  /* what state the page would be in for this shared document */
  function stateOf(doc) {
    var r = doc.run;
    if (!r) return state === 'alarm' && !(doc.ended && doc.ended.ack) ? 'alarm' : 'idle';
    return r.seg ? 'running' : 'paused';
  }

  /* A block this device was running that the shared timer no longer shows. If it was
     reported finished, log it from that report (any device can, so the block is not
     lost if the one that finished it never got to write it); if the shared timer
     never heard of it, keep what was focused rather than drop it. */
  function leave(had, doc) {
    var e = doc && doc.ended && doc.ended.id === had.id ? doc.ended : null;
    if (e) { logSession(had.id, had.startedAt, +e.sec || 0, +e.at || nowMs()); return; }
    var spent = Math.min(had.planned, had.acc + (had.seg ? (nowMs() - had.seg) / 1000 : 0));
    var end = had.seg ? Math.min(nowMs(), had.seg + (had.planned - had.acc) * 1000) : nowMs();
    logSession(had.id, had.startedAt, spent, end);
  }

  /* take the shared timer as this device's own */
  function adoptRemote(doc, etag) {
    var next = runIn(doc.run);
    var had = run;
    if (had && (!next || next.id !== had.id)) leave(had, doc);
    run = next;
    save(LS_RUN, run);
    meta.rev = doc.rev || 0; meta.updated = doc.updated || 0; meta.ended = doc.ended || null;
    save(LS_META, meta);
    runEtag = etag || null;

    if (next) {
      if (state === 'alarm') stopAlarm();
      if (next.seg && remaining() <= 0) {
        /* it ran out while nobody had it open */
        complete(true);
        return;
      }
      state = next.seg ? 'running' : 'paused';
      ticking(!!next.seg);
      wake(state === 'running');
      if (had && had.id === next.id && (had.seg ? 1 : 0) !== (next.seg ? 1 : 0)) {
        note(next.seg ? 'Resumed on ' + (doc.by || 'another device') + '.' : 'Paused on ' + (doc.by || 'another device') + '.');
      } else if (!had || had.id !== next.id) {
        note('This block was started on ' + (next.dev || doc.by || 'another device') + '.');
      }
    } else {
      if (state === 'running' || state === 'paused') {
        state = 'idle';
        ticking(false);
        wake(false);
        note(had && doc.ended && doc.ended.id === had.id
          ? 'That block was finished on ' + (doc.by || 'another device') + '.'
          : 'The shared timer had moved on — what you focused here was kept.');
        fetchToday(true);
      } else if (state === 'alarm' && doc.ended && doc.ended.ack) {
        stopAlarm();
        state = 'idle';
        ticking(false);
      }
    }
    renderAll();
  }

  function start(mins) {
    unlockAudio();
    askNotify();
    if (mins) minutes = mins;
    prefs.minutes = minutes;
    save(LS_PREFS, prefs);
    var now = nowMs();
    run = { id: uid(), startedAt: now, planned: minutes * 60, acc: 0, seg: now, dev: DEV };
    save(LS_RUN, run);
    stopAlarm();
    state = 'running';
    note('');
    softBell();
    wake(true);
    ticking(true);
    touch({ pendingClose: null, ended: null });
    renderAll();
  }
  function pause() {
    if (!run || !run.seg) return;
    run.acc = elapsed();
    run.seg = null;
    save(LS_RUN, run);
    state = 'paused';
    wake(false);
    touch();
    renderAll();
  }
  function resume() {
    if (!run || run.seg) return;
    unlockAudio();
    run.seg = nowMs();
    save(LS_RUN, run);
    state = 'running';
    wake(true);
    ticking(true);
    touch();
    renderAll();
  }
  function extend() {
    if (!run) return;
    run.planned += 300;
    save(LS_RUN, run);
    touch();
    renderAll();
  }

  /* a finished block into the log (worth logging from a minute up; the same block is
     never logged twice, whichever device or tab gets there first) */
  function logSession(id, startedAt, sec, end) {
    sessions = load(LS_SESSIONS, sessions);
    var day = dayKey(end);
    if (sec < 60) return null;
    if (sessions.some(function (s) { return s.id === id; })) return null;
    if ((remote[day] || []).some(function (s) { return s.id === id; })) return null;
    var s = { id: id, start: startedAt, end: end, sec: Math.round(sec), day: day, synced: false };
    sessions.push(s);
    persist();
    syncDay(day);
    return s;
  }

  /* close the running block and log it (if it is worth logging) */
  function closeRun(sec, endMs) {
    var r = run;
    run = null;
    save(LS_RUN, null);
    wake(false);
    if (!r) return null;
    var end = endMs || nowMs();
    /* the shared timer learns of it either way, with what was focused */
    touch({ pendingClose: r.id, ended: { id: r.id, at: end, sec: Math.round(sec), ack: false } });
    return logSession(r.id, r.startedAt, sec, end);
  }

  function stopAndLog() {
    if (!run) return;
    var sec = Math.floor(elapsed());
    var s = closeRun(sec);
    state = 'idle';
    ticking(false);
    note(s ? 'Logged ' + dur(s.sec) + '.' : 'Under a minute — not logged.');
    renderAll();
  }

  function complete(late) {
    var r = run;
    var endMs = r.seg ? r.seg + (r.planned - r.acc) * 1000 : nowMs();
    var s = closeRun(r.planned, endMs);
    if (late) {
      state = 'idle';
      ticking(false);
      if (s) note('Your ' + dur(r.planned) + ' block ended at ' + hm(endMs) + ' while this page was closed — logged.');
      renderAll();
      return;
    }
    ring(r.planned);
  }

  /* ---------- the alarm ---------- */
  function ring(sec) {
    state = 'alarm';
    alarmAt = Date.now();
    bellsRung = 0;
    if ($('falarmtitle')) $('falarmtitle').textContent = 'Time. ' + dur(sec) + ' done — ' + dur(secOn(today())) + ' today.';
    if (prefs.sound) { bells(3); bellsRung = 1; }
    try { if (navigator.vibrate) navigator.vibrate([400, 160, 400, 160, 700]); } catch (e) {}
    notify('Time — ' + dur(sec) + ' done', dur(secOn(today())) + ' focused today. Tap for another block.');
    ticking(true);          // keep ticking: the bell repeats and the title flashes
    renderAll();
  }
  function stopAlarm() {
    alarmAt = 0;
    bellsRung = 0;
    document.title = baseTitle;
  }
  function acknowledge() {         // any touch or key stops the ringing, not the prompt
    if (state === 'alarm' && alarmAt) {
      alarmAt = 0;
      document.title = baseTitle;
    }
  }
  function doneForNow() {
    stopAlarm();
    state = 'idle';
    ticking(false);
    /* tell the other devices it was heard, so they stop ringing too */
    if (meta.ended && !meta.ended.ack) touch({ ended: { id: meta.ended.id, at: meta.ended.at, sec: meta.ended.sec, ack: true } });
    renderAll();
  }

  /* A temple bell, synthesised: a struck partial series with inharmonic
     overtones and a slow shimmer, so there is no sound file to fetch. */
  var actx = null;
  function unlockAudio() {
    try {
      if (!actx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) actx = new AC();
      }
      if (actx && actx.state === 'suspended') actx.resume();
    } catch (e) { actx = null; }
  }
  function strike(t0, base, gain) {
    var out = actx.createGain();
    out.gain.value = gain;
    out.connect(actx.destination);
    [[1, 1, 3.2], [1.0021, .6, 3.0], [2.76, .5, 1.8], [5.4, .22, 1.0], [8.93, .1, .55]].forEach(function (p) {
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = base * p[0];
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(p[1] * .5, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p[2]);
      o.connect(g);
      g.connect(out);
      o.start(t0);
      o.stop(t0 + p[2] + 0.05);
    });
  }
  function bells(n) {
    if (!actx) return;
    unlockAudio();
    var t = actx.currentTime + 0.05;
    for (var i = 0; i < n; i++) strike(t + i * 1.3, 784, 0.9);
  }
  function softBell() {
    if (!prefs.sound || !actx) return;
    strike(actx.currentTime + 0.03, 1046.5, 0.25);
  }

  /* ---------- notifications ---------- */
  var swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (r) { swReg = r; }, function () {});
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type !== 'focus-action') return;
      if (d.action === 'again') start();
      else doneForNow();
    });
  }
  function askNotify() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      var p = Notification.requestPermission(renderNotify);
      if (p && p.then) p.then(renderNotify);
    } catch (e) {}
  }
  function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var plain = function () {
      try { new Notification(title, { body: body, tag: 'focus', requireInteraction: true, icon: '/icon-192.png' }); } catch (e) {}
    };
    if (swReg && swReg.showNotification) {
      swReg.showNotification(title, {
        body: body, tag: 'focus', renotify: true, requireInteraction: true,
        icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [400, 160, 400],
        actions: [{ action: 'again', title: 'Another ' + minutes + ' min' }, { action: 'done', title: 'Done' }]
      }).catch(plain);
    } else {
      plain();
    }
  }

  /* keep the phone from sleeping mid-block (on by default on touch screens) */
  var lock = null;
  function wake(on) {
    try {
      if (on && prefs.wake && navigator.wakeLock && !lock) {
        navigator.wakeLock.request('screen').then(function (l) {
          lock = l;
          l.addEventListener('release', function () { lock = null; });
        }, function () {});
      } else if (!on && lock) {
        lock.release();
        lock = null;
      }
    } catch (e) {}
  }

  /* ---------- the tick ---------- */
  var worker = null;
  var fallback = null;
  try {
    var src = 'var t=null;onmessage=function(e){clearInterval(t);t=null;if(e.data==="go")t=setInterval(function(){postMessage(1)},500)}';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = tick;
  } catch (e) { worker = null; }
  var ticking = function (on) {
    if (worker) { worker.postMessage(on ? 'go' : 'stop'); return; }
    clearInterval(fallback);
    fallback = on ? setInterval(tick, 500) : null;
  };

  var baseTitle = document.title;
  var lastCard = 0;
  function tick() {
    if (settling) { renderClock(); return; }
    if (state === 'running' && run && run.seg && remaining() <= 0) { complete(false); return; }
    if (state === 'alarm') {
      if (alarmAt) {
        var since = Date.now() - alarmAt;
        document.title = Math.floor(since / 900) % 2 ? baseTitle : '⏰ Time!';
        if (prefs.sound && bellsRung < 7 && since > bellsRung * 7000) { bells(2); bellsRung++; }
        if (since > 70000) alarmAt = 0;
        pollRun(false);          // another device may have dismissed it
      } else {
        document.title = baseTitle;
      }
      return;
    }
    renderClock();
    if (Date.now() - lastCard > 5000) { lastCard = Date.now(); renderCard(); }
  }

  /* ---------- rendering ---------- */
  function note(text, kind) {
    var el = $('fnote');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'fnote' + (kind ? ' ' + kind : '');
  }

  var R = 108;
  var CIRC = 2 * Math.PI * R;
  function renderClock() {
    if (!app) return;
    var left = remaining();
    var planned = run ? run.planned : minutes * 60;
    $('fclock').textContent = clockText(state === 'alarm' ? 0 : left);
    var prog = $('fprog');
    prog.setAttribute('stroke-dasharray', CIRC.toFixed(1));
    var frac = run ? Math.min(1, Math.max(0, elapsed() / planned)) : 0;
    if (state === 'alarm') frac = 1;
    prog.setAttribute('stroke-dashoffset', (CIRC * (1 - frac)).toFixed(1));
    $('fstate').textContent = { idle: 'Ready', running: 'Focus', paused: 'Paused', alarm: 'Done' }[state];
    app.dataset.state = state;
    /* the lamp over the clock burns for as long as there is a block */
    var flame = $('fflame');
    if (flame) flame.classList.toggle('lit', state !== 'idle');
    /* a block that another device started says so */
    var fdev = $('fdev');
    if (fdev) {
      var other = run && run.dev && run.dev !== DEV;
      fdev.hidden = !other;
      if (other) fdev.textContent = 'Started on ' + run.dev + ' — you can pause, resume or stop it from here.';
    }
    if (state === 'running') document.title = clockText(left) + ' · Focus';
    else if (state === 'paused') document.title = '❚❚ ' + clockText(left) + ' · Focus';
    else if (state === 'idle') document.title = baseTitle;
  }

  function renderPresets() {
    var box = $('fpresets');
    var locked = state === 'running' || state === 'paused';
    var isPreset = presets.indexOf(minutes) >= 0;
    box.innerHTML = presets.map(function (m) {
      return '<button type="button" data-min="' + m + '" aria-pressed="' + (m === minutes) + '"'
        + (locked ? ' disabled' : '') + '>' + m + '</button>';
    }).join('') + '<button type="button" data-min="custom" aria-pressed="' + !isPreset + '"'
      + (locked ? ' disabled' : '') + '>' + (isPreset ? 'Custom' : minutes + ' min') + '</button>';
  }

  function renderControls() {
    var idle = state === 'idle';
    $('fstart').hidden = !idle && state !== 'paused';
    $('fstart').textContent = state === 'paused' ? 'Resume' : 'Start ' + minutes + ' min';
    $('fpause').hidden = state !== 'running';
    $('fplus').hidden = !(state === 'running' || state === 'paused');
    $('fstop').hidden = !(state === 'running' || state === 'paused');
    $('fcontrols').hidden = state === 'alarm';
    $('falarm').hidden = state !== 'alarm';
    $('fagain').textContent = 'Another ' + minutes + ' min';
    if (state !== 'idle') $('fcustombox').hidden = true;
  }

  var TARGET = +DATA.target || 7 * 3600;

  /* A lamp for every half hour of focus, lit as the blocks finish. This mirrors
     diyaRow() in build.mjs, which draws the same row before the page has loaded --
     keep the two in step (the class names are styled in style.css). */
  var DIYA_MIN = 1800;
  var DIYA_SLOTS = Math.max(1, Math.ceil(TARGET / DIYA_MIN));
  var DIYA_SVG = '<svg viewBox="0 0 40 24" aria-hidden="true"><path class="bowl" d="M2 7C2 16.5 9.5 22 20 22S38 16.5 38 7c0-1-.8-1.6-1.8-1.6H3.8C2.8 5.4 2 6 2 7Z"/>'
    + '<path class="rim" d="M5.5 7.6Q20 11.2 34.5 7.6"/><circle class="wick" cx="20" cy="5.2" r="1.3"/></svg>';
  function diyaRow(sec) {
    var lit = Math.floor((sec || 0) / DIYA_MIN);
    var html = '';
    for (var i = 0; i < Math.max(DIYA_SLOTS, lit); i++) {
      html += '<span class="diya' + (i < lit ? ' lit' : '') + '">' + DIYA_SVG + '<i class="flame"></i></span>';
    }
    return '<div class="diyas" role="img" aria-label="' + lit + ' of ' + DIYA_SLOTS
      + ' lamps lit, one for every half hour of focus">' + html + '</div>';
  }

  /* where a block sits on the day's 24-hour strip: at its start, unless it began on
     another day (a block left paused overnight), when it sits where it ended */
  function stripStart(s, day) {
    return dayKey(s.start) === day ? s.start : s.end - s.sec * 1000;
  }

  function renderToday() {
    if (!app) return;
    var day = today();
    var list = dayList(day);
    var total = sumSec(list);
    $('ftotal').textContent = dur(total);
    $('fsub').textContent = 'of ' + dur(TARGET) + ' · ' + list.length + ' block' + (list.length === 1 ? '' : 's')
      + (total >= TARGET ? ' · target met' : '');
    $('fring').innerHTML = diyaRow(total);

    var mins = function (ms) {
      var d = new Date(ms);
      return dayKey(ms) === day ? d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 : 0;
    };
    var blocks = list.map(function (s) {
      return '<i style="left:' + (mins(stripStart(s, day)) / 14.4).toFixed(2) + '%;width:' + (Math.max(s.sec / 60, 4) / 14.4).toFixed(2) + '%"></i>';
    });
    if (run && (state === 'running' || state === 'paused') && dayKey(run.startedAt) === day) {
      blocks.push('<i class="live" style="left:' + (mins(run.startedAt) / 14.4).toFixed(2) + '%;width:'
        + (Math.max(elapsed() / 60, 4) / 14.4).toFixed(2) + '%"></i>');
    }
    $('ftimeline').innerHTML = blocks.join('');

    $('fsessions').innerHTML = list.length
      ? list.slice().reverse().map(function (s) {
        var when = dayKey(s.start) === day ? hm(s.start) + ' – ' + hm(s.end) : 'finished ' + hm(s.end);
        return '<li><span>' + when + '</span>'
          + (s.synced ? '' : '<span class="tagx">this device</span>')
          + '<span class="len">' + dur(s.sec) + '</span>'
          + '<button type="button" class="del" data-del="' + s.id + '" aria-label="Delete this block">×</button></li>';
      }).join('')
      : '<li class="none">Nothing logged yet today.</li>';
  }

  function renderWeek() {
    if (!app) return;
    var now = new Date(nowMs());
    var dow = now.getDay();
    var back = DATA.weekStartsMonday === false ? dow : (dow + 6) % 7;
    var first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    var letters = DATA.weekStartsMonday === false ? 'SMTWTFS' : 'MTWTFSS';
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      var key = dayKey(d.getTime());
      days.push({ key: key, sec: key > today() ? 0 : secOn(key), letter: letters[i] });
    }
    /* the plot is 92px tall; the day letter and its gap take the 19px below it
       (style.css .bars keeps these numbers) */
    var PLOT = 92;
    var BASE = 19;
    var max = Math.max(TARGET, days.reduce(function (m, d) { return Math.max(m, d.sec); }, 0));
    var week = days.reduce(function (t, d) { return t + d.sec; }, 0);
    $('fweektotal').textContent = dur(week) + ' this week';
    $('fweek').innerHTML = days.map(function (d) {
      var h = d.sec ? Math.max(3, Math.round((d.sec / max) * PLOT)) : 3;
      return '<div class="b' + (d.key === today() ? ' today' : '') + (d.sec ? '' : ' zero') + '">'
        + '<span class="v">' + (d.sec ? dur(d.sec) : '') + '</span>'
        + '<span class="col" style="height:' + h + 'px"></span>'
        + '<span class="d">' + d.letter + '</span></div>';
    }).join('') + '<div class="goal" style="bottom:' + Math.round(BASE + (TARGET / max) * PLOT) + 'px">'
      + '<span>' + dur(TARGET) + ' goal</span></div>';
  }

  function renderSync() {
    var el = $('fsync');
    if (!el) return;
    var unsynced = sessions.filter(function (s) { return !s.synced; }).length + gone.length + (meta.dirty ? 1 : 0);
    var last = lastSyncAt ? '<small>Last synced ' + hm(lastSyncAt) + '.</small>' : '';
    var text = {
      local: 'This browser isn’t connected, so the timer and your blocks stay on this device only. '
        + '<a href="/admin/#setup">Connect it once</a> and they follow you to every device.',
      ok: unsynced ? 'Saving…' : 'In sync — the timer and your blocks follow you to your other devices. ' + last,
      syncing: 'Saving…',
      offline: 'Can’t reach GitHub right now. Blocks are safe on this device and go up as soon as there is signal.',
      badtoken: 'GitHub rejected the token — <a href="/admin/#setup">reconnect</a>. Blocks are safe on this device.'
    }[syncState] || '';
    el.innerHTML = text;
  }

  function renderNotify() {
    var st = $('fnotifystate');
    var b = $('fnotify');
    if (!st || !b) return;
    if (!('Notification' in window)) {
      st.textContent = /iP(hone|ad|od)/.test(navigator.userAgent)
        ? 'On iPhone, notifications need this site on the Home Screen (Share → Add to Home Screen). Keep this page open and the bell still rings.'
        : 'This browser cannot show notifications. The bell still rings while this page is open.';
      b.hidden = true;
      return;
    }
    var p = Notification.permission;
    st.textContent = p === 'granted' ? 'Notifications are on — you get one when a block ends, even from another tab.'
      : p === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser\'s site settings to get one when a block ends.'
        : 'Get a notification when a block ends, even when you are in another tab.';
    b.hidden = p !== 'default';
  }

  /* The Focus card on Today. The home page carries one per day panel (today's and
     tomorrow's), only one of them visible, so every card is updated -- each shows
     the device's today, not the date its HTML was built for. */
  function renderCard() {
    var cards = [].slice.call(document.querySelectorAll('[data-focus-card]'));
    if (!cards.length) return;
    var list = dayList(today());
    var total = sumSec(list);
    cards.forEach(function (card) {
      var t = card.querySelector('[data-f-total]');
      var sub = card.querySelector('[data-f-sub]');
      var lamps = card.querySelector('[data-f-diyas]');
      var running = card.querySelector('[data-f-running]');
      if (t) t.textContent = dur(total);
      if (sub) sub.textContent = 'of ' + dur(TARGET) + ' · ' + list.length + ' block' + (list.length === 1 ? '' : 's');
      if (lamps) lamps.innerHTML = diyaRow(total);
      if (running) {
        var live = run && run.seg && remaining() > 0;
        running.hidden = !(run && (live || !run.seg));
        var where = run && run.dev && run.dev !== DEV ? ' · on ' + run.dev : '';
        running.textContent = !run ? '' : run.seg
          ? '● ' + Math.ceil(remaining() / 60) + ' min left in this block' + where
          : '❚❚ block paused' + where;
      }
    });
  }

  function renderAll() {
    renderCard();
    if (!app) return;
    renderClock();
    renderPresets();
    renderControls();
    renderToday();
    renderWeek();
    renderSync();
    renderNotify();
    $('fsound').checked = !!prefs.sound;
    $('fwake').checked = !!prefs.wake;
  }

  /* ---------- wiring ---------- */
  if (app) {
    $('fstart').addEventListener('click', function () { if (state === 'paused') resume(); else start(); });
    $('fpause').addEventListener('click', pause);
    $('fplus').addEventListener('click', extend);
    $('fstop').addEventListener('click', stopAndLog);
    $('fagain').addEventListener('click', function () { start(); });
    $('fdone').addEventListener('click', doneForNow);

    $('fpresets').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-min]');
      if (!b || b.disabled) return;
      if (b.dataset.min === 'custom') {
        $('fcustombox').hidden = false;
        $('fcustom').value = presets.indexOf(minutes) >= 0 ? '' : minutes;
        $('fcustom').focus();
        return;
      }
      minutes = +b.dataset.min;
      prefs.minutes = minutes;
      save(LS_PREFS, prefs);
      $('fcustombox').hidden = true;
      renderAll();
    });
    var setCustom = function () {
      var v = Math.round(+$('fcustom').value);
      if (!(v >= 1 && v <= 240)) { note('Pick between 1 and 240 minutes.', 'err'); return; }
      minutes = v;
      prefs.minutes = v;
      save(LS_PREFS, prefs);
      $('fcustombox').hidden = true;
      note('');
      renderAll();
    };
    $('fcustomset').addEventListener('click', setCustom);
    $('fcustom').addEventListener('keydown', function (e) { if (e.key === 'Enter') setCustom(); });

    $('fsessions').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-del]');
      if (!b) return;
      var s = dayList(today()).filter(function (x) { return x.id === b.dataset.del; })[0];
      if (!s || !confirm('Delete the ' + dur(s.sec) + ' block from ' + hm(s.start) + '?')) return;
      var mine = sessions.filter(function (x) { return x.id === s.id; })[0];
      sessions = sessions.filter(function (x) { return x.id !== s.id; });
      if (s.synced || !mine) gone.push({ id: s.id, day: s.day });
      persist();
      renderAll();
      if (token) syncDay(s.day);
    });

    $('fsound').addEventListener('change', function () {
      prefs.sound = this.checked;
      save(LS_PREFS, prefs);
      if (prefs.sound) { unlockAudio(); softBell(); }
    });
    $('fwake').addEventListener('change', function () {
      prefs.wake = this.checked;
      save(LS_PREFS, prefs);
      wake(prefs.wake && state === 'running');
    });
    $('fnotify').addEventListener('click', askNotify);
    $('ftest').addEventListener('click', function () {
      unlockAudio();
      bells(2);
      notify('This is what the end of a block looks like', 'The bell and this notification are working.');
      if (!('Notification' in window) || Notification.permission !== 'granted') note('Bell rang. Notifications are not on, so only the bell will fire.');
    });

    /* Space starts / pauses, unless you are typing into the custom box */
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' || /INPUT|TEXTAREA|BUTTON/.test((e.target && e.target.tagName) || '')) return;
      e.preventDefault();
      if (state === 'running') pause();
      else if (state === 'paused') resume();
      else if (state === 'idle') start();
      else if (state === 'alarm') start();
    });
  }

  /* browsers only allow sound after a touch or a key -- take the first one */
  var firstTouch = function () {
    unlockAudio();
    acknowledge();
  };
  document.addEventListener('pointerdown', firstTouch, true);
  document.addEventListener('keydown', firstTouch, true);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    tick();
    if (state === 'running') wake(true);
    pollRun(true);
    fetchToday(true);
    if (app) fetchWeek();
    renderAll();
  });

  /* another tab of this site started, stopped or finished a block */
  window.addEventListener('storage', function (e) {
    if (e.key === LS_RUN) {
      run = load(LS_RUN, null);
      if (!run && (state === 'running' || state === 'paused')) state = 'idle';
      if (run) state = run.seg ? 'running' : 'paused';
      ticking(state === 'running' || state === 'alarm');
      renderAll();
    } else if (e.key === LS_META) {
      var m = load(LS_META, null);
      if (m && m.rev >= meta.rev) { meta.rev = m.rev; meta.updated = m.updated; meta.ended = m.ended; }
    } else if (e.key === LS_SESSIONS || e.key === LS_GONE) {
      sessions = load(LS_SESSIONS, []);
      gone = load(LS_GONE, []);
      renderAll();
    }
  });

  /* app.js calls this when the home page turns over to a new day's panel */
  window.__focusRender = renderAll;
  /* ...and when a device is woken or its connection comes back */
  window.__focusSync = function () { pollRun(true); fetchToday(true); syncPending(); };

  /* ---------- boot ---------- */
  if (run) {
    if (run.seg && remaining() <= 0) {
      /* it ran out while the page was closed */
      if (canSync()) { settling = true; state = 'running'; setTimeout(settle, 6000); }
      else complete(true);
    } else {
      state = run.seg ? 'running' : 'paused';
    }
  }
  /* a block started before the timer was shared: put it where the others can see it */
  if (canSync() && run && !meta.rev && !meta.dirty) { meta.dirty = true; meta.localAt = nowMs(); save(LS_META, meta); }
  if (state === 'running') {
    ticking(true);
    if (app && prefs.sound) note('Tap anywhere once so the bell can ring when this block ends.');
  } else if (!app && run) {
    ticking(true);
  }
  if (app && /[?&]again=1/.test(location.search)) {
    history.replaceState(null, '', location.pathname);
    if (state === 'idle') start();
  }
  renderAll();
  /* the offset first: every time below is the server's */
  measureSkew().then(function () {
    renderAll();
    syncPending();
    pollRun(true);
    fetchToday(true);
    if (app) fetchWeek();
  });
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    pollRun(false);
    fetchToday(false);
  }, 3000);
  setInterval(measureSkew, 10 * 60 * 1000);
  window.addEventListener('online', function () { syncPending(); pollRun(true); fetchToday(true); });
})();
