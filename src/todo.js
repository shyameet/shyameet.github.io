/* To do: what has to be done, and a bell for what cannot slip.

   Three jobs, one file, loaded on every page:
   1. On /tasks/ -- the list. Say it or type it ("call the bank at 5 pm tomorrow"),
      tick it off, edit it, push it to later. Overdue things sit on top, in red.
   2. On any page with [data-todo-card] -- Today's short list, with a box to add to it.
   3. Everywhere -- the reminders. A task with a time rings at that time (a bell,
      a banner, a notification), then nudges again every so often until it is
      ticked; an evening check-in names whatever is still open.

   What is shared between devices, and how
   ---------------------------------------
   The list is todos.json on the "sync" branch of the repo -- the branch the focus
   timer is shared through -- so it follows him from phone to laptop without
   rebuilding the site on every tick. localStorage holds the same list first
   (instant, works offline) and anything not yet uploaded. Every task carries the
   time it was last changed; when two devices disagree the later change wins, task
   by task, and a deleted task leaves a marker behind so it stays deleted.

   A browser with no token cannot save: its list stays on that device, and the page
   says so. The repo is public, so a task is public too -- nothing private belongs
   in one.

   What the reminders can and cannot do
   ------------------------------------
   They ring while this site is open: a tab, or the Home Screen app. A web page
   cannot wake a closed phone -- only a server can, and this site has none -- so for
   something that must not be missed, the phone's own Reminders are still the
   safety net. What the page does do is catch up the moment it is opened: a task
   that came due while it was closed rings once, then nudges on its schedule.
   Times are the server's, not the device's (as in focus.js), so a wrong device
   clock cannot ring a reminder early or late. The tick comes from a Worker,
   because browsers slow a hidden tab's own timers to about once a minute. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var DAY = 864e5;
  var metaOf = function (name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return m ? m.content : '';
  };

  var REPO = metaOf('repo');
  var BASE_BRANCH = metaOf('branch') || 'main';
  var SYNC_BRANCH = metaOf('sync-branch') || 'sync';
  var PATH = 'todos.json';

  var LS_STORE = 'todo_store_v1';     // { items: { id: task }, dirty, etag }
  var LS_PREFS = 'todo_prefs_v1';
  var LS_FIRED = 'todo_fired_v1';     // { taskId | 'ck:' + day : when this device last rang for it }
  var LS_RING = 'todo_ring_v1';       // the alarm that is on screen, for the other tabs and the next page

  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function save(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  var token = '';
  try { token = localStorage.getItem('gh_token') || ''; } catch (e) {}
  var canSync = function () { return !!(token && REPO); };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  var app = $('todoapp');
  var cards = $$('[data-todo-card]');

  /* ---------- the clock ----------
     "Now" is the server's now: the device's clock plus a measured offset. Days and
     times of day are the device's own wall clock, which is what a person means. */
  var skew = 0;
  var nowMs = function () { return Date.now() + skew; };
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  var today = function () { return dayKey(nowMs()); };
  function dayMs(key, hh, mm) {
    var p = String(key).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], hh || 0, mm || 0, 0, 0).getTime();
  }
  function addDays(key, n) {
    var p = key.split('-');
    return dayKey(new Date(+p[0], +p[1] - 1, +p[2] + n, 12).getTime());
  }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  /* when a task is due: its day at its time, or 0 when it has no time */
  function dueMs(t) { return t && t.at ? dayMs(t.day, +t.at.slice(0, 2), +t.at.slice(3, 5)) : 0; }

  function measureSkew() {
    var t0 = Date.now();
    return fetch('/build.json?t=' + t0, { cache: 'no-store' }).then(function (r) {
      var t1 = Date.now();
      var d = Date.parse(r.headers.get('date'));
      var age = +r.headers.get('age') || 0;
      if (isNaN(d) || age > 5) return;
      var s = Math.round(d + 500 + age * 1000 - (t0 + t1) / 2);
      skew = (Math.abs(s) < 2000 || Math.abs(s) > 6 * 3600 * 1000) ? 0 : s;
    }).catch(function () {});
  }

  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(key, base) {
    var n = Math.round((dayMs(key, 12, 0) - dayMs(base, 12, 0)) / DAY);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    var d = new Date(dayMs(key, 12, 0));
    return WD[d.getDay()] + ' ' + d.getDate() + ' ' + MO[d.getMonth()];
  }
  function lateText(t, now, td) {
    if (t.day === td && t.at) {
      var m = Math.max(1, Math.round((now - dueMs(t)) / 60000));
      return m < 90 ? m + ' min late' : Math.round(m / 60) + ' h late';
    }
    var n = Math.round((dayMs(td, 12, 0) - dayMs(t.day, 12, 0)) / DAY);
    return n === 1 ? 'from yesterday' : 'from ' + dayLabel(t.day, td);
  }

  /* ---------- the list ----------
     a task: { id, text, day (YYYY-MM-DD), at (HH:MM, optional), made, mod (ms of the
     last change), done (ms, when ticked), del (ms, when removed) }
     Removing leaves the task behind with `del` set, so the removal reaches the other
     devices; it is dropped for good after a month. */
  var ORDER = ['id', 'text', 'day', 'at', 'made', 'mod', 'done', 'del'];
  function clean(r) {
    if (!r || typeof r !== 'object' || !r.id) return null;
    var t = {};
    Object.keys(r).forEach(function (k) { t[k] = r[k]; });      // keep what a newer version may add
    t.id = String(r.id);
    t.text = String(r.text == null ? '' : r.text).slice(0, 300);
    t.mod = +r.mod || 0;
    t.made = +r.made || t.mod;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.day || ''))) t.day = dayKey(t.made || Date.now());
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.at || ''))) delete t.at;
    if (r.done) t.done = +r.done || 1; else delete t.done;
    if (r.del) t.del = +r.del || 1; else delete t.del;
    if (!t.del && !t.text.trim()) return null;
    return t;
  }
  var rank = function (t) { return t.del ? 2 : t.done ? 1 : 0; };
  /* does a win over b? The later change does; on a tie, finished beats open, so a
     tick is never undone by accident */
  function newer(a, b) {
    if (!b) return true;
    if ((a.mod || 0) !== (b.mod || 0)) return (a.mod || 0) > (b.mod || 0);
    return rank(a) > rank(b);
  }
  function merge(a, b) {
    var out = {};
    [a, b].forEach(function (m) {
      Object.keys(m).forEach(function (k) { if (newer(m[k], out[k])) out[k] = m[k]; });
    });
    return out;
  }
  function prune(items, now) {
    var out = {};
    Object.keys(items).forEach(function (k) {
      var t = items[k];
      if (t.del && now - t.del > 30 * DAY) return;
      if (t.done && !t.del && now - t.done > 60 * DAY) return;
      out[k] = t;
    });
    return out;
  }
  function ordered(t) {
    var o = {};
    ORDER.forEach(function (k) { if (t[k] != null) o[k] = t[k]; });
    Object.keys(t).sort().forEach(function (k) { if (!(k in o) && t[k] != null) o[k] = t[k]; });
    return o;
  }
  /* the file as it is stored: one task a line, in a fixed order, so a change is a
     small diff and two devices that agree write the same bytes */
  function toFile(items) {
    var list = Object.keys(items).map(function (k) { return items[k]; })
      .sort(function (a, b) { return ((a.made || 0) - (b.made || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return '{\n "v": 1,\n "tasks": [' + (list.length
      ? '\n' + list.map(function (t) { return '  ' + JSON.stringify(ordered(t)); }).join(',\n') + '\n '
      : '') + ']\n}\n';
  }

  var store = load(LS_STORE, null) || { items: {}, dirty: false, etag: null };
  (function () {
    var items = {};
    Object.keys(store.items || {}).forEach(function (k) {
      var t = clean(store.items[k]);
      if (t) items[t.id] = t;
    });
    store.items = prune(items, Date.now());
  })();
  function persistStore() { save(LS_STORE, store); }
  function liveTasks() {
    return Object.keys(store.items).map(function (k) { return store.items[k]; }).filter(function (t) { return !t.del; });
  }

  /* what this device likes: sound, when to nudge, when to check in (per device) */
  var prefs = load(LS_PREFS, {});
  (function () {
    var d = { sound: true, notify: true, nag: 30, checkin: true, checkinAt: '20:00', quiet: true, quietFrom: '23:00', quietTo: '06:30', asked: false };
    Object.keys(d).forEach(function (k) { if (prefs[k] == null) prefs[k] = d[k]; });
    prefs.nag = +prefs.nag || 0;
  })();

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
      if (r.status === 304) return { notModified: true };
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
    }, function () {
      var err = new Error('No connection');
      err.offline = true;
      throw err;
    });
  }
  var base = function () { return 'https://api.github.com/repos/' + REPO; };
  var fileUrl = function () { return base() + '/contents/' + PATH; };

  /* The whole list as the repo has it. Asked for looking (useEtag), a list that has
     not changed is answered 304, which GitHub does not count against the hourly
     allowance. A read before a write must be the whole file, for its sha. */
  function getFile(useEtag) {
    return api('GET', fileUrl() + '?ref=' + encodeURIComponent(SYNC_BRANCH), null, useEtag ? store.etag : null)
      .then(function (f) {
        if (f.notModified) return { same: true };
        var items = {};
        var d = null;
        var raw = b64decode(f.content || '');
        /* a blank file is an empty list; a file this code cannot read is never written over */
        if (raw.trim()) {
          try { d = JSON.parse(raw); } catch (e) {
            var bad = new Error(PATH + ' is not valid JSON');
            bad.broken = true;
            throw bad;
          }
        }
        ((d && d.tasks) || []).forEach(function (r) { var t = clean(r); if (t) items[t.id] = t; });
        return { sha: f.sha, etag: f.__etag, items: items };
      }, function (err) {
        /* no file yet, or no branch yet: both are "nothing shared so far" */
        if (err.status === 404) return { sha: null, etag: null, items: {}, missing: true };
        throw err;
      });
  }
  /* the branch is made on first use */
  function ensureSyncBranch() {
    var g = base() + '/git/';
    return api('GET', g + 'ref/heads/' + encodeURIComponent(SYNC_BRANCH)).then(function () { return true; }, function (err) {
      if (err.status !== 404) throw err;
      return api('GET', g + 'ref/heads/' + encodeURIComponent(BASE_BRANCH)).then(function (ref) {
        return api('POST', g + 'refs', { ref: 'refs/heads/' + SYNC_BRANCH, sha: ref.object.sha });
      }).then(function () { return true; }, function (e2) { if (e2.status === 422) return true; throw e2; });
    });
  }
  function putFile(body, retry) {
    return api('PUT', fileUrl(), body).catch(function (err) {
      if (err.status === 404 && retry !== false) return ensureSyncBranch().then(function () { return putFile(body, false); });
      throw err;
    });
  }

  /* "2 added · 1 done" for the commit message */
  function summary(before, after) {
    var added = 0, done = 0, removed = 0, edited = 0;
    Object.keys(after).forEach(function (k) {
      var a = after[k], b = before[k];
      if (!b) { if (!a.del) added++; return; }
      if (a.mod === b.mod) return;
      if (a.del && !b.del) removed++;
      else if (a.done && !b.done) done++;
      else edited++;
    });
    var parts = [];
    if (added) parts.push(added + ' added');
    if (done) parts.push(done + ' done');
    if (removed) parts.push(removed + ' removed');
    if (edited) parts.push(edited + ' changed');
    return 'todos: ' + (parts.join(' · ') || 'tidied');
  }

  var syncState = token ? 'ok' : 'local';
  var lastSyncAt = 0;
  function setState(st) {
    syncState = st;
    if (st === 'ok') lastSyncAt = Date.now();
    if (window.__rdx) window.__rdx.mark('todo', st);
  }

  /* One round: look at the repo, merge what it says with this device's list, and
     write the result back if that changed anything. A 409 means another device wrote
     in between; fetch and merge again. */
  function round(tries) {
    if (!store.dirty) {
      return getFile(true).then(function (got) {
        setState('ok');
        if (!got.same) absorb(got);
      });
    }
    return getFile(false).then(function (got) {
      var merged = prune(merge(store.items, got.items), nowMs());
      if (toFile(merged) === toFile(got.items)) { finished(merged, got.sha, got.etag); return; }
      var body = {
        message: summary(got.items, merged),
        content: b64encode(toFile(merged)),
        branch: SYNC_BRANCH
      };
      if (got.sha) body.sha = got.sha;
      return putFile(body).then(function (res) {
        finished(merged, res && res.content && res.content.sha);
      }, function (err) {
        if ((err.status === 409 || err.status === 422) && tries > 0) return round(tries - 1);
        throw err;
      });
    });
  }
  /* what was written is now the repo's: anything changed here in the meantime
     (the merge keeps the later change) still has to go up */
  function finished(merged, sha, etag) {
    var cur = merge(store.items, merged);
    store.dirty = toFile(cur) !== toFile(merged);
    store.items = cur;
    store.etag = etag || (sha ? '"' + sha + '"' : null);
    persistStore();
    retryAt = 0;
    setState('ok');
    render(true);
    check();
    if (store.dirty) schedulePush(300);
  }
  /* the repo's list changed (or this is the first look): take it in */
  function absorb(got) {
    var merged = prune(merge(store.items, got.items), nowMs());
    if (toFile(merged) !== toFile(got.items)) store.dirty = true;     // this device has something the repo lacks
    store.items = merged;
    store.etag = got.etag || null;
    persistStore();
    render(true);
    check();
    if (store.dirty) schedulePush(0);
  }

  var chain = Promise.resolve();
  var lastPoll = 0;
  var retryAt = 0;
  var pushTimer = null;
  function sync(force) {
    if (!canSync()) { setState('local'); renderSettings(); return chain; }
    var now = Date.now();
    if (now < backoffUntil) return chain;
    if (!force && now < retryAt) return chain;
    if (!force && !store.dirty && now - lastPoll < (app ? 9000 : 29000)) return chain;
    lastPoll = now;
    chain = chain.then(function () { return round(3); }).catch(function (err) {
      /* a bug of ours is not an outage: say so where a developer can see it */
      if (err && !err.status && !err.offline && window.console) console.warn('todo: sync failed', err);
      /* a refused token will not mend itself in ten seconds */
      retryAt = Date.now() + (err && err.status === 401 ? 60000 : 10000);
      setState(err && err.status === 401 ? 'badtoken' : 'offline');
    }).then(function () { renderSettings(); });
    return chain;
  }
  function schedulePush(ms) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { sync(true); }, ms == null ? 600 : ms);
  }

  /* ---------- saying it out loud ----------
     "call the bank at 5 pm tomorrow" is a task, "Call the bank", tomorrow, 17:00.
     Only what is understood is taken out of the words; the rest stays the task. What
     was understood is shown before it is added, so a wrong guess is one tap to fix. */
  var DAYNAMES = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  var MONTHNAMES = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
    jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
  var NUMWORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, 'forty-five': 45, sixty: 60 };
  var PARTS = { morning: '09:00', afternoon: '15:00', evening: '18:00', night: '20:00' };
  var MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  function parseWhen(raw, now) {
    var s = ' ' + String(raw || '') + ' ';
    var base = dayKey(now);
    var day = null;
    var clock = null;      // { h, m, ap: 'a' | 'p' | null, bare: could be morning or evening }
    var part = '';         // a part of the day, said instead of a time
    var mm;
    function cut(re) {
      var m = re.exec(s);
      if (!m) return null;
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      return m;
    }
    var clockAt = function (ms) { var d = new Date(ms); return { h: d.getHours(), m: d.getMinutes(), ap: null, bare: false }; };
    var notZero = function (str) { return str.charAt(0) !== '0'; };

    /* in 20 minutes / an hour from now / in 3 days */
    var REL = '(forty[ -]five|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|sixty|\\d{1,3})\\s*(minutes?|mins?|hours?|hrs?|days?)';
    if ((mm = cut(/\bin\s+half\s+an?\s+hour\b/i))) {
      day = dayKey(now + 30 * 60000);
      clock = clockAt(now + 30 * 60000);
    } else if ((mm = cut(new RegExp('\\bin\\s+' + REL + '\\b', 'i')) || cut(new RegExp('\\b' + REL + '\\s+from\\s+now\\b', 'i')))) {
      var q = mm[1].toLowerCase();
      var n = NUMWORDS[q] || parseInt(q, 10) || 1;
      if (mm[2].charAt(0).toLowerCase() === 'd') {
        day = addDays(base, n);
      } else {
        var then = now + n * (mm[2].charAt(0).toLowerCase() === 'h' ? 3600000 : 60000);
        day = dayKey(then);
        clock = clockAt(then);
      }
    }

    /* a date: 2026-10-15, 15 oct, october 15th, the 15th */
    if (!day) {
      if ((mm = cut(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
        day = mm[1] + '-' + mm[2] + '-' + mm[3];
      } else if ((mm = cut(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON_RE + '\\b', 'i')))) {
        day = monthDay(MONTHNAMES[mm[2].toLowerCase()], +mm[1], base);
      } else if ((mm = cut(new RegExp('\\b' + MON_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![:\\d])', 'i')))) {
        day = monthDay(MONTHNAMES[mm[1].toLowerCase()], +mm[2], base);
      } else if ((mm = cut(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i))) {
        day = nextOfMonth(+mm[1], base);
      }
    }

    /* a day word, with a part of the day if it came with one: tomorrow evening */
    if (!day && (mm = cut(/\bday after tomorrow\b/i))) day = addDays(base, 2);
    if (!day && (mm = cut(/\btomorrow\b(?:\s+(morning|afternoon|evening|night))?/i))) {
      day = addDays(base, 1);
      if (mm[1]) part = mm[1].toLowerCase();
    }
    if ((mm = cut(/\btonight\b/i))) { if (!day) day = base; part = 'night'; }
    if ((mm = cut(/\b(?:this|today)\s+(morning|afternoon|evening)\b/i))) { if (!day) day = base; part = mm[1].toLowerCase(); }
    if ((mm = cut(/\btoday\b/i)) && !day) day = base;

    /* a weekday: friday, on fri, next monday ("sat", "wed" and "mon" are also ordinary
       words, so the short forms only count after on / this / next) */
    if (!day) {
      mm = cut(/\b(?:(next|this|on|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)
        || cut(/\b(next|this|on|coming)\s+(sun|mon|tues?|weds?|thu(?:rs?)?|fri|sat)\b/i);
      if (mm) {
        var want = DAYNAMES[mm[2].toLowerCase()];
        var have = new Date(dayMs(base, 12, 0)).getDay();
        day = addDays(base, (want - have + 7) % 7 || 7);
      }
    }

    /* a time: 5 pm, 5:30 p.m., 17:30, noon, at 5 */
    if (!clock) {
      if ((mm = cut(/\b(?:at\s+|by\s+|around\s+|@\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\.?(?![a-z])/i))) {
        clock = { h: +mm[1], m: +(mm[2] || 0), ap: mm[3].toLowerCase(), bare: false };
      } else if ((mm = cut(/\b(?:at\s+|by\s+|around\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/i))) {
        clock = { h: +mm[1], m: +mm[2], ap: null, bare: +mm[1] >= 1 && +mm[1] <= 12 && notZero(mm[1]) };
      } else if ((mm = cut(/\b(?:at\s+|by\s+)?noon\b/i))) {
        clock = { h: 12, m: 0, ap: null, bare: false };
      } else if ((mm = cut(/\b(?:at|by|around)\s+(\d{1,2})\b(?!\s*(?::|\.\d|st\b|nd\b|rd\b|th\b|%|min|hour|hr|day|week|month|year|people|times|rupees|rs\b|percent))/i))) {
        clock = { h: +mm[1], m: 0, ap: null, bare: +mm[1] >= 1 && +mm[1] <= 12 && notZero(mm[1]) };
      }
    }
    /* "in the morning", "at night": a time of day, or what settles a bare "6:30" */
    if (!part && (mm = cut(/\b(?:in\s+the|at)\s+(morning|afternoon|evening|night)\b/i))) part = mm[1].toLowerCase();

    /* the clock, on the 24-hour face */
    var at = null;
    if (clock) {
      var h = clock.h;
      if (clock.ap) {
        if (h >= 1 && h <= 12) h = clock.ap === 'p' ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
      } else if (clock.bare && h !== 12) {
        if (part) {
          /* said which half of the day */
          h = part === 'morning' ? h : h + 12;
        } else {
          /* "at 5": today, the next 5 o'clock; another day, a morning from 7 and an afternoon before */
          h = (day || base) === base ? (dayMs(base, h, clock.m) > now ? h : h + 12) : (h >= 7 ? h : h + 12);
        }
      }
      if (h <= 23 && clock.m <= 59) at = pad(h) + ':' + pad(clock.m);
    } else if (part) {
      at = PARTS[part];
    }
    /* a time with no day is the next time it comes round */
    if (at && !day) day = dayMs(base, +at.slice(0, 2), +at.slice(3, 5)) > now ? base : addDays(base, 1);

    return { text: tidy(s), day: day, at: at };
  }
  function monthDay(mon, d, base) {
    var y = +base.slice(0, 4);
    var k = y + '-' + pad(mon + 1) + '-' + pad(d);
    if (k < base) k = (y + 1) + '-' + pad(mon + 1) + '-' + pad(d);
    return k;
  }
  /* "the 15th": this month's, or next month's once this one has gone past it */
  function nextOfMonth(d, base) {
    var y = +base.slice(0, 4), m = +base.slice(5, 7) - 1;
    for (var i = 0; i < 13; i++) {
      var probe = new Date(y, m + i, d, 12);
      if (probe.getDate() === d) {                       // the month has that many days
        var k = dayKey(probe.getTime());
        if (k >= base) return k;
      }
    }
    return null;
  }
  /* what is left of the words: no filler up front, no dangling "at" at the end */
  function tidy(s) {
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:please\s+)?(?:remind me (?:to|about|of)|reminder (?:to|about|for)?:?|remember to|don'?t forget to|i (?:need|have|got|want|must|should) to|todo:?|task:?)\s+/i, '');
    s = s.replace(/[\s,;:.\-–]*(?:\b(?:at|by|on|for|from|until|till|before|around|in|to|and|then|this|next)\b[\s,;:.\-–]*)*$/i, '');
    s = s.replace(/^[\s,;:.\-–]+/, '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /* ---------- changing the list ---------- */
  function setFired(id, ms) {
    var f = load(LS_FIRED, {});
    f[id] = ms;
    save(LS_FIRED, f);
  }

  /* one task, changed: always later than what it replaces, so it wins everywhere */
  function change(id, fn, quiet) {
    var t = store.items[id];
    if (!t) return null;
    var n = {};
    Object.keys(t).forEach(function (k) { n[k] = t[k]; });
    fn(n);
    n.mod = Math.max(nowMs(), (t.mod || 0) + 1);
    store.items[id] = n;
    store.dirty = true;
    /* given a time that has already gone: it is simply overdue, not ringing */
    if (n.at && !n.done && !n.del && dueMs(n) <= nowMs()) setFired(id, nowMs());
    if (!quiet) afterChange();
    return n;
  }
  function afterChange() {
    persistStore();
    render();
    check();
    schedulePush();
  }
  function addFromText(raw, defDay, defAt) {
    var now = nowMs();
    var p = parseWhen(raw, now);
    if (!p.text) return null;
    var t = { id: uid(), text: p.text.slice(0, 200), day: p.day || defDay || dayKey(now), made: now, mod: now };
    var at = p.at || defAt || '';
    if (at) t.at = at;
    store.items[t.id] = t;
    store.dirty = true;
    if (at && dueMs(t) <= now) setFired(t.id, now);
    if (at) askNotifyOnce();
    afterChange();
    return t;
  }
  function finish(id, on) {
    change(id, function (t) {
      if (on) t.done = nowMs(); else delete t.done;
    });
  }
  function remove(id) {
    if (!store.items[id]) return;
    change(id, function (n) { n.del = nowMs(); });
    if (window.journalToast) {
      window.journalToast('Deleted — undo', '', 6000, function () {
        change(id, function (n) { delete n.del; });
      });
    }
  }
  /* push a task on: ten minutes, an hour, or to tomorrow (same time of day) */
  function snooze(id, how) {
    var now = nowMs();
    change(id, function (t) {
      if (how === 'tom') {
        t.day = addDays(dayKey(now), 1);
      } else {
        var at = Math.ceil((now + (how === 's60' ? 60 : 10) * 60000) / 60000) * 60000;
        t.day = dayKey(at);
        t.at = hm(at);
      }
      delete t.done;
    });
  }
  function bulkMove(ids, to) {
    var td = today();
    ids.forEach(function (id) {
      change(id, function (t) {
        /* a time that has already gone is dropped -- it moves as a task for the day, not
           for a moment; a time still ahead moves with it */
        if (t.at && dueMs({ day: td, at: t.at }) <= nowMs()) delete t.at;
        t.day = to === 'tomorrow' ? addDays(td, 1) : td;
      }, true);
    });
    afterChange();
  }

  /* ---------- the reminders ----------
     What should ring now? A pure question (so it can be tested):
       due      a task whose time has come and that this device has not rung for
       nag      one that has been ringing for a while: ring again every `nag` minutes
                (for four hours, not in quiet hours)
       checkin  at the evening check-in time, whatever is still open
     `fired` is when THIS device last rang for each task, so opening another page does
     not ring again, and a task that came due while the page was closed rings once. */
  var NAG_WINDOW = 4 * 3600e3;
  var STALE_DUE = 12 * 3600e3;
  function minutesOf(hhmm) { return +String(hhmm).slice(0, 2) * 60 + +String(hhmm).slice(3, 5); }
  function quiet(now, pf) {
    if (!pf.quiet) return false;
    var d = new Date(now);
    var m = d.getHours() * 60 + d.getMinutes();
    var a = minutesOf(pf.quietFrom), b = minutesOf(pf.quietTo);
    return a <= b ? (m >= a && m < b) : (m >= a || m < b);
  }
  function byDue(a, b) { return (dueMs(a) - dueMs(b)) || ((a.made || 0) - (b.made || 0)); }
  function byDay(a, b) {
    var x = a.day + ' ' + (a.at || '99:99'), y = b.day + ' ' + (b.at || '99:99');
    return (x < y ? -1 : x > y ? 1 : 0) || ((a.made || 0) - (b.made || 0));
  }
  function plan(now, items, fired, pf) {
    var out = { due: [], nag: [], checkin: null };
    var td = dayKey(now);
    var open = [];
    Object.keys(items).forEach(function (k) {
      var t = items[k];
      if (t.del || t.done) return;
      if (t.day <= td) open.push(t);
      var D = dueMs(t);
      if (!D || D > now) return;
      var f = fired[t.id] || 0;
      if (f < D) { if (now - D < STALE_DUE) out.due.push(t); }
      else if (pf.nag > 0 && now - D < NAG_WINDOW && now - f >= pf.nag * 60000 && !quiet(now, pf)) out.nag.push(t);
    });
    out.due.sort(byDue);
    out.nag.sort(byDue);
    if (pf.checkin && open.length && !fired['ck:' + td] && !quiet(now, pf)) {
      var C = dayMs(td, +String(pf.checkinAt).slice(0, 2), +String(pf.checkinAt).slice(3, 5));
      if (now >= C && now - C < 4 * 3600e3) out.checkin = open.sort(byDay);
    }
    return out;
  }

  var ready = false;        // the clock has been checked: not before, or a wrong one would ring
  var alarm = null;         // what is on screen: { kind, ids }
  function check() {
    if (!ready) return;
    var fired = load(LS_FIRED, {});
    var p = plan(nowMs(), store.items, fired, prefs);
    if (alarm) p.checkin = null;
    if (!p.due.length && !p.nag.length && !p.checkin) return;
    fire(p, fired);
  }
  function fire(p, fired) {
    var now = nowMs();
    var kind = p.due.length ? 'due' : p.nag.length ? 'nag' : 'checkin';
    var ids;
    if (kind === 'checkin') {
      fired['ck:' + dayKey(now)] = now;
      ids = p.checkin.map(function (t) { return t.id; });
    } else {
      var list = p.due.concat(p.nag);
      list.forEach(function (t) { fired[t.id] = now; });
      ids = list.map(function (t) { return t.id; });
    }
    /* a week of these is plenty */
    Object.keys(fired).forEach(function (k) { if (now - fired[k] > 7 * DAY) delete fired[k]; });
    save(LS_FIRED, fired);
    announce(kind, ids, true);
  }

  /* put an alarm on screen. loud: this tab is the one that rings (the other tabs, and
     the next page, show it without a sound) */
  function announce(kind, ids, loud) {
    if (alarm && alarm.kind !== 'checkin' && kind !== 'checkin') {
      ids = alarm.ids.concat(ids.filter(function (id) { return alarm.ids.indexOf(id) < 0; }));
    }
    alarm = { kind: kind, ids: ids };
    render(true);
    if (!loud) return;
    if (kind !== 'test') save(LS_RING, { kind: kind, ids: ids, at: nowMs(), n: Math.random() });
    var first = store.items[ids[0]];
    ring(kind);
    if (kind === 'checkin') {
      /* no buttons: Done would have to mean one task out of several */
      notify('Evening check-in', ids.length + (ids.length === 1 ? ' task is' : ' tasks are') + ' still open.', [], false);
    } else if (first) {
      notify(ids.length > 1 ? ids.length + ' tasks due' : first.text,
        ids.length > 1 ? first.text + ' and ' + (ids.length - 1) + ' more' : 'Due ' + first.at + (kind === 'nag' ? ' — still open' : ''),
        ids, kind === 'due');
    }
  }
  function clearAlarm() {
    alarm = null;
    save(LS_RING, null);
    render(true);
  }

  /* ---------- the bell ----------
     A temple bell, synthesised -- the same one the focus timer rings. Browsers only
     allow sound after a touch or a key, so it is unlocked by the first one. */
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
  function ring(kind) {
    try { if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 500]); } catch (e) {}
    if (!prefs.sound) return;
    bells(kind === 'due' ? 3 : kind === 'nag' ? 2 : 1);
  }

  /* ---------- notifications ---------- */
  var swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (r) { swReg = r; }, function () {});
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type === 'todo-action') act(d.action, (d.ids || [])[0]);
    });
  }
  function notify(title, body, ids, stay) {
    if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    var plain = function () {
      try { new Notification(title, { body: body, tag: 'todo', requireInteraction: !!stay, icon: '/icon-192.png' }); } catch (e) {}
    };
    if (swReg && swReg.showNotification) {
      swReg.showNotification(title, {
        body: body, tag: 'todo', renotify: true, requireInteraction: !!stay,
        icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [300, 120, 300],
        data: { ids: ids },
        actions: ids.length ? [{ action: 'done', title: 'Done' }, { action: 's10', title: 'In 10 min' }] : []
      }).catch(plain);
    } else {
      plain();
    }
  }
  /* asked when a first reminder is set -- the one moment it is plainly wanted */
  function askNotifyOnce() {
    if (!('Notification' in window) || Notification.permission !== 'default' || prefs.asked) return;
    prefs.asked = true;
    save(LS_PREFS, prefs);
    try {
      var p = Notification.requestPermission(renderSettings);
      if (p && p.then) p.then(renderSettings);
    } catch (e) {}
  }

  /* what a button, or a notification's button, does to a task */
  function act(action, id) {
    var t = id && store.items[id];
    if (!t || t.del) return;
    if (action === 'done') finish(id, true);
    else if (action === 's10' || action === 's60' || action === 'tom') snooze(id, action);
  }

  /* ---------- the banner ---------- */
  var BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4s2-1.5 2-6.5z"/><path d="M10 19.5a2 2 0 0 0 4 0"/></svg>';
  var alarmSig = '';
  function renderAlarm() {
    var el = $('todoalarm');
    if (!alarm) { if (el) { el.hidden = true; alarmSig = ''; } return; }
    var now = nowMs(), td = dayKey(now);
    var ids = alarm.ids.filter(function (id) { var t = store.items[id]; return t && !t.del && !t.done; });
    if (alarm.kind === 'checkin') ids = ids.filter(function (id) { return store.items[id].day <= td; });
    if (!ids.length && alarm.kind !== 'test') { alarm = null; save(LS_RING, null); if (el) el.hidden = true; return; }
    alarm.ids = ids;
    var first = store.items[ids[0]];
    var title, sub, acts;
    if (alarm.kind === 'test') {
      title = 'This is what a reminder looks like';
      sub = 'The bell and this banner are working.';
      acts = '<button type="button" class="btn primary" data-a="dismiss">OK</button>';
    } else if (alarm.kind === 'checkin') {
      title = 'Evening check-in';
      sub = ids.length + (ids.length === 1 ? ' task is' : ' tasks are') + ' still open: '
        + ids.slice(0, 3).map(function (id) { return store.items[id].text; }).join(', ') + (ids.length > 3 ? ' and ' + (ids.length - 3) + ' more' : '') + '.';
      acts = '<a class="btn primary" href="/tasks/">Open tasks</a>'
        + '<button type="button" class="btn" data-a="movetom">Move to tomorrow</button>'
        + '<button type="button" class="btn ghost" data-a="dismiss">Later</button>';
    } else {
      var late = first.at && dueMs(first) < now ? Math.max(0, Math.round((now - dueMs(first)) / 60000)) : 0;
      title = first.text;
      sub = (first.at ? 'Due ' + first.at : 'Due') + (late ? ' · ' + (late < 90 ? late + ' min' : Math.round(late / 60) + ' h') + ' ago' : ' now')
        + (alarm.kind === 'nag' ? ' — still open' : '');
      acts = '<button type="button" class="btn primary" data-a="done">Done</button>'
        + '<button type="button" class="btn" data-a="s10">10 min</button>'
        + '<button type="button" class="btn" data-a="s60">1 hour</button>'
        + '<button type="button" class="btn ghost" data-a="tom">Tomorrow</button>';
    }
    var html = '<div class="tahead"><span class="tabell">' + BELL + '</span>'
      + '<div class="tatext"><p class="tatitle">' + esc(title) + '</p><p class="tasub">' + esc(sub) + '</p></div>'
      + '<button type="button" class="taclose" data-a="dismiss" aria-label="Dismiss">×</button></div>'
      + '<div class="taacts">' + acts + '</div>'
      + (ids.length > 1 && alarm.kind !== 'checkin' ? '<p class="tamore">' + (ids.length - 1) + ' more waiting · <a href="/tasks/">Open tasks</a></p>' : '');
    if (!el) {
      el = document.createElement('div');
      el.id = 'todoalarm';
      el.className = 'todoalarm';
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-live', 'assertive');
      document.body.appendChild(el);
      el.addEventListener('click', onAlarmClick);
    }
    /* only when something changed: rebuilding the buttons under a finger loses the tap */
    if (html !== alarmSig) { el.innerHTML = html; alarmSig = html; }
    el.hidden = false;
  }
  function onAlarmClick(e) {
    var b = e.target.closest('[data-a]');
    if (!b || !alarm) return;
    var a = b.dataset.a;
    if (a === 'dismiss') { clearAlarm(); return; }
    if (a === 'movetom') {
      var td = today();
      var ids = alarm.ids.filter(function (id) { return store.items[id] && store.items[id].day <= td; });
      clearAlarm();
      bulkMove(ids, 'tomorrow');
      return;
    }
    act(a, alarm.ids[0]);
  }

  /* ---------- the page ---------- */
  var editing = null;       // the task whose edit form is open
  var form = { day: null, at: '' };

  function rowHtml(t, c) {
    var meta = '';
    if (t.at) meta += '<span class="tm">' + esc(t.at) + '</span>';
    if (c.kind === 'late') meta += '<span class="tlate">' + esc(lateText(t, c.now, c.td)) + '</span>';
    else if (c.kind === 'done' && t.done) meta += '<span>done ' + esc(hm(t.done)) + (dayKey(t.done) !== c.td ? ' · ' + esc(dayLabel(dayKey(t.done), c.td)) : '') + '</span>';
    var on = !!t.done;
    var cls = 'trow' + (on ? ' done' : '') + (c.kind === 'late' ? ' late' : '') + (alarm && alarm.ids.indexOf(t.id) >= 0 ? ' ringing' : '');
    var tick = '<button type="button" class="tick" role="checkbox" aria-checked="' + on + '" aria-label="'
      + (on ? 'Not done: ' : 'Done: ') + esc(t.text) + '"></button>';
    var title = '<span class="ttitle">' + esc(t.text) + '</span>' + (meta ? '<span class="tmeta">' + meta + '</span>' : '');
    if (c.compact) return '<li class="' + cls + '" data-id="' + esc(t.id) + '">' + tick + '<span class="tbody">' + title + '</span></li>';
    if (editing !== t.id) return '<li class="' + cls + '" data-id="' + esc(t.id) + '">' + tick + '<button type="button" class="tbody" data-a="edit">' + title + '</button></li>';
    var day = t.day === c.td ? 'today' : t.day === addDays(c.td, 1) ? 'tomorrow' : 'other';
    return '<li class="trow editing" data-id="' + esc(t.id) + '"><form class="tedit" data-id="' + esc(t.id) + '" autocomplete="off">'
      + '<input class="tx" type="text" maxlength="200" value="' + esc(t.text) + '" aria-label="Task">'
      + '<div class="tchips">'
      + '<button type="button" class="tchip" data-d="today" data-on="' + (day === 'today') + '">Today</button>'
      + '<button type="button" class="tchip" data-d="tomorrow" data-on="' + (day === 'tomorrow') + '">Tomorrow</button>'
      + '<label class="tchip" data-on="' + (day === 'other') + '"><span class="tdaytext">' + (day === 'other' ? esc(dayLabel(t.day, c.td)) : 'Pick a day') + '</span>'
      + '<input class="td" type="date" value="' + esc(t.day) + '" aria-label="Day"></label>'
      + '<label class="tchip" data-on="' + !!t.at + '"><span class="ttimetext">' + (t.at ? esc(t.at) : 'Add a time') + '</span>'
      + '<input class="tt" type="time" value="' + esc(t.at || '') + '" aria-label="Time"></label>'
      + '</div>'
      + '<div class="tactions"><button type="submit" class="btn primary">Save</button>'
      + '<button type="button" class="btn" data-a="s10">+10 min</button>'
      + '<button type="button" class="btn" data-a="s60">+1 hour</button>'
      + '<button type="button" class="btn" data-a="tom">Tomorrow</button>'
      + '<button type="button" class="btn ghost" data-a="del">Delete</button></div></form></li>';
  }

  /* the buckets the page and the cards both use */
  function buckets(now) {
    var td = dayKey(now);
    var b = { late: [], today: [], later: [], done: [], td: td, now: now };
    liveTasks().forEach(function (t) {
      if (t.done) { if (now - t.done < 7 * DAY) b.done.push(t); return; }
      if (t.day < td) b.late.push(t);
      else if (t.day === td) (t.at && dueMs(t) <= now ? b.late : b.today).push(t);
      else b.later.push(t);
    });
    b.late.sort(byDay);
    b.today.sort(byDay);
    b.later.sort(byDay);
    b.done.sort(function (x, y) { return y.done - x.done; });
    return b;
  }

  function renderApp() {
    if (!app) return;
    var now = nowMs();
    var b = buckets(now);
    var rows = function (list, kind) {
      return list.map(function (t) { return rowHtml(t, { kind: kind, now: now, td: b.td }); }).join('');
    };
    var html = '';
    if (b.late.length) {
      html += '<section class="card todolist lates"><div class="cardhead"><h3>Overdue</h3><span class="count">' + b.late.length + '</span></div>'
        + '<ul class="tlist">' + rows(b.late, 'late') + '</ul>'
        + '<div class="tbulk"><button type="button" class="btn" data-bulk="today">Move all to today</button></div></section>';
    }
    html += '<section class="card todolist"><div class="cardhead"><h3>Today</h3><span class="count">'
      + (b.today.length ? b.today.length + ' to do' : '') + '</span></div>'
      + (b.today.length
        ? '<ul class="tlist">' + rows(b.today, 'today') + '</ul>'
        : '<p class="muted small tempty">' + (b.late.length ? 'Nothing else is due today.'
          : (b.later.length || b.done.length ? 'Nothing left for today.'
            : 'Nothing on the list. Add what has to happen today — give it a time and it gets a bell.')) + '</p>')
      + '</section>';
    if (b.later.length) {
      var groups = [];
      b.later.forEach(function (t) {
        var g = groups[groups.length - 1];
        if (!g || g.day !== t.day) { g = { day: t.day, list: [] }; groups.push(g); }
        g.list.push(t);
      });
      html += '<section class="card todolist"><div class="cardhead"><h3>Coming up</h3><span class="count">' + b.later.length + '</span></div>'
        + groups.map(function (g) {
          return '<p class="tday">' + esc(dayLabel(g.day, b.td)) + '</p><ul class="tlist">' + rows(g.list, 'later') + '</ul>';
        }).join('') + '</section>';
    }
    if (b.done.length) {
      html += '<details class="card todolist tdone"' + (app.dataset.doneOpen ? ' open' : '') + '><summary class="cardhead"><h3>Done this week</h3><span class="count">'
        + b.done.length + '</span></summary><ul class="tlist">' + rows(b.done, 'done') + '</ul></details>';
    }
    $('tlists').innerHTML = html;
  }

  function renderCards() {
    if (!cards.length) return;
    var now = nowMs();
    var b = buckets(now);
    var SHOW = 5;
    cards.forEach(function (card) {
      var day = card.dataset.todoDay;
      var open = day === b.td ? b.late.concat(b.today)
        : b.today.concat(b.later).filter(function (t) { return t.day === day; });
      var doneN = liveTasks().filter(function (t) { return t.done && t.day === day; }).length;
      var total = open.length + doneN;
      var count = card.querySelector('[data-todo-count]');
      var empty = card.querySelector('[data-todo-empty]');
      card.querySelector('[data-todo-list]').innerHTML = open.slice(0, SHOW).map(function (t) {
        var late = t.day < b.td || (t.at && dueMs(t) <= now && t.day === b.td);
        return rowHtml(t, { kind: late ? 'late' : 'today', now: now, td: b.td, compact: true });
      }).join('') + (open.length > SHOW ? '<li class="tmore"><a href="/tasks/">' + (open.length - SHOW) + ' more →</a></li>' : '');
      count.textContent = !total ? '' : open.length ? open.length + ' left' + (doneN ? ' · ' + doneN + ' done' : '') : 'all done ✓';
      count.classList.toggle('met', total > 0 && !open.length);
      empty.hidden = open.length > 0;
      empty.textContent = total ? 'Everything on this list is done.' : (day === b.td ? 'Nothing on today’s list yet.' : 'Nothing planned for this day yet.');
      var loc = card.querySelector('[data-todo-local]');
      if (loc) {
        loc.hidden = syncState !== 'local';
        if (!loc.firstChild) loc.innerHTML = 'Not connected — these stay on this device. <a href="/admin/#setup">Connect it once</a>.';
      }
    });
  }

  function renderStatus() {
    var el = $('tstatus');
    if (!el) return;
    var text = {
      local: 'This browser isn’t connected, so these tasks stay on this device only. <a href="/admin/#setup">Connect it once</a> and your list follows you to every device.',
      offline: 'Can’t reach GitHub right now. Your changes are safe on this device and go up as soon as there is a connection.',
      badtoken: 'GitHub rejected this browser’s token — <a href="/admin/#setup">reconnect it</a>. Your changes are safe on this device.'
    }[syncState] || '';
    el.hidden = !text;
    el.className = 'todonote' + (syncState === 'local' ? ' info' : ' warn');
    el.innerHTML = text;
  }

  function renderSettings() {
    renderStatus();
    var el = $('tsync');
    if (el) {
      el.innerHTML = {
        local: 'Not connected: the list is on this device only.',
        ok: store.dirty ? 'Saving…' : 'In sync — the list follows you to your other devices.' + (lastSyncAt ? ' Last checked ' + hm(lastSyncAt) + '.' : ''),
        offline: 'Offline — changes go up when there is a connection.',
        badtoken: 'The token was rejected — reconnect under Write → ⚙.'
      }[syncState] || '';
    }
    if (!app) return;
    $('tsound').checked = !!prefs.sound;
    $('tnag').value = String(prefs.nag);
    $('tcheckin').checked = !!prefs.checkin;
    $('tcheckinat').value = prefs.checkinAt;
    $('tquiet').checked = !!prefs.quiet;
    $('tquietfrom').value = prefs.quietFrom;
    $('tquietto').value = prefs.quietTo;
    var st = $('tnotifystate');
    var nb = $('tnotify');
    if (!('Notification' in window)) {
      st.textContent = /iP(hone|ad|od)/.test(navigator.userAgent)
        ? 'On iPhone, notifications need this site on the Home Screen (Share → Add to Home Screen). With the page open, the bell and the banner still work.'
        : 'This browser cannot show notifications. The bell and the banner still work while the page is open.';
      nb.hidden = true;
    } else {
      var p = Notification.permission;
      st.textContent = p === 'granted' ? 'Notifications are on — a reminder shows even when you are in another tab.'
        : p === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings.'
          : 'Get a notification when a task is due, even from another tab.';
      nb.hidden = p !== 'default';
    }
  }

  function renderForm() {
    if (!app) return;
    var td = today();
    if (!form.day) form.day = td;
    $$('#twhen [data-pick]').forEach(function (b) {
      var on = form.day === (b.dataset.pick === 'today' ? td : addDays(td, 1));
      b.dataset.on = String(on);
      b.setAttribute('aria-pressed', String(on));
    });
    var other = form.day !== td && form.day !== addDays(td, 1);
    $('tpickday').dataset.on = String(other);
    $('tdaytext').textContent = other ? dayLabel(form.day, td) : 'Pick a day';
    $('tdate').value = other ? form.day : '';
    $('tpicktime').dataset.on = String(!!form.at);
    $('ttimetext').textContent = form.at || 'Add a time';
    $('ttime').value = form.at || '';
    $('ttimeclear').hidden = !form.at;
  }
  /* what the words will become, shown as they are typed */
  function preview() {
    var el = $('tparsed');
    if (!el) return;
    var v = $('ttext').value;
    if (!v.trim()) { el.hidden = true; return; }
    var p = parseWhen(v, nowMs());
    if (!p.text || (!p.day && !p.at)) { el.hidden = true; return; }
    var day = p.day || form.day || today(), at = p.at || form.at;
    el.hidden = false;
    el.innerHTML = 'Will be added as <b>' + esc(p.text) + '</b> · ' + esc(dayLabel(day, today()) + (at ? ' · ' + at : ''));
  }

  /* background: it came from a poll, a tick or another tab -- not from a finger, so it
     must not pull an open edit form out from under the person typing in it */
  function render(background) {
    if (background && editing) { renderCards(); renderAlarm(); renderSettings(); return; }
    renderApp();
    renderCards();
    renderAlarm();
    renderSettings();
    renderForm();
  }

  /* ---------- dictation ----------
     One sentence a tap, and always a fresh recogniser: Safari will not restart one that
     has finished. (On an iPhone the keyboard's own mic key is the better way, and works
     in the same box.) */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  function note(text, kind) {
    var el = $('tnote');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'fnote' + (kind ? ' ' + kind : '');
  }
  function setMic(on) {
    var b = $('tmic');
    if (b) b.setAttribute('aria-pressed', String(!!on));
  }
  function startMic() {
    if (!SR) return;
    var input = $('ttext');
    try {
      rec = new SR();
      rec.lang = (app && app.dataset.lang) || 'en-IN';
      rec.continuous = false;
      rec.interimResults = true;
      var before = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
      rec.onresult = function (e) {
        var text = '';
        for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        input.value = before + text.trim();
        preview();
      };
      rec.onerror = function (e) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') note('The microphone is blocked. Allow it for this site, or use your keyboard’s mic key.', 'err');
        else if (e.error === 'network') note('Dictation needs a connection.', 'err');
        else if (e.error !== 'no-speech' && e.error !== 'aborted') note(e.error, 'err');
      };
      rec.onend = function () { setMic(false); rec = null; input.focus(); };
      rec.start();
      setMic(true);
      note('Listening…');
    } catch (err) {
      setMic(false);
      note(err.message, 'err');
    }
  }
  function stopMic() { if (rec) { try { rec.stop(); } catch (e) {} } }

  /* ---------- wiring ---------- */
  /* the day and time chips in an open edit form follow what the inputs hold */
  function syncEditChips(f) {
    var td = today(), v = f.querySelector('.td').value, at = f.querySelector('.tt').value;
    var chips = $$('.tchip', f);
    var other = !!v && v !== td && v !== addDays(td, 1);
    chips[0].dataset.on = String(v === td);
    chips[1].dataset.on = String(v === addDays(td, 1));
    chips[2].dataset.on = String(other);
    chips[3].dataset.on = String(!!at);
    f.querySelector('.tdaytext').textContent = other ? dayLabel(v, td) : 'Pick a day';
    f.querySelector('.ttimetext').textContent = at || 'Add a time';
  }

  if (app) {
    var micBtn = $('tmic');
    if (SR) micBtn.hidden = false;
    micBtn.addEventListener('click', function () { if (rec) stopMic(); else startMic(); });

    $('ttext').addEventListener('input', preview);
    $('twhen').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]');
      if (!b) return;
      form.day = b.dataset.pick === 'today' ? today() : addDays(today(), 1);
      renderForm();
      preview();
    });
    $('tdate').addEventListener('change', function () { if (this.value) { form.day = this.value; renderForm(); preview(); } });
    $('ttime').addEventListener('change', function () { form.at = this.value || ''; renderForm(); preview(); });
    $('ttimeclear').addEventListener('click', function () { form.at = ''; renderForm(); preview(); });
    $('tform').addEventListener('submit', function (e) {
      e.preventDefault();
      stopMic();
      var v = $('ttext').value;
      if (!v.trim()) { note('What has to be done?', 'err'); $('ttext').focus(); return; }
      var t = addFromText(v, form.day, form.at);
      if (!t) { note('Say what has to be done, not just when.', 'err'); return; }
      $('ttext').value = '';
      form.day = today();
      form.at = '';
      renderForm();
      preview();
      note('Added: ' + t.text + ' · ' + dayLabel(t.day, today()) + (t.at ? ' · ' + t.at : ''));
      $('ttext').focus();
    });

    var lists = $('tlists');
    lists.addEventListener('click', function (e) {
      var bulk = e.target.closest('[data-bulk]');
      if (bulk) {
        var td = today(), now = nowMs();
        bulkMove(liveTasks().filter(function (t) { return !t.done && (t.day < td || (t.day === td && t.at && dueMs(t) <= now)); })
          .map(function (t) { return t.id; }), 'today');
        return;
      }
      var sum = e.target.closest('details.tdone > summary');
      if (sum) { app.dataset.doneOpen = sum.parentNode.open ? '' : '1'; return; }
      var row = e.target.closest('.trow');
      if (!row) return;
      var id = row.dataset.id;
      if (e.target.closest('.tick')) {
        editing = null;
        finish(id, !store.items[id].done);
        return;
      }
      var a = e.target.closest('[data-a]');
      if (a && a.dataset.a === 'edit') {
        editing = editing === id ? null : id;
        render();
        var tx = editing && lists.querySelector('.tedit .tx');
        if (tx) { tx.focus(); try { tx.setSelectionRange(tx.value.length, tx.value.length); } catch (err) {} }
        return;
      }
      if (a && editing === id) {
        if (a.dataset.a === 'del') { editing = null; remove(id); return; }
        if (a.dataset.a === 's10' || a.dataset.a === 's60' || a.dataset.a === 'tom') { editing = null; snooze(id, a.dataset.a); return; }
      }
      var chip = e.target.closest('.tchip[data-d]');
      if (chip && editing === id) {
        var f = chip.closest('form');
        f.querySelector('.td').value = chip.dataset.d === 'today' ? today() : addDays(today(), 1);
        syncEditChips(f);
      }
    });
    lists.addEventListener('change', function (e) {
      var f = e.target.closest('form.tedit');
      if (f) syncEditChips(f);
    });
    lists.addEventListener('submit', function (e) {
      var f = e.target.closest('form.tedit');
      if (!f) return;
      e.preventDefault();
      var id = f.dataset.id;
      var text = f.querySelector('.tx').value.trim();
      var day = f.querySelector('.td').value || today();
      var at = f.querySelector('.tt').value;
      editing = null;
      if (!text) { render(); return; }
      change(id, function (t) {
        t.text = text.slice(0, 200);
        t.day = day;
        if (at) t.at = at; else delete t.at;
      });
      if (at) askNotifyOnce();
    });
    lists.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && editing) { editing = null; render(); }
    });

    /* settings */
    $('tsound').addEventListener('change', function () { prefs.sound = this.checked; save(LS_PREFS, prefs); if (prefs.sound) { unlockAudio(); bells(1); } });
    $('tnag').addEventListener('change', function () { prefs.nag = +this.value || 0; save(LS_PREFS, prefs); });
    $('tcheckin').addEventListener('change', function () { prefs.checkin = this.checked; save(LS_PREFS, prefs); });
    $('tcheckinat').addEventListener('change', function () { if (this.value) { prefs.checkinAt = this.value; save(LS_PREFS, prefs); } });
    $('tquiet').addEventListener('change', function () { prefs.quiet = this.checked; save(LS_PREFS, prefs); });
    $('tquietfrom').addEventListener('change', function () { if (this.value) { prefs.quietFrom = this.value; save(LS_PREFS, prefs); } });
    $('tquietto').addEventListener('change', function () { if (this.value) { prefs.quietTo = this.value; save(LS_PREFS, prefs); } });
    $('tnotify').addEventListener('click', function () {
      try {
        var p = Notification.requestPermission(renderSettings);
        if (p && p.then) p.then(renderSettings);
      } catch (e) {}
    });
    $('ttest').addEventListener('click', function () {
      unlockAudio();
      announce('test', [], true);
      notify('This is what a reminder looks like', 'The bell and this notification are working.', [], false);
    });
  }

  /* a card on Today: tick a task, or add one */
  cards.forEach(function (card) {
    card.addEventListener('click', function (e) {
      var row = e.target.closest('.trow');
      if (!row || !e.target.closest('.tick')) return;
      var t = store.items[row.dataset.id];
      if (t) finish(t.id, !t.done);
    });
    var f = card.querySelector('[data-todo-form]');
    if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = f.querySelector('input');
      if (!input.value.trim()) return;
      var t = addFromText(input.value, card.dataset.todoDay, '');
      if (!t) return;
      input.value = '';
      if (window.journalToast) {
        window.journalToast('Added: ' + t.text + (t.day !== card.dataset.todoDay ? ' · ' + dayLabel(t.day, today()) : '') + (t.at ? ' · ' + t.at : ''));
      }
    });
  });

  /* browsers only allow sound after a touch or a key -- take the first one */
  var lastTouch = 0;
  var firstTouch = function () { lastTouch = Date.now(); unlockAudio(); };
  document.addEventListener('pointerdown', firstTouch, true);
  document.addEventListener('keydown', firstTouch, true);

  /* ---------- the tick ---------- */
  var lastDay = null;
  var lastMinute = 0;
  function tick() {
    var td = today();
    if (lastDay && td !== lastDay) { form.day = td; render(); }
    lastDay = td;
    check();
    /* "25 min late" and which bucket a task is in change with the clock; a quiet
       redraw once a minute, never while a finger is on the page */
    var m = Math.floor(Date.now() / 60000);
    if (m !== lastMinute && ready) {
      lastMinute = m;
      if (Date.now() - lastTouch > 3000) render(true);
    }
  }
  var worker = null;
  try {
    worker = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},5000)'], { type: 'text/javascript' })));
    worker.onmessage = tick;
  } catch (e) { worker = null; setInterval(tick, 5000); }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    tick();
    sync(true);
    render(true);
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { tick(); sync(true); render(true); } });
  window.addEventListener('online', function () { sync(true); });
  setInterval(function () { if (document.visibilityState === 'visible') sync(false); }, 3000);
  setInterval(measureSkew, 10 * 60 * 1000);

  /* another tab of this site changed the list, or rang a reminder */
  window.addEventListener('storage', function (e) {
    if (e.key === LS_STORE) {
      var s = load(LS_STORE, null);
      if (s && s.items) {
        var items = {};
        Object.keys(s.items).forEach(function (k) { var t = clean(s.items[k]); if (t) items[t.id] = t; });
        store.items = merge(store.items, items);
        if (s.etag) store.etag = s.etag;
        render(true);
        check();
      }
    } else if (e.key === LS_PREFS) {
      prefs = load(LS_PREFS, prefs);
      renderSettings();
    } else if (e.key === LS_RING) {
      var r = load(LS_RING, null);
      if (r && r.ids) announce(r.kind, r.ids, false);
      else if (!r && alarm) { alarm = null; render(true); }
    }
  });

  /* ---------- boot ---------- */
  render();
  /* a reminder that was on screen when the last page closed is still on screen */
  (function () {
    var r = load(LS_RING, null);
    if (r && r.ids && Date.now() - (r.at || 0) < 2 * 3600e3) announce(r.kind, r.ids, false);
    else if (r) save(LS_RING, null);
  })();
  var started = false;
  function start() {
    if (started) return;
    started = true;
    ready = true;
    lastDay = today();
    form.day = lastDay;
    /* a button on a notification, when the notification had to open this page */
    var m = /[?&]do=(done|s10|s60|tom)&id=([\w-]+)/.exec(location.search);
    if (m) {
      act(m[1], m[2]);
      history.replaceState(null, '', location.pathname);
    }
    if (location.hash === '#add' && $('ttext')) $('ttext').focus();
    render();
    check();
    sync(true);
  }
  /* the clock first; if that cannot be had, go on without it */
  measureSkew().then(start);
  setTimeout(start, 6000);

  /* a hook for the tests, nothing else */
  if (typeof window.__todoTest === 'function') {
    window.__todoTest({
      parseWhen: parseWhen, merge: merge, prune: prune, toFile: toFile, plan: plan, clean: clean, dueMs: dueMs,
      store: function () { return store; }, prefs: function () { return prefs; }
    });
  }
})();
