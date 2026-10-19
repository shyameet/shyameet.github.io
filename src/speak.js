/* The Speak page: practise talking, and keep proof.

   A topic (or free talk), a thinking timer, a speaking timer, the words as dictated, and
   a plain read-out of how the talk went: pace, filler words, restarts, how long it took to
   begin, which topic words were touched. Every take is saved as text -- never audio --
   into a PRIVATE repository (meta "speech-repo"), one file per day, takes/YYYY-MM-DD.json,
   written through the same token the rest of the site uses. The journal repo is public;
   this one is not, so nothing spoken here is ever published.

   A take is never lost: Save puts it in this browser's queue first (speak_q_v1), then
   sends it, and a take that could not be sent (offline, no access yet) waits in the queue
   and goes the next time the page is open.

   Honest limit: the browser's dictation drops "um" and "uh" before the page ever sees the
   words, and gives no pauses. So the count here is of the fillers dictation keeps ("like",
   "you know", "I mean", "so"...) and is an estimate; the page says so. The nightly coaching
   (coaching/YYYY-MM-DD.md in the same repo) is shown here when it exists. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var metaOf = function (name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return m ? m.content : '';
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  /* ================= analysis (pure) ================= */

  var HARD = { um: 1, umm: 1, ummm: 1, uhm: 1, uh: 1, uhh: 1, er: 1, erm: 1, ah: 1, ahh: 1, hmm: 1, hm: 1, mmm: 1, mm: 1 };
  var PHRASES2 = ['you know', 'i mean', 'kind of', 'sort of', 'you see', 'or something', 'and stuff', 'and all'];
  var WORDS1 = { basically: 1, literally: 1, actually: 1, honestly: 1, obviously: 1 };
  /* "like" is a real word more often than a filler: these neighbours make it a real one */
  var LIKE_PREV = ' i you we they he she would do dont don\'t didn\'t did look looks looked feel feels felt sound sounds sounded seem seems something nothing anything just much smell smells taste tastes people who that ';
  var LIKE_NEXT = ' to it that them him her us this these those a an the ';
  var SO_PREV = ' and but okay ok well yeah um uh umm right so ';
  var SO_NEXT = ' yeah basically um uh like okay ok anyway ';
  var KIND_PREV = ' what this that which a the some any every same different other one all another each ';
  var KNOW_PREV = " do did if as can would will should could dont don't didn't ";
  var MEAN_PREV = ' what this that is it ';
  var NO_RESTART = ' very really more many so much no yes bye ';
  var STOP = (' about above after again against also always among another because been before being below between both could did does doing down during each ' +
    'even every first from further have having here into just keep know made make many might more most much must never only other over really said same ' +
    'should since some still such than that their them then there these they thing things think this those through today under until very want wants ' +
    'well were what when where which while will with without would your yours ours ourselves yourself myself himself herself itself ' +
    'gives give gave makes making like likes liked going goes went come comes came get gets got say says one two ' +
    'explain describe convince argue tell story pitch persuade sell defend introduce welcome present thank break someone person friend ').split(' ');
  var STOPSET = {};
  STOP.forEach(function (w) { if (w) STOPSET[w] = 1; });

  function tokenize(text) {
    var t = String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[-–—]/g, ' ');
    t = t.replace(/[^a-z0-9'\s]/g, ' ');
    return t.split(/\s+/).filter(Boolean);
  }
  var has = function (set, w) { return set.indexOf(' ' + w + ' ') >= 0; };
  function stem(w) {
    return w.replace(/(ing|ed|es|s|ly)$/, '');
  }
  function sameStem(a, b) {
    var x = stem(a), y = stem(b);
    if (x === y) return true;
    return x.length >= 4 && y.length >= 4 && (x.indexOf(y) === 0 || y.indexOf(x) === 0);
  }

  /* what the words show. opts: sec (seconds spoken), delay (seconds before the first
     word, or null), topic (the prompt, or ''). */
  function analyze(text, opts) {
    opts = opts || {};
    var tk = tokenize(text);
    var n = tk.length;
    var fill = {};
    var total = 0;
    var soTotal = 0;
    var add = function (k) { fill[k] = (fill[k] || 0) + 1; total++; };

    for (var i = 0; i < n; i++) {
      var w = tk[i], nx = tk[i + 1] || '', pv = tk[i - 1] || '';
      if (HARD[w]) { add(w); continue; }
      var two = w + ' ' + nx;
      if (nx && PHRASES2.indexOf(two) >= 0) {
        /* "what kind of", "do you know", "what I mean" are ordinary speech, not padding */
        var ok = !(((two === 'kind of' || two === 'sort of') && has(KIND_PREV, pv))
          || (two === 'you know' && has(KNOW_PREV, pv)) || (two === 'i mean' && has(MEAN_PREV, pv)));
        if (ok) add(two);
        i++;
        continue;
      }
      if (WORDS1[w]) { add(w); continue; }
      if (w === 'like') {
        if (!has(LIKE_PREV, pv) && !has(LIKE_NEXT, nx)) add('like');
        continue;
      }
      if (w === 'so') {
        soTotal++;
        if (i === 0 || has(SO_PREV, pv) || has(SO_NEXT, nx)) add('so');
        continue;
      }
      if (w === 'well' && i === 0) add('well');
    }

    /* a stumble: the same word, or the same two or three words, said twice in a row */
    var restarts = 0;
    for (var j = 0; j < n; j++) {
      var hit = 0;
      for (var len = 3; len >= 1 && !hit; len--) {
        if (j + 2 * len > n) continue;
        var same = true;
        for (var k = 0; k < len; k++) if (tk[j + k] !== tk[j + len + k]) { same = false; break; }
        if (same && !(len === 1 && has(NO_RESTART, tk[j]))) hit = len;
      }
      if (hit) { restarts++; j += hit * 2 - 1; }
    }

    /* the content words said three times or more */
    var counts = {};
    tk.forEach(function (w2) { if (w2.length > 3 && !STOPSET[w2] && !HARD[w2] && !WORDS1[w2]) counts[w2] = (counts[w2] || 0) + 1; });
    var repeated = Object.keys(counts).filter(function (w3) { return counts[w3] >= 3; })
      .sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); })
      .slice(0, 3).map(function (w4) { return [w4, counts[w4]]; });

    /* which words of the topic were touched */
    var touched = [], missed = [];
    if (opts.topic) {
      var seen = {};
      tokenize(opts.topic).forEach(function (tw) {
        if (tw.length < 4 || STOPSET[tw] || seen[tw]) return;
        seen[tw] = 1;
        var found = tk.some(function (sw) { return sameStem(sw, tw); });
        (found ? touched : missed).push(tw);
      });
    }

    var sec = +opts.sec || 0;
    var min = sec / 60;
    var out = {
      words: n,
      sec: sec,
      wpm: sec >= 5 ? Math.round(n / min) : null,
      fillers: fill,
      fillerTotal: total,
      fillerPerMin: sec >= 5 ? Math.round(total / min * 10) / 10 : null,
      fillerPer100: n ? Math.round(total / n * 1000) / 10 : 0,
      soTotal: soTotal,
      restarts: restarts,
      delay: opts.delay == null ? null : Math.round(opts.delay * 10) / 10,
      repeated: repeated,
      touched: touched,
      missed: missed
    };
    return out;
  }

  /* at most two plain tips, the biggest problem first */
  function tips(st, kind) {
    var out = [];
    if (!st || st.words < 15) return ['That was short. Even rough, keep going until the timer ends: the practice is in the minutes, not the polish.'];
    var top = Object.keys(st.fillers).sort(function (a, b) { return st.fillers[b] - st.fillers[a]; })[0];
    if (st.delay != null && st.delay > 5) out.push('You waited ' + st.delay + ' seconds before the first word. In the thinking time, decide only your first sentence, then start with it.');
    if (st.fillerPerMin != null && st.fillerPerMin >= 5 && top) out.push('"' + top + '" came ' + st.fillers[top] + ' time' + (st.fillers[top] > 1 ? 's' : '') + '. When you feel it coming, stay silent for a beat instead. A pause sounds confident.');
    if (st.restarts >= 3) out.push('You started a phrase over ' + st.restarts + ' times. Finish the sentence even if it comes out plain; you can fix it in the next one.');
    if (st.wpm != null && st.wpm > 175) out.push('You spoke fast (' + st.wpm + ' words a minute). Aim for about 140 and let a sentence end before the next begins.');
    if (st.wpm != null && st.wpm < 95) out.push('Slow and careful (' + st.wpm + ' words a minute). That is fine if it was thinking; if it was hunting for words, say the plain word first.');
    if (kind === 'topic' && st.missed && st.touched && st.missed.length && st.touched.length + st.missed.length >= 3 && st.missed.length > st.touched.length) {
      out.push('You never touched: ' + st.missed.slice(0, 3).join(', ') + '. Check you answered the question you were asked.');
    }
    if (!out.length) out.push('A clean take. Next time add one concrete example: a name, a place, a number.');
    return out.slice(0, 2);
  }

  /* ---------- days, takes, streaks ---------- */
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(key, n) {
    var p = key.split('-');
    return dayKey(new Date(+p[0], +p[1] - 1, +p[2] + n, 12).getTime());
  }
  function cleanTake(r) {
    if (!r || typeof r !== 'object' || !r.id) return null;
    var t = { id: String(r.id), mod: +r.mod || +r.at || 0, at: +r.at || 0, day: /^\d{4}-\d\d-\d\d$/.test(r.day) ? r.day : '' };
    if (r.del) { t.del = 1; return t; }
    t.mode = r.mode === 'free' ? 'free' : 'topic';
    t.topic = String(r.topic || '');
    t.cat = String(r.cat || '');
    t.target = +r.target || 0;
    t.think = +r.think || 0;
    t.sec = +r.sec || 0;
    t.delay = r.delay == null ? null : +r.delay;
    t.text = String(r.text || '');
    t.st = r.st && typeof r.st === 'object' ? r.st : analyze(t.text, { sec: t.sec, delay: t.delay, topic: t.topic });
    return t;
  }
  /* two lists of takes -> one; by id, the later change wins, a deletion stays deleted */
  function mergeTakes(a, b) {
    var by = {};
    (a || []).concat(b || []).forEach(function (r) {
      var t = cleanTake(r);
      if (!t) return;
      var o = by[t.id];
      if (!o || t.mod > o.mod || (t.mod === o.mod && t.del && !o.del)) by[t.id] = t;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (x, y) { return x.at - y.at || (x.id < y.id ? -1 : 1); });
  }
  var live = function (list) { return (list || []).filter(function (t) { return !t.del; }); };
  var fileText = function (takes) { return JSON.stringify({ v: 1, takes: takes }, null, 1) + '\n'; };

  /* consecutive days with a take, ending today -- or yesterday, so a day not yet spoken
     does not erase the streak until the day is over */
  function streakOf(days, today) {
    var set = {};
    days.forEach(function (d) { set[d] = 1; });
    var cur = set[today] ? today : addDays(today, -1);
    var n = 0;
    while (set[cur]) { n++; cur = addDays(cur, -1); }
    return { days: n, today: !!set[today] };
  }
  /* a topic not shown lately, at random */
  function pickTopic(topics, seen, rnd) {
    var recent = (seen || []).slice(-Math.min(40, Math.floor(topics.length / 2)));
    var pool = topics.filter(function (t) { return recent.indexOf(t[1]) < 0; });
    if (!pool.length) pool = topics;
    return pool[Math.min(pool.length - 1, Math.floor((rnd == null ? Math.random() : rnd) * pool.length))];
  }
  function average(takes, key) {
    var vals = takes.map(function (t) { return t.st && t.st[key]; }).filter(function (v) { return v != null && isFinite(v); });
    if (!vals.length) return null;
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length * 10) / 10;
  }

  /* a hook for the tests, nothing else */
  if (typeof window.__speakTest === 'function') {
    window.__speakTest({
      tokenize: tokenize, analyze: analyze, tips: tips, mergeTakes: mergeTakes, cleanTake: cleanTake, streakOf: streakOf,
      pickTopic: pickTopic, dayKey: dayKey, addDays: addDays, fileText: fileText, average: average
    });
  }

  /* ================= the page ================= */

  var app = $('speakapp');
  var homeCard = document.querySelector('[data-speak-card]');
  if (!app && !homeCard) return;

  var SPEECH = metaOf('speech-repo');
  var LS_Q = 'speak_q_v1';        // takes saved here but not yet in the repo
  var LS_CACHE = 'speak_cache_v1'; // { days: {day: takes[]}, names: [day...], coach: {name, text} }
  var LS_SEEN = 'speak_seen_v1';   // topics shown lately
  var LS_PREF = 'speak_pref_v1';   // { target, mode, think }

  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function save(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  var token = '';
  try { token = localStorage.getItem('gh_token') || ''; } catch (e) {}

  var cache = load(LS_CACHE, null) || {};
  cache.days = cache.days || {};
  cache.names = cache.names || [];
  var queue = load(LS_Q, []).map(cleanTake).filter(Boolean);
  var persistCache = function () { save(LS_CACHE, cache); };
  var persistQueue = function () { save(LS_Q, queue); };

  /* ---------- the private repo ---------- */
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
  var base = function () { return 'https://api.github.com/repos/' + SPEECH; };
  function api(method, url, body, etag) {
    var headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (etag) headers['If-None-Match'] = etag;
    return fetch(url, { method: method, cache: 'no-store', headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 304) return { notModified: true };
        return r.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) {
            var err = new Error((data && data.message) || ('HTTP ' + r.status));
            err.status = r.status;
            throw err;
          }
          if (data && typeof data === 'object' && !Array.isArray(data)) data.__etag = r.headers.get('etag');
          return data;
        });
      }, function () {
        var err = new Error('No connection');
        err.offline = true;
        throw err;
      });
  }

  /* where this browser stands with the repo:
     local (no token) | ok | noaccess (the token cannot see the private repo) | badtoken | offline */
  var state = token ? 'checking' : 'local';
  /* what a failed call says about where this browser stands: only a 404 (what GitHub
     answers for a private repo the token cannot see), or a 403 that is not a rate limit,
     means "no access"; a server error or a busy API is just "error", never a reason to go
     and change the token */
  var lastError = '';
  function stateFor(err) {
    lastError = err && err.message || '';
    if (err.offline) return 'offline';
    if (err.status === 401) return 'badtoken';
    if (err.status === 404) return 'noaccess';
    if (err.status === 403 && !/rate limit|abuse|secondary/i.test(err.message)) return 'noaccess';
    return 'error';
  }
  var accessChecked = false;
  function checkAccess() {
    if (!token || !SPEECH) { state = token ? 'noaccess' : 'local'; return Promise.resolve(false); }
    if (accessChecked) return Promise.resolve(state === 'ok');
    return api('GET', base()).then(function () {
      accessChecked = true; state = 'ok'; return true;
    }, function (err) {
      state = stateFor(err);
      return false;
    });
  }
  function dayPath(day) { return 'takes/' + day + '.json'; }
  function getDayFile(day) {
    return api('GET', base() + '/contents/' + dayPath(day)).then(function (f) {
      var raw = b64decode(f.content || '');
      var d = null;
      if (raw.trim()) {
        try { d = JSON.parse(raw); } catch (e) {
          var bad = new Error(dayPath(day) + ' is not valid JSON');
          bad.broken = true;
          throw bad;
        }
      }
      return { sha: f.sha, takes: mergeTakes((d && d.takes) || [], []) };
    }, function (err) {
      if (err.status === 404) return { sha: null, takes: [] };
      throw err;
    });
  }
  /* write a day: read it, merge the changes in, write it back (a 409/422 means another
     device wrote in between: read and merge again) */
  function writeDay(day, change, msg, tries) {
    return getDayFile(day).then(function (cur) {
      var merged = change(cur.takes);
      /* a day with nothing left is removed, so it no longer counts toward the streak */
      if (!live(merged).length) {
        if (!cur.sha) return merged;
        return api('DELETE', base() + '/contents/' + dayPath(day), { message: msg, sha: cur.sha }).then(function () { return merged; });
      }
      var body = { message: msg, content: b64encode(fileText(merged)) };
      if (cur.sha) body.sha = cur.sha;
      return api('PUT', base() + '/contents/' + dayPath(day), body).then(function () { return merged; }, function (err) {
        if ((err.status === 409 || err.status === 422) && tries > 0) return writeDay(day, change, msg, tries - 1);
        throw err;
      });
    });
  }

  var flushing = null;
  var again = 0;
  function flush() {
    if (flushing) return flushing;
    if (!queue.length) return Promise.resolve();
    flushing = checkAccess().then(function (ok) {
      if (!ok) return;
      var days = {};
      queue.forEach(function (t) { (days[t.day] = days[t.day] || []).push(t); });
      var chain = Promise.resolve();
      Object.keys(days).forEach(function (day) {
        chain = chain.then(function () {
          var sent = days[day];
          var n = live(sent).length;
          return writeDay(day, function (cur) { return mergeTakes(cur, sent); },
            'speak: ' + (n ? n + ' take' + (n > 1 ? 's' : '') : 'tidied'), 3).then(function (merged) {
            var ids = {};
            sent.forEach(function (t) { ids[t.id] = 1; });
            queue = queue.filter(function (t) { return !ids[t.id]; });
            persistQueue();
            cache.days[day] = live(merged);
            if (cache.names.indexOf(day) < 0 && live(merged).length) cache.names.push(day);
            if (!live(merged).length) cache.names = cache.names.filter(function (d) { return d !== day; });
            cache.names.sort();
            persistCache();
          });
        });
      });
      return chain;
    }).then(function () {
      flushing = null;
      /* a take saved while this was sending is sent straight after, not a minute later */
      if (queue.length && state === 'ok' && again++ < 3) return flush();
      again = 0;
    }, function (err) {
      flushing = null;
      state = stateFor(err);
    });
    return flushing;
  }

  /* what the repo holds: the list of days, the last two weeks of takes, the newest coaching */
  var RECENT = 14;
  function refresh() {
    return checkAccess().then(function (ok) {
      if (!ok) return;
      return api('GET', base() + '/contents/takes').then(function (list) { return list; }, function (err) {
        if (err.status === 404) return [];
        throw err;
      }).then(function (list) {
        var names = list.map(function (f) { var m = /^(\d{4}-\d\d-\d\d)\.json$/.exec(f.name || ''); return m ? m[1] : null; }).filter(Boolean).sort();
        var recent = names.slice(-RECENT);
        return Promise.all(recent.map(function (d) {
          return getDayFile(d).then(function (f) { return [d, f.takes]; });
        })).then(function (pairs) {
          cache.names = names;
          pairs.forEach(function (p) { cache.days[p[0]] = live(p[1]); });
          Object.keys(cache.days).forEach(function (d) { if (names.indexOf(d) < 0) delete cache.days[d]; });
          persistCache();
        });
      }).then(function () {
        return api('GET', base() + '/contents/coaching').then(function (list) {
          var md = list.map(function (f) { return f.name; }).filter(function (n) { return /^\d{4}-\d\d-\d\d\.md$/.test(n); }).sort();
          if (!md.length) { delete cache.coach; return; }
          var newest = md[md.length - 1];
          if (cache.coach && cache.coach.name === newest) return;
          return api('GET', base() + '/contents/coaching/' + newest).then(function (f) {
            cache.coach = { name: newest, text: b64decode(f.content || '') };
          });
        }, function (err) { if (err.status === 404) { delete cache.coach; return; } throw err; });
      }).then(function () { persistCache(); state = 'ok'; });
    }).catch(function (err) {
      state = stateFor(err);
    });
  }

  /* every take on this device's view of the repo, newest first (queue included) */
  function allRecent() {
    var by = {};
    Object.keys(cache.days).forEach(function (d) { cache.days[d].forEach(function (t) { by[t.id] = t; }); });
    queue.forEach(function (t) { if (!t.del) by[t.id] = t; else delete by[t.id]; });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.at - a.at; });
  }
  function allDays() {
    var set = {};
    cache.names.forEach(function (d) { set[d] = 1; });
    queue.forEach(function (t) { if (!t.del) set[t.day] = 1; });
    return Object.keys(set).sort();
  }

  /* ---------- the home card ---------- */
  function paintHome() {
    if (!homeCard) return;
    var s = streakOf(allDays(), dayKey(Date.now()));
    var el = homeCard.querySelector('[data-speak-streak]');
    var go = homeCard.querySelector('[data-speak-go]');
    if (el) {
      el.textContent = s.today ? 'Spoke today' + (s.days > 1 ? ' · ' + s.days + ' days in a row' : '')
        : (s.days ? s.days + ' days in a row. Keep it going: one minute.' : 'One minute is enough to start.');
    }
    if (go) go.textContent = s.today ? 'Another take' : 'Speak a minute';
  }

  /* the sound that says "go": a short soft tone, never required */
  function beep() {
    try {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      var c = new A(), o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 660; g.gain.value = 0.06;
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.18);
      setTimeout(function () { try { c.close(); } catch (e) {} }, 400);
    } catch (e) {}
  }

  /* a take that is still waiting is tried again every minute, and the moment the network is back */
  function retry(paint) {
    if (!queue.length || !token || !SPEECH || document.visibilityState === 'hidden') return;
    flush().then(refresh).then(paint);
  }
  if (!app) {
    paintHome();
    if (token && SPEECH) { flush().then(refresh).then(paintHome); }
    setInterval(function () { retry(paintHome); }, 60000);
    window.addEventListener('online', function () { retry(paintHome); });
    return;
  }

  /* ================= the practice ================= */
  var TOPICS = [];
  try { TOPICS = JSON.parse($('stopics').textContent); } catch (e) {}
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var LANG = app.dataset.lang || 'en-IN';
  var pref = load(LS_PREF, null) || {};
  pref.target = +pref.target || 60;
  pref.think = pref.think == null ? 30 : +pref.think;
  pref.mode = pref.mode === 'free' ? 'free' : 'topic';

  var stage = $('sstage');
  var S = { phase: 'idle', topic: null, t0: 0, think0: 0, talk0: 0, firstAt: 0, text: '', committed: '', rec: null, wantMic: false, timer: 0, savedId: '' };

  function setTopic(t) {
    S.topic = t;
    var seen = load(LS_SEEN, []);
    seen.push(t[1]);
    save(LS_SEEN, seen.slice(-60));
  }
  function newTopic() { setTopic(pickTopic(TOPICS, load(LS_SEEN, []))); }

  var fmt = function (s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + pad(s % 60); };

  function draw() {
    clearInterval(S.timer);
    S.timer = 0;
    var h = '';
    if (S.phase === 'idle') {
      if (pref.mode === 'topic' && !S.topic && TOPICS.length) newTopic();
      h += '<div class="smodes" role="tablist" aria-label="Kind of talk">'
        + '<button type="button" role="tab" data-mode="topic" aria-selected="' + (pref.mode === 'topic') + '">Random topic</button>'
        + '<button type="button" role="tab" data-mode="free" aria-selected="' + (pref.mode === 'free') + '">Free talk</button></div>';
      if (pref.mode === 'topic') {
        h += '<p class="stopiccat">' + esc(S.topic ? S.topic[0] : '') + '</p>'
          + '<p class="stopic" id="stopic">' + esc(S.topic ? S.topic[1] : '') + '</p>'
          + '<div class="srow"><button type="button" class="btn ghost small" data-a="shuffle">Another topic</button>'
          + '<label class="slen">Talk for <select id="slen">' + [1, 2, 3].map(function (m) {
            return '<option value="' + m * 60 + '"' + (pref.target === m * 60 ? ' selected' : '') + '>' + m + ' min</option>';
          }).join('') + '</select></label>'
          + '<label class="slen">Think for <select id="sthink">' + [[0, 'no time'], [30, '30 s'], [60, '1 min']].map(function (o) {
            return '<option value="' + o[0] + '"' + (pref.think === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select></label></div>'
          + '<button type="button" class="btn primary big sgo" data-a="begin">' + (pref.think ? 'Start thinking' : 'Start talking') + '</button>';
      } else {
        h += '<p class="stopic">Say anything: an idea, a worry, the day, a plan. No timer. Press stop when you are done.</p>'
          + '<button type="button" class="btn primary big sgo" data-a="free">Start talking</button>';
      }
      if (!SR) h += '<p class="muted small">This browser cannot listen. You can type your talk instead; the tips are the same.</p>';
    } else if (S.phase === 'think') {
      h += '<p class="stopiccat">Think. Decide your first sentence only.</p>'
        + '<p class="stopic">' + esc(S.topic[1]) + '</p>'
        + '<p class="sclock" id="sclock">' + fmt(pref.think) + '</p>'
        + '<button type="button" class="btn primary big sgo" data-a="talk">I am ready</button>'
        + '<p class="muted small">Talking starts by itself when the time is up.</p>';
    } else if (S.phase === 'talk') {
      var free = S.free;
      h += (free ? '' : '<p class="stopic small">' + esc(S.topic[1]) + '</p>')
        + '<p class="sclock live" id="sclock">' + (free ? '0:00' : fmt(pref.target)) + '</p>'
        + '<p class="muted small" id="smic">' + (SR ? 'Listening…' : 'Type your talk here.') + '</p>'
        + '<textarea id="stext" class="stext" rows="6" aria-label="What you said" placeholder="' + (SR ? 'Your words appear here as you speak' : 'Type your talk') + '"></textarea>'
        + '<div class="srow"><button type="button" class="btn primary big sgo" data-a="stop">' + (free ? 'Stop' : 'Done early') + '</button>'
        + '<button type="button" class="btn ghost small" data-a="mic" id="smicbtn" hidden>Start the microphone</button></div>';
    } else if (S.phase === 'review') {
      h += reviewHtml();
    } else if (S.phase === 'saved') {
      h += '<p class="stopic">Saved.</p>'
        + '<p class="muted" id="ssavednote"></p>'
        + '<div class="srow"><button type="button" class="btn primary big" data-a="again">Another take</button>'
        + '<a class="btn ghost" href="/">Back to Today</a></div>';
    }
    stage.innerHTML = h;
    var ta = $('stext');
    if (ta) {
      ta.value = S.text || '';
      ta.addEventListener('input', function () { S.text = ta.value; S.committed = ta.value; });
    }
    if (S.phase === 'review') {
      var rt = $('srtext');
      if (rt) rt.addEventListener('input', function () { S.text = rt.value; paintStats(); });
    }
    if (S.phase === 'think' || S.phase === 'talk') S.timer = setInterval(tick, 200);
    if (S.phase === 'saved') paintSavedNote();
  }

  function tick() {
    var now = Date.now();
    var clock = $('sclock');
    if (S.phase === 'think') {
      var left = pref.think - (now - S.think0) / 1000;
      if (clock) clock.textContent = fmt(Math.ceil(left));
      if (left <= 0) startTalk();
    } else if (S.phase === 'talk') {
      var el = (now - S.talk0) / 1000;
      if (S.free) { if (clock) clock.textContent = fmt(el); }
      else {
        var rem = pref.target - el;
        if (clock) {
          clock.textContent = fmt(Math.ceil(rem));
          clock.classList.toggle('low', rem <= 10);
        }
        if (rem <= 0) finishTalk();
      }
    }
  }

  /* ---------- the microphone ---------- */
  function micNote(text, bad) {
    var m = $('smic');
    if (m) { m.textContent = text; m.classList.toggle('bad', !!bad); }
    var b = $('smicbtn');
    if (b) b.hidden = !bad;
  }
  function startMic() {
    if (!SR) return;
    var ta = $('stext');
    try {
      var rec = new SR();
      S.rec = rec;
      rec.lang = LANG;
      rec.continuous = true;
      rec.interimResults = true;
      var before = S.committed ? S.committed.replace(/\s+$/, '') + ' ' : '';
      rec.onresult = function (e) {
        var text = '';
        for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        text = text.trim();
        if (text && !S.firstAt) S.firstAt = Date.now();
        S.text = (before + text).trim();
        if (ta) ta.value = S.text;
      };
      var began = Date.now();
      rec.onstart = function () { micNote('Listening…'); };
      rec.onerror = function (e) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { S.wantMic = false; micNote('The microphone is blocked. Allow it for this site, or type instead.', true); }
        else if (e.error === 'network') micNote('Dictation needs an internet connection. You can type instead.', true);
        else if (e.error !== 'no-speech' && e.error !== 'aborted') micNote('Microphone problem: ' + e.error, true);
      };
      rec.onend = function () {
        S.rec = null;
        S.committed = S.text;
        /* the browser ends a listen after a quiet moment: carry on while the talk is on */
        /* a listen that ended at once (a flaky microphone) is not restarted in a tight loop */
        var wait = Date.now() - began < 1500 ? 1000 : 150;
        if (S.wantMic && S.phase === 'talk') setTimeout(function () { if (S.wantMic && S.phase === 'talk' && !S.rec) startMic(); }, wait);
      };
      rec.start();
    } catch (err) {
      S.rec = null;
      micNote(err.message, true);
    }
  }
  function stopMic() {
    S.wantMic = false;
    if (S.rec) { try { S.rec.stop(); } catch (e) {} }
  }

  /* ---------- the phases ---------- */
  function beginThink() {
    S.phase = 'think';
    S.think0 = Date.now();
    S.text = ''; S.committed = ''; S.firstAt = 0; S.free = false;
    draw();
  }
  function startTalk() {
    S.phase = 'talk';
    S.talk0 = Date.now();
    S.firstAt = 0;
    S.text = ''; S.committed = '';
    draw();
    beep();
    if (SR) { S.wantMic = true; startMic(); }
  }
  function finishTalk() {
    if (S.phase !== 'talk') return;
    var ta = $('stext');
    if (ta) S.text = ta.value;
    S.sec = Math.round((Date.now() - S.talk0) / 1000);
    if (!S.free) S.sec = Math.min(S.sec, pref.target);
    S.delay = S.firstAt ? Math.max(0, (S.firstAt - S.talk0) / 1000) : null;
    stopMic();
    S.phase = 'review';
    draw();
    paintStats();
  }

  function statsNow() {
    return analyze(S.text, { sec: S.sec, delay: S.delay, topic: S.free ? '' : (S.topic ? S.topic[1] : '') });
  }
  function reviewHtml() {
    return '<p class="stopiccat">' + (S.free ? 'Free talk' : esc(S.topic[1])) + '</p>'
      + '<div id="sstats"></div>'
      + '<label class="srlabel" for="srtext">What you said. Fix any word the microphone got wrong; the numbers update.</label>'
      + '<textarea id="srtext" class="stext" rows="7">' + esc(S.text) + '</textarea>'
      + '<div class="srow"><button type="button" class="btn primary big" data-a="save">Save this take</button>'
      + '<button type="button" class="btn ghost" data-a="discard">Throw it away</button></div>'
      + '<p class="muted small">' + (SR ? 'Dictation drops "um" and "uh" before this page sees them, so the filler count covers the ones it keeps ("like", "you know", "I mean", "so"…) and is an estimate.' : '') + '</p>';
  }
  function chip(label, value, note, cls) {
    return '<div class="schip' + (cls ? ' ' + cls : '') + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span>' + (note ? '<i>' + esc(note) + '</i>' : '') + '</div>';
  }
  function fillerList(st) {
    var keys = Object.keys(st.fillers).sort(function (a, b) { return st.fillers[b] - st.fillers[a]; });
    return keys.map(function (k) { return k + ' ×' + st.fillers[k]; }).join(', ');
  }
  function paintStats() {
    var box = $('sstats');
    if (!box) return;
    var st = statsNow();
    var prev = allRecent().filter(function (t) { return t.id !== S.savedId; }).slice(0, 7);
    var pAvg = average(prev, 'fillerPerMin');
    var pace = st.wpm == null ? '–' : st.wpm;
    var paceNote = st.wpm == null ? '' : (st.wpm > 175 ? 'fast' : st.wpm < 95 ? 'slow' : 'steady');
    var h = '<div class="schips">'
      + chip('words', st.words, st.sec ? 'in ' + fmt(st.sec) : '')
      + chip('words a minute', pace, paceNote)
      + chip('fillers a minute', st.fillerPerMin == null ? '–' : st.fillerPerMin, st.fillerTotal ? fillerList(st) : (st.words ? 'none caught' : ''))
      + chip('restarts', st.restarts, st.restarts ? 'a phrase said twice' : '')
      + chip('first word after', st.delay == null ? '–' : st.delay + ' s', st.delay == null ? 'typed' : '')
      + '</div>';
    if (!S.free && (st.touched.length || st.missed.length)) {
      h += '<p class="small"><b>Topic words you used:</b> ' + (st.touched.length ? esc(st.touched.join(', ')) : 'none')
        + (st.missed.length ? ' · <b>not used:</b> ' + esc(st.missed.join(', ')) : '') + '</p>';
    }
    if (st.repeated.length) h += '<p class="small"><b>Said often:</b> ' + st.repeated.map(function (r) { return esc(r[0]) + ' ×' + r[1]; }).join(', ') + '</p>';
    if (pAvg != null && st.fillerPerMin != null) h += '<p class="small muted">Your last ' + prev.length + ' take' + (prev.length > 1 ? 's' : '') + ' averaged ' + pAvg + ' fillers a minute.</p>';
    h += '<ul class="stips">' + tips(st, S.free ? 'free' : 'topic').map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    box.innerHTML = h;
  }

  /* ---------- saving ---------- */
  function saveTake() {
    var text = (S.text || '').trim();
    if (!text) { toast('There are no words to save.', 'err'); return; }
    var st = statsNow();
    var now = Date.now();
    var take = {
      id: uid(), at: now, mod: now, day: dayKey(now),
      mode: S.free ? 'free' : 'topic',
      topic: S.free ? '' : S.topic[1], cat: S.free ? '' : S.topic[0],
      target: S.free ? 0 : pref.target, think: S.free ? 0 : pref.think,
      sec: S.sec, delay: S.delay == null ? null : Math.round(S.delay * 10) / 10,
      text: text, st: st
    };
    queue.push(take);
    persistQueue();
    S.savedId = take.id;
    S.phase = 'saved';
    draw();
    flush().then(refresh).then(function () { paintSavedNote(); paintAll(); });
  }
  function paintSavedNote() {
    var el = $('ssavednote');
    if (!el) return;
    var pending = queue.some(function (t) { return t.id === S.savedId; });
    if (!pending) el.textContent = 'It is in your private speech log.';
    else if (state === 'local') el.textContent = 'Saved on this device. Sign in on the Write page and it goes to your private log.';
    else if (state === 'noaccess') el.textContent = 'Saved on this device. It will go to the private log once the repo is connected (see below).';
    else if (state === 'badtoken') el.textContent = 'Saved on this device. Your sign-in has expired: sign in again on the Write page.';
    else if (state === 'offline') el.textContent = 'Saved on this device. It goes up when you are back online.';
    else if (state === 'error') el.textContent = 'Saved on this device. The private log did not answer; it will be sent again shortly.';
    else el.textContent = 'Saved on this device, sending…';
  }
  function toast(text, kind, ms) { if (window.journalToast) window.journalToast(text, kind, ms); }

  /* ---------- history, coaching, connection ---------- */
  var timeOf = function (ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var niceDay = function (k) { return +k.slice(8) + ' ' + MON[+k.slice(5, 7) - 1]; };

  function paintHistory() {
    var box = $('shist');
    if (!box) return;
    var today = dayKey(Date.now());
    var s = streakOf(allDays(), today);
    var all = allRecent();
    var week = all.filter(function (t) { return t.day >= addDays(today, -6); });
    var head = '<div class="cardhead"><h3>Your practice</h3><span class="count">' + s.days + ' day' + (s.days === 1 ? '' : 's') + ' in a row</span></div>';
    var sum = '';
    if (week.length) {
      var mins = Math.round(week.reduce(function (a, t) { return a + (t.sec || 0); }, 0) / 60 * 10) / 10;
      sum = '<p class="small">This week: <b>' + week.length + '</b> take' + (week.length > 1 ? 's' : '') + ', <b>' + mins + '</b> min spoken'
        + (average(week, 'fillerPerMin') != null ? ', <b>' + average(week, 'fillerPerMin') + '</b> fillers a minute on average' : '')
        + (average(week, 'wpm') != null ? ', <b>' + average(week, 'wpm') + '</b> words a minute' : '') + '.</p>';
    }
    var rows = all.slice(0, 12).map(function (t) {
      var st = t.st || {};
      return '<details class="stake" data-id="' + esc(t.id) + '"><summary><span class="sd">' + esc(niceDay(t.day)) + ' · ' + timeOf(t.at) + '</span>'
        + '<span class="stt">' + esc(t.mode === 'free' ? 'Free talk' : t.topic) + '</span>'
        + '<span class="sm">' + (st.fillerPerMin != null ? st.fillerPerMin + ' fill/min · ' : '') + (st.wpm != null ? st.wpm + ' wpm' : (st.words || 0) + ' words') + '</span></summary>'
        + '<p class="stx">' + esc(t.text) + '</p>'
        + '<p class="small muted">' + esc(fillerList(st) || 'no fillers caught') + (st.restarts ? ' · ' + st.restarts + ' restarts' : '') + '</p>'
        + '<button type="button" class="btn ghost small danger" data-del="' + esc(t.id) + '">Delete this take</button></details>';
    }).join('');
    box.innerHTML = head + sum + (rows || '<p class="muted small">Nothing yet. Your first take goes here.</p>')
      + '<div class="srow"><button type="button" class="btn ghost small" data-a="export">Download everything</button></div>';
  }
  function paintCoach() {
    var box = $('scoach');
    if (!box) return;
    if (!cache.coach || !cache.coach.text.trim()) { box.hidden = true; return; }
    box.hidden = false;
    var day = cache.coach.name.replace('.md', '');
    box.innerHTML = '<div class="cardhead"><h3>Coaching</h3><span class="count">' + esc(niceDay(day)) + '</span></div>'
      + '<div class="scoachtext">' + esc(cache.coach.text.trim()).replace(/\n/g, '<br>') + '</div>';
  }
  function paintConn() {
    var box = $('sstatus');
    if (!box) return;
    var msg = '';
    var q = queue.length;
    if (state === 'local') msg = 'This browser is not signed in, so takes stay on this device. Sign in on the <a href="/admin/">Write page</a> and they move to your private log.';
    else if (state === 'noaccess') msg = 'Your sign-in cannot see the private repo <b>' + esc(SPEECH) + '</b> yet. In GitHub: Settings → Developer settings → Fine-grained tokens → your journal token → Repository access → add <b>speech-log</b>, with Contents set to Read and write. Takes wait on this device until then.';
    else if (state === 'badtoken') msg = 'Your sign-in has expired. Sign in again on the <a href="/admin/">Write page</a>.';
    else if (state === 'offline') msg = 'You are offline. Takes wait on this device and go up later.';
    else if (state === 'error') msg = 'Could not reach the private log (' + esc(lastError) + '). Takes wait on this device and are tried again next time.';
    if (q && msg) msg += ' <b>' + q + ' waiting.</b>';
    else if (q) msg = q + ' take' + (q > 1 ? 's' : '') + ' on its way to the private log…';
    box.hidden = !msg;
    box.innerHTML = msg;
  }
  function paintAll() { paintHistory(); paintCoach(); paintConn(); }

  function deleteTake(id) {
    var t = allRecent().filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (!window.confirm('Delete this take for good?')) return;
    var tomb = { id: id, day: t.day, at: t.at, mod: Date.now(), del: 1 };
    queue = queue.filter(function (x) { return x.id !== id; });
    queue.push(tomb);
    persistQueue();
    if (cache.days[t.day]) cache.days[t.day] = cache.days[t.day].filter(function (x) { return x.id !== id; });
    paintAll();
    flush().then(refresh).then(paintAll);
  }

  function exportAll() {
    checkAccess().then(function (ok) {
      if (!ok) { toast('Connect the private repo first.', 'err'); return; }
      return Promise.all(cache.names.map(function (d) { return getDayFile(d).then(function (f) { return live(f.takes); }); })).then(function (lists) {
        var takes = [].concat.apply([], lists);
        var blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), takes: takes }, null, 1)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'speech-log-' + dayKey(Date.now()) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        toast(takes.length + ' takes downloaded.');
      });
    }).catch(function (e) { toast('Download failed: ' + e.message, 'err'); });
  }

  /* ---------- wiring ---------- */
  app.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) { deleteTake(del.getAttribute('data-del')); return; }
    var mode = e.target.closest('[data-mode]');
    if (mode && S.phase === 'idle') { pref.mode = mode.getAttribute('data-mode'); save(LS_PREF, pref); draw(); return; }
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'shuffle') { newTopic(); draw(); }
    else if (a === 'begin') { if (pref.think > 0) beginThink(); else { S.free = false; startTalk(); } }
    else if (a === 'free') { S.free = true; startTalk(); }
    else if (a === 'talk') { startTalk(); }
    else if (a === 'stop') { finishTalk(); }
    else if (a === 'mic') { S.wantMic = true; micNote('Listening…'); startMic(); }
    else if (a === 'save') { saveTake(); }
    else if (a === 'discard') { if (window.confirm('Throw this take away?')) { S.phase = 'idle'; S.text = ''; draw(); } }
    else if (a === 'again') { S.phase = 'idle'; S.text = ''; S.topic = null; draw(); }
    else if (a === 'export') { exportAll(); }
  });
  app.addEventListener('change', function (e) {
    if (e.target.id === 'slen') { pref.target = +e.target.value || 60; save(LS_PREF, pref); }
    if (e.target.id === 'sthink') { pref.think = +e.target.value; save(LS_PREF, pref); draw(); }
  });
  window.addEventListener('beforeunload', function (e) {
    if (S.phase === 'review' || (S.phase === 'talk' && (S.text || '').length > 20)) { e.preventDefault(); e.returnValue = ''; }
  });

  setInterval(function () { retry(paintAll); }, 60000);
  window.addEventListener('online', function () { retry(paintAll); });
  draw();
  paintAll();
  if (token && SPEECH) {
    flush().then(refresh).then(function () { paintAll(); });
  } else {
    state = token ? 'noaccess' : 'local';
    paintConn();
  }
})();
