/* The Speak page: practise talking, and keep proof.

   Pick a random topic (or just talk), think a little, talk for a minute. The page RECORDS
   the microphone -- audio, not live dictation -- and hands each take to a small helper that
   runs on this PC (tools/speakd/speakd.py, http://127.0.0.1:4777). The helper keeps the audio
   and turns it into words with Whisper, with a time for every word, so "um", "uh" and pauses
   are kept. Nothing is sent to any server on the internet: the recording, the words and the
   coaching notes all live in a private folder on the PC.

   Why recording and not dictation: browser dictation stops by itself, drops "um" and "uh",
   and gives no pauses. A recording does not cut out; the page shows a live level bar so you
   can SEE the microphone is alive, and says so when it goes quiet or is unplugged.

   A take is never lost: the audio goes into this browser's own storage (IndexedDB) first,
   then to the helper; if the helper is not running it waits there and is sent when it is.

   What is shown about a take is FACTS (words a minute, fillers, pauses, when the first word
   came, the transcript with the fillers and pauses marked). The advice is not computed here:
   it is written by Claude after reading the transcripts, into coaching/YYYY-MM-DD.md in the
   same folder, and shown on this page under "Coaching". */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  /* ================= what the words show (pure) ================= */

  var HARD = { um: 1, umm: 1, ummm: 1, uhm: 1, uh: 1, uhh: 1, er: 1, erm: 1, ah: 1, ahh: 1, hmm: 1, hm: 1, mmm: 1, mm: 1 };
  var PHRASES2 = ['you know', 'i mean', 'kind of', 'sort of', 'you see', 'or something', 'and stuff', 'and all'];
  var WORDS1 = { basically: 1, literally: 1, actually: 1, honestly: 1, obviously: 1, matlab: 1 };
  /* "like" is a real word more often than a filler: these neighbours make it a real one */
  var LIKE_PREV = " i you we they he she would do dont don't didn't did look looks looked feel feels felt sound sounds sounded seem seems something nothing anything just much smell smells taste tastes people who that ";
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
    var t = String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[-\u2013\u2014]/g, ' ');
    t = t.replace(/[^a-z0-9'\s]/g, ' ');
    return t.split(/\s+/).filter(Boolean);
  }
  var has = function (set, w) { return set.indexOf(' ' + w + ' ') >= 0; };
  function stem(w) { return w.replace(/(ing|ed|es|s|ly)$/, ''); }
  function sameStem(a, b) {
    var x = stem(a), y = stem(b);
    if (x === y) return true;
    return x.length >= 4 && y.length >= 4 && (x.indexOf(y) === 0 || y.indexOf(x) === 0);
  }

  /* what a list of words shows. tk: lowercase tokens, one per spoken word (so positions line
     up with timed words). opts: sec (seconds spoken), delay (seconds before the first word, or
     null), topic (the prompt, or ''). `flags` are the positions of the words counted as filler. */
  function analyzeTokens(tk, opts) {
    opts = opts || {};
    var n = tk.length;
    var fill = {};
    var total = 0;
    var soTotal = 0;
    var flags = [];
    var idx = 0;
    var add = function (k, span) {
      fill[k] = (fill[k] || 0) + 1; total++;
      flags.push(idx);
      if (span === 2) flags.push(idx + 1);
    };

    for (var i = 0; i < n; i++) {
      idx = i;
      var w = tk[i], nx = tk[i + 1] || '', pv = tk[i - 1] || '';
      if (HARD[w]) { add(w); continue; }
      var two = w + ' ' + nx;
      if (nx && PHRASES2.indexOf(two) >= 0) {
        /* "what kind of", "do you know", "what I mean" are ordinary speech, not padding */
        var ok = !(((two === 'kind of' || two === 'sort of') && has(KIND_PREV, pv))
          || (two === 'you know' && has(KNOW_PREV, pv)) || (two === 'i mean' && has(MEAN_PREV, pv)));
        if (ok) add(two, 2);
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
    return {
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
      missed: missed,
      flags: flags
    };
  }
  function analyze(text, opts) { return analyzeTokens(tokenize(text), opts); }
  /* timed words ([{w, s, e}] from Whisper) -> the same, positions matching the words */
  function wordTokens(words) {
    return (words || []).map(function (x) { return tokenize(x.w).join(' ') || '_'; });
  }
  function analyzeWords(words, opts) { return analyzeTokens(wordTokens(words), opts); }

  /* the silences between words: a gap from one word's end to the next one's start of at least
     `min` seconds. `first` is when the first word began, counted from the start of the recording. */
  function pausesOf(words, min) {
    min = min || 0.7;
    var ws = words || [];
    var gaps = [], total = 0, longest = 0;
    for (var i = 1; i < ws.length; i++) {
      var g = ws[i].s - ws[i - 1].e;
      if (g >= min) { gaps.push({ i: i, len: Math.round(g * 10) / 10 }); total += g; if (g > longest) longest = g; }
    }
    return {
      count: gaps.length,
      long: gaps.filter(function (g) { return g.len >= 1.5; }).length,
      total: Math.round(total * 10) / 10,
      longest: Math.round(longest * 10) / 10,
      first: ws.length ? Math.round(ws[0].s * 10) / 10 : null,
      gaps: gaps
    };
  }

  /* How sentences begin. Whisper puts the full stops in, so a sentence starts at the first word
     and after any word ending . ? or !. A sentence begun with "So" or "And" is a thought joined
     on to the last one instead of finished: the commonest habit found in the first real takes. */
  function openersOf(words) {
    var ws = words || [];
    var sentences = 0, so = 0, and = 0;
    for (var i = 0; i < ws.length; i++) {
      if (i && !/[.?!][”"')\]]*$/.test(ws[i - 1].w)) continue;
      sentences++;
      var t = tokenize(ws[i].w)[0];
      if (t === 'so') so++;
      else if (t === 'and') and++;
    }
    return { sentences: sentences, count: so + and, so: so, and: and };
  }

  /* all the facts about a finished take, or null while it has no timed words */
  function factsOf(t) {
    if (!t || !t.words || !t.words.length) return null;
    var pa = pausesOf(t.words);
    var st = analyzeWords(t.words, { sec: t.sec, delay: pa.first, topic: t.mode === 'free' ? '' : t.topic });
    st.pauses = pa;
    st.openers = openersOf(t.words);
    return st;
  }

  /* the transcript as segments: each word, whether it was filler, the pause before it */
  function segmentsOf(words, st) {
    var flagged = {};
    ((st && st.flags) || []).forEach(function (i) { flagged[i] = 1; });
    var gapAt = {};
    ((st && st.pauses && st.pauses.gaps) || []).forEach(function (g) { gapAt[g.i] = g.len; });
    return (words || []).map(function (x, i) {
      return { w: x.w, filler: !!flagged[i], gap: gapAt[i] || 0 };
    });
  }

  /* ---------- days, streaks, topics ---------- */
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(key, n) {
    var p = key.split('-');
    return dayKey(new Date(+p[0], +p[1] - 1, +p[2] + n, 12).getTime());
  }
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
  function average(list, pick) {
    var vals = list.map(pick).filter(function (v) { return v != null && isFinite(v); });
    if (!vals.length) return null;
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length * 10) / 10;
  }
  /* the coaching note is plain text with a little markdown: ## headings, - bullets, **bold** */
  function noteHtml(text) {
    var out = [], inList = false;
    var inline = function (s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); };
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var m;
      if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(m[1]) + '</li>');
        return;
      }
      if (inList) { out.push('</ul>'); inList = false; }
      if ((m = /^#{1,4}\s+(.*)$/.exec(line))) out.push('<h4>' + inline(m[1]) + '</h4>');
      else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    });
    if (inList) out.push('</ul>');
    return out.join('');
  }

  /* Notes on the RECORDING (not on how he spoke), from the numbers the PC measured: levels are 0..1. */
  function audioNotes(a) {
    var out = [];
    if (!a || !a.length) return out;
    var peak = 0, rms = 1, clipped = 0, floor = 0;
    a.forEach(function (x) { peak = Math.max(peak, x.peak || 0); rms = Math.min(rms, x.rms == null ? 1 : x.rms); clipped = Math.max(clipped, x.clipped_pct || 0); floor = Math.max(floor, x.floor || 0); });
    if (peak >= 0.98 && clipped >= 0.2) out.push('The recording is too loud and distorts at the loudest moments. Hold the tablet a little further away, or speak a little softer.');
    if (rms < 0.01) out.push('The recording is very quiet, so words may be missed. Speak closer to the microphone.');
    if (floor >= 0.02) out.push('There is a lot of background noise in the pauses. A quieter spot, or the microphone nearer your mouth, will help.');
    return out;
  }

  /* ---- words written on the device itself: the pure parts (the rest is further down) ---- */
  /* How the recording sounded, from its samples (levels 0..1), and how much of it is a voice: windows of 30 ms that
     are clearly louder than the quiet of the recording itself. */
  function pcmStats(pcm, rate) {
    rate = rate || 16000;
    var n = pcm.length, peak = 0, sum = 0, clipped = 0;
    for (var i = 0; i < n; i++) { var v = Math.abs(pcm[i]); if (v > peak) peak = v; sum += v * v; if (v >= 0.98) clipped++; }
    var win = Math.max(1, Math.round(rate * 0.03)), rms = [];
    for (var s = 0; s + win <= n; s += win) {
      var a = 0;
      for (var j = s; j < s + win; j++) a += pcm[j] * pcm[j];
      rms.push(Math.sqrt(a / win));
    }
    var sorted = rms.slice().sort(function (x, y) { return x - y; });
    var floor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
    var gate = Math.max(0.01, floor * 3);
    var voice = rms.filter(function (r) { return r > gate; }).length * win / rate;
    function r3(x) { return Math.round(x * 1000) / 1000; }
    return { sec: Math.round(n / rate * 10) / 10, peak: r3(peak), rms: Math.round(Math.sqrt(n ? sum / n : 0) * 10000) / 10000,
      clipped_pct: Math.round(n ? clipped / n * 10000 : 0) / 100, floor: Math.round(floor * 10000) / 10000, speech_s: Math.round(voice * 10) / 10 };
  }
  /* the model's word chunks -> [{w, s, e}] with this part's start added; never more than a few of the same word in a row
     (a model that loops says "hello" a hundred times) and none of the phrases it makes up over a stretch of noise */
  function wordsFromChunks(chunks, offset, voiceSeconds) {
    var out = [];
    (chunks || []).forEach(function (c) {
      var w = String(c.text || '').trim();
      if (!w) return;
      var ts = c.timestamp || [0, 0];
      var s = +ts[0] || 0, e = ts[1] == null ? s + 0.3 : +ts[1];
      out.push({ w: w, s: Math.round((offset + s) * 100) / 100, e: Math.round((offset + e) * 100) / 100 });
    });
    var key = function (w) { return w.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); };
    var cut = [], i = 0;
    while (i < out.length) {
      var j = i;
      while (j < out.length && key(out[j]) === key(out[i])) j++;
      var run = out.slice(i, j);
      Array.prototype.push.apply(cut, run.length <= 4 ? run : run.slice(0, 2));
      i = j;
    }
    var flat = ' ' + cut.map(function (w) { return key(w); }).join(' ') + ' ';
    if ((voiceSeconds || 0) < 3 && /thanks for watching|thank you for watching|thank you very much|subscribe/.test(flat) && cut.length <= 6) return [];
    return cut;
  }


  /* a hook for the tests, nothing else */
  if (typeof window.__speakTest === 'function') {
    window.__speakTest({
      tokenize: tokenize, analyze: analyze, analyzeWords: analyzeWords, pausesOf: pausesOf, factsOf: factsOf, openersOf: openersOf,
      segmentsOf: segmentsOf, streakOf: streakOf, pickTopic: pickTopic, dayKey: dayKey, addDays: addDays,
      average: average, noteHtml: noteHtml, audioNotes: audioNotes, pcmStats: pcmStats, wordsFromChunks: wordsFromChunks
    });
  }

  /* ================= the page ================= */

  var app = $('speakapp');
  var homeCard = document.querySelector('[data-speak-card]');
  if (!app && !homeCard) return;

  /* Served by the helper itself (http://localhost:4777/speak/), the page and the helper are one
     origin: nothing to allow, nothing to block. From the site's own address the helper is
     reached across origins, which Chrome may block or ask about. */
  var ON_HELPER = location.port === '4777' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var HELPER = ON_HELPER ? location.origin : 'http://127.0.0.1:4777';
  var LS_SEEN = 'speak_seen_v1';     // topics shown lately
  var LS_PREF = 'speak_pref_v1';     // { target, think, mode, device }
  var LS_DAYS = 'speak_days_v2';     // days with a take, for the streak when the helper is off

  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function save(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function toast(text, kind, ms) { if (window.journalToast) window.journalToast(text, kind, ms); }

  /* What the recorder did, event by event, for the take in progress; sent with the take (to diag/ on the PC)
     so a glitch on a tablet can be read there. Levels, settings and timings only: never the words. */
  var LOG = [], LOG0 = Date.now();
  function dlog(kind, data) {
    LOG.push([Date.now() - LOG0, kind, data == null ? null : data]);
    if (LOG.length > 500) LOG.shift();
  }
  function diagDoc(id) {
    return {
      v: 1, id: id, at: Date.now(), ua: navigator.userAgent,
      screen: { w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio || 1 },
      standalone: !!(window.matchMedia && window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches),
      online: navigator.onLine, events: LOG.slice()
    };
  }
  window.addEventListener('error', function (e) { dlog('error', String(e.message || e).slice(0, 200)); });
  window.addEventListener('unhandledrejection', function (e) { dlog('rejection', String((e.reason && e.reason.message) || e.reason).slice(0, 200)); });
  document.addEventListener('visibilitychange', function () { dlog('visibility', document.visibilityState); });

  /* ---------- the helper ---------- */
  var H = { up: false, info: null, takes: [], days: load(LS_DAYS, []), coach: null, asked: false };
  function fetchT(url, opts, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 4000) : 0;
    opts = opts || {};
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }
  function hjson(path, opts, ms) {
    return fetchT(HELPER + path, opts, ms).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var err = new Error((d && d.error) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
        return d;
      });
    });
  }
  function ping() {
    return hjson('/health', null, 2500).then(function (j) { H.up = true; H.info = j; H.asked = true; }, function () { H.up = false; H.asked = true; });
  }
  function refreshTakes() {
    if (!H.up) return Promise.resolve();
    var since = addDays(dayKey(Date.now()), -30);
    return Promise.all([
      hjson('/takes?since=' + since, null, 8000),
      hjson('/coaching', null, 4000).catch(function () { return null; })
    ]).then(function (r) {
      H.takes = (r[0].takes || []).slice().sort(function (a, b) { return b.at - a.at; });
      H.days = r[0].days || [];
      save(LS_DAYS, H.days.slice(-120));
      H.coach = r[1] && r[1].text && r[1].text.trim() ? r[1] : null;
    }, function () { H.up = false; });
  }

  /* ---------- recordings waiting in this browser (IndexedDB) ---------- */
  var MEMPEND = [];   // used only when IndexedDB is not available
  var PEND = [];      // [{id, day, meta, parts: [Blob], sent}]
  function idb() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('speak_v2', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('pending', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
        r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function idbDo(mode, fn) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var tx = db.transaction('pending', mode);
          var out = fn(tx.objectStore('pending'));
          tx.oncomplete = function () { res(out && out.result !== undefined ? out.result : true); db.close(); };
          tx.onerror = tx.onabort = function () { res(null); db.close(); };
        } catch (e) { res(null); }
      });
    });
  }
  var idbPut = function (rec) { return idbDo('readwrite', function (s) { return s.put(rec); }); };
  var idbDel = function (id) { return idbDo('readwrite', function (s) { return s.delete(id); }); };
  var idbAll = function () { return idbDo('readonly', function (s) { return s.getAll(); }); };

  function loadPending() {
    return idbAll().then(function (all) { PEND = (all || []).concat(MEMPEND.filter(function (m) { return !(all || []).some(function (a) { return a.id === m.id; }); })); });
  }
  var sending = {};
  /* send a waiting recording: its audio parts, then the take itself */
  function trySend(rec) {
    if (!H.up || sending[rec.id]) return Promise.resolve();
    sending[rec.id] = true;
    var chain = Promise.resolve();
    rec.parts.forEach(function (blob, n) {
      chain = chain.then(function () {
        return fetchT(HELPER + '/audio?id=' + rec.id + '&day=' + rec.day + '&n=' + n,
          { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'audio/webm' } }, 120000)
          .then(function (r) { if (!r.ok) throw new Error('audio ' + r.status); });
      });
    });
    return chain.then(function () {
      var m = rec.meta;
      if (rec.diag) hjson('/diag?id=' + rec.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec.diag) }, 15000).catch(function () {});
      return hjson('/take', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rec.id, day: rec.day, at: m.at, mode: m.mode, topic: m.topic, cat: m.cat, target: m.target, think: m.think, sec: m.sec, parts: rec.parts.length, text: '' })
      }, 15000);
    }).then(function () {
      PEND = PEND.filter(function (p) { return p.id !== rec.id; });
      MEMPEND = MEMPEND.filter(function (p) { return p.id !== rec.id; });
      return idbDel(rec.id);
    }).then(function () { delete sending[rec.id]; rec.lastError = ''; }, function (e) {
      delete sending[rec.id];
      /* kept, retried, and said on the page, so "it said Saved" is never the whole story */
      rec.lastError = (e && e.message) || String(e);
    });
  }
  function sendAllPending() {
    return PEND.slice().reduce(function (p, rec) { return p.then(function () { return MODE === 'repo' ? rSend(rec) : trySend(rec); }); }, Promise.resolve());
  }

  var metaOf = function (name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return m ? m.content : '';
  };

  /* ---------- the drop box: another way in, for a device that is not the PC ----------
     The PC has the helper; a tablet or phone does not. It uploads each recording to the `speech-drop`
     branch of the journal's own repo, with the sign-in the journal already uses. That repo is PUBLIC, so
     every file is locked first (src/dropcrypto.js: the key comes from the sign-in itself, nothing to set
     up). The PC's helper picks the recording up whenever it is on, writes the words out, and puts the
     finished take and the coaching notes back, locked the same way; this page reads and unlocks them.
     Layout (see Inbox in tools/speakd/speakd.py):
       inbox/<day>/<id>_<n>.webm.enc  inbox/<day>/<id>.json.enc (written last)  inbox/delete/<id>.enc
       done/<day>_<id>.json.enc       coaching/<day>.md.enc                                           */
  var REPO = metaOf('repo');
  var BRANCH = 'speech-drop';
  var LS_WAIT = 'speak_wait_v1';       // uploaded, not yet written out: id -> {day, meta}
  var LS_DEL = 'speak_del_v1';         // deletion asked for, the PC has not removed it yet: id -> true
  var R = { state: 'unknown', etag: {}, sha: {}, cache: {}, listing: null, coachList: null, wait: load(LS_WAIT, {}), del: load(LS_DEL, {}), key: null, keyFor: '' };
  var MODE = 'none';                   // 'helper' | 'repo' | 'none': where recordings go right now
  var getToken = function () { try { return localStorage.getItem('gh_token') || ''; } catch (e) { return ''; } };
  var utf8 = function (s) { return new TextEncoder().encode(s); };

  /* the lock's key, from this device's sign-in */
  function rKey() {
    var t = getToken();
    if (!window.drop) return Promise.reject(new Error('the lock is missing'));
    if (R.key && R.keyFor === t) return Promise.resolve(R.key);
    return window.drop.keyOf(t).then(function (k) { R.key = k; R.keyFor = t; return k; });
  }
  /* GitHub's API for the journal repo; a failed call carries .status. A 304 (nothing changed) costs no allowance. */
  function rapi(method, path, body, etag) {
    var headers = { 'Authorization': 'Bearer ' + getToken(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (etag) headers['If-None-Match'] = etag;
    return fetch('https://api.github.com/repos/' + REPO + path, { method: method, cache: 'no-store', headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 304) return { notModified: true };
        return r.text().then(function (t) {
          var d = null;
          try { d = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) { var err = new Error((d && d.message) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
          if (d && typeof d === 'object') d.__etag = r.headers.get('etag');
          return d;
        });
      }, function () { var err = new Error('No connection'); err.offline = true; throw err; });
  }
  /* what a failed call says about where this browser stands */
  function rState(err) {
    if (err.offline) return 'offline';
    if (err.status === 401) return 'badtoken';
    if (err.status === 403 && !/rate limit|abuse|secondary/i.test(err.message)) return 'badtoken';
    return 'error';
  }
  /* the branch is made on first use (the PC's helper normally makes it, empty; a tablet that gets there first
     makes it from the site's main, which only costs the PC a bigger first download) */
  function rEnsureBranch() {
    return rapi('GET', '/git/ref/heads/' + BRANCH).then(function () { return true; }, function (err) {
      if (err.status !== 404) throw err;
      return rapi('GET', '/git/ref/heads/main').then(function (ref) {
        return rapi('POST', '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: ref.object.sha });
      }).then(function () { return true; }, function (e2) { if (e2.status === 422) return true; throw e2; });
    });
  }
  function rCheck() {
    if (!getToken()) { R.state = 'notoken'; return Promise.resolve(false); }
    if (!window.drop) { R.state = 'error'; R.error = 'the lock is missing'; return Promise.resolve(false); }
    return rEnsureBranch().then(function () { R.state = 'ok'; return true; }, function (e) { R.state = rState(e); R.error = e.message; return false; });
  }
  /* lock and put a file in the branch (one already there counts as done) */
  function rPutFile(rel, bytes, retried) {
    return rKey().then(function (key) { return window.drop.seal(key, bytes); }).then(function (sealed) {
      return rapi('PUT', '/contents/' + rel, { message: 'speak: upload', content: window.drop.toB64(sealed), branch: BRANCH });
    }).catch(function (e) {
      if (e.status === 422) return null;
      if (e.status === 404 && !retried) return rEnsureBranch().then(function () { return rPutFile(rel, bytes, true); });
      throw e;
    });
  }
  function rGetFile(rel) {
    return rapi('GET', '/contents/' + rel + '?ref=' + BRANCH).then(function (f) {
      return rKey().then(function (key) { return window.drop.open(key, window.drop.fromB64(f.content || '')); });
    });
  }
  function rSend(rec) {
    if (sending[rec.id]) return Promise.resolve();
    sending[rec.id] = true;
    var chain = Promise.resolve();
    rec.parts.forEach(function (blob, n) {
      chain = chain.then(function () {
        return blob.arrayBuffer().then(function (ab) { return rPutFile('inbox/' + rec.day + '/' + rec.id + '_' + n + '.webm.enc', new Uint8Array(ab)); });
      });
    });
    return chain.then(function () {
      var m = rec.meta;
      var meta = { id: rec.id, day: rec.day, at: m.at, mode: m.mode, topic: m.topic, cat: m.cat, target: m.target, think: m.think, sec: m.sec, parts: rec.parts.length };
      var diag = rec.diag ? rPutFile('inbox/diag/' + rec.id + '.json.enc', utf8(JSON.stringify(rec.diag))).catch(function () {}) : Promise.resolve();
      return diag.then(function () { return rPutFile('inbox/' + rec.day + '/' + rec.id + '.json.enc', utf8(JSON.stringify(meta))); });   // last: it means "complete"
    }).then(function () {
      R.wait[rec.id] = { day: rec.day, meta: rec.meta };
      save(LS_WAIT, R.wait);
      PEND = PEND.filter(function (p) { return p.id !== rec.id; });
      MEMPEND = MEMPEND.filter(function (p) { return p.id !== rec.id; });
      return idbDel(rec.id);
    }).then(function () { delete sending[rec.id]; rec.lastError = ''; localTranscribe(rec); }, function (e) {
      delete sending[rec.id];
      rec.lastError = (e && e.message) || String(e);
      R.state = rState(e);
    });
  }
  /* the finished takes and the newest coaching note, from the branch (only changed files are fetched) */
  function rRefresh() {
    var fetchOne = function (item) {
      if (R.sha[item.name] === item.sha && R.cache[item.name]) return Promise.resolve(R.cache[item.name]);
      return rGetFile('done/' + encodeURIComponent(item.name)).then(function (bytes) {
        var t = JSON.parse(new TextDecoder().decode(bytes));
        R.cache[item.name] = t; R.sha[item.name] = item.sha;
        return t;
      });
    };
    return rapi('GET', '/contents/done?ref=' + BRANCH, null, R.etag.done).then(function (list) {
      if (list.notModified) return R.listing || [];
      R.etag.done = list.__etag; R.listing = list;
      return list;
    }, function (e) { if (e.status === 404) { R.listing = []; return []; } throw e; }).then(function (list) {
      var all = list.filter(function (f) { return /^\d{4}-\d\d-\d\d_[A-Za-z0-9_-]+\.json\.enc$/.test(f.name); });
      /* a deletion asked for stays hidden until the PC has removed the take; then the record of it can go */
      var present = {};
      all.forEach(function (f) { present[f.name.slice(11, -9)] = 1; });
      Object.keys(R.del).forEach(function (id) { if (!present[id]) delete R.del[id]; });
      save(LS_DEL, R.del);
      var items = all.filter(function (f) { return !R.del[f.name.slice(11, -9)]; })
        .sort(function (a, b) { return a.name < b.name ? 1 : -1; });
      var days = {};
      items.forEach(function (f) { days[f.name.slice(0, 10)] = 1; });
      H.days = Object.keys(days).sort();
      save(LS_DAYS, H.days.slice(-120));
      return Promise.all(items.slice(0, 40).map(function (f) { return fetchOne(f).catch(function () { return null; }); }));
    }).then(function (takes) {
      H.takes = takes.filter(Boolean).sort(function (a, b) { return b.at - a.at; });
      var have = {};
      H.takes.forEach(function (t) { have[t.id] = 1; });
      Object.keys(R.wait).forEach(function (id) { if (have[id]) delete R.wait[id]; });
      save(LS_WAIT, R.wait);
      return rapi('GET', '/contents/coaching?ref=' + BRANCH, null, R.etag.coach).then(function (list) {
        if (list.notModified) list = R.coachList || [];
        else { R.etag.coach = list.__etag; R.coachList = list; }
        var md = list.filter(function (f) { return /^\d{4}-\d\d-\d\d\.md\.enc$/.test(f.name); }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        if (!md.length) { H.coach = null; return; }
        var newest = md[md.length - 1];
        var plainName = newest.name.slice(0, -4);
        if (H.coach && H.coach.name === plainName && R.sha['c:' + newest.name] === newest.sha) return;
        return rGetFile('coaching/' + newest.name).then(function (bytes) {
          H.coach = { name: plainName, text: new TextDecoder().decode(bytes) };
          R.sha['c:' + newest.name] = newest.sha;
        });
      }, function (e) { if (e.status === 404) { H.coach = null; return; } throw e; });
    }).then(function () { R.state = 'ok'; }, function (e) { R.state = rState(e); R.error = e.message; });
  }
  function rDelete(id) {
    return rPutFile('inbox/delete/' + id + '.enc', utf8('{}')).then(function () {
      H.takes = H.takes.filter(function (t) { return t.id !== id; });
      delete R.wait[id];
      save(LS_WAIT, R.wait);
      R.del[id] = true;
      save(LS_DEL, R.del);
    });
  }

  /* ---------- words written on THIS device (the tablet) ----------
     A tablet cannot count on the PC being on, so it writes a first DRAFT of the words itself, with a small
     Whisper that runs in the browser (src/whisperworker.js; the model comes from Hugging Face once and is kept).
     The draft goes back in the drop box like any finished take, marked `draft`, and the PC replaces it with the
     accurate version (Whisper medium) the next time it is on. The recording itself is always uploaded first. */
  var LOCAL_MODEL = window.__localModel || 'onnx-community/whisper-base_timestamped';
  var LS_LOCAL = 'speak_local_v1';       // false when he turned the drafts off
  var LOCAL = { worker: null, p: null, ready: false, device: '', wait: {}, queue: Promise.resolve(), state: '', pct: 0, startedAt: 0 };
  var localOn = function () { return load(LS_LOCAL, true) !== false; };

  /* ---- the worker ---- */
  function localWorker() {
    if (LOCAL.worker) return LOCAL.worker;
    var w = new Worker('/whisperworker.js', { type: 'module' });
    w.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'progress' && m.p) {
        if (m.p.status === 'progress' && m.p.total) LOCAL.pct = Math.max(LOCAL.pct, Math.round(m.p.loaded / m.p.total * 100));
        LOCAL.state = m.p.status === 'ready' ? 'ready' : 'downloading';
        if (m.p.status === 'ready') LOCAL.ready = true;   // the model is loaded: what follows is the writing itself
        paintLocalState();
      } else if (m.type === 'ready') {
        LOCAL.ready = true; LOCAL.device = m.device || ''; LOCAL.state = 'ready'; paintLocalState();
      } else if (m.type === 'result' || m.type === 'error') {
        if (m.type === 'result') LOCAL.ready = true;
        var cb = LOCAL.wait[m.id];
        if (cb) { delete LOCAL.wait[m.id]; cb(m); }
      }
    };
    w.onerror = function (e) {
      dlog('local-worker-error', String((e && e.message) || 'error'));
      Object.keys(LOCAL.wait).forEach(function (id) { var cb = LOCAL.wait[id]; delete LOCAL.wait[id]; cb({ type: 'error', message: 'the word-writer could not start' }); });
      LOCAL.worker = null; LOCAL.state = '';
    };
    LOCAL.worker = w;
    return w;
  }
  function runLocal(pcm) {
    return new Promise(function (resolve, reject) {
      var id = uid();
      LOCAL.wait[id] = function (m) { if (m.type === 'result') resolve(m); else reject(new Error(m.message || 'failed')); };
      localWorker().postMessage({ type: 'run', id: id, model: LOCAL_MODEL, audio: pcm }, [pcm.buffer]);
    });
  }
  /* a recording's blob -> 16 kHz mono samples (the browser decodes and resamples it) */
  function decodePcm(blob) {
    var A = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return blob.arrayBuffer().then(function (ab) {
      var ctx = new A(1, 1, 16000);
      return new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
    }).then(function (buf) {
      var ch = buf.getChannelData(0);
      return new Float32Array(ch);   // a copy: the worker takes ownership of it
    });
  }
  function paintLocalState() {
    var el = $('sstateline');
    if (el && S.phase === 'saved' && LOCAL.active === S.takeId) el.textContent = localLine();
  }
  function localLine() {
    var secs = Math.round((Date.now() - LOCAL.startedAt) / 1000);
    if (LOCAL.state === 'downloading' && !LOCAL.ready) return 'Getting the word-writer ready on this tablet, once only (' + LOCAL.pct + '%). Your recording is already safe.';
    return 'Writing out your words on this tablet (' + secs + ' s)… a first draft: your PC writes a more accurate version when it is on.';
  }

  /* the take as a finished document, the shape the PC writes too */
  function draftTake(rec, words, stats) {
    var m = rec.meta;
    return { id: rec.id, day: rec.day, at: m.at, mod: Date.now(), mode: m.mode, topic: m.topic, cat: m.cat, target: m.target, think: m.think,
      sec: m.sec, delay: null, parts: rec.parts.length, text: words.map(function (x) { return x.w; }).join(' '), words: words, lang: 'en',
      status: 'done', origin: 'tablet', draft: true, audio: stats, error: '' };
  }
  /* all the parts of a recording -> the draft take (not saved anywhere yet) */
  function localDraft(rec) {
    var words = [], stats = [], offset = 0, chain = Promise.resolve();
    rec.parts.forEach(function (blob) {
      chain = chain.then(function () { return decodePcm(blob); }).then(function (pcm) {
        var st = pcmStats(pcm);
        stats.push(st);
        var len = pcm.length / 16000;
        var start = offset;
        offset += len;
        dlog('local', { part: stats.length, sec: st.sec, voice: st.speech_s, peak: st.peak });
        if (st.speech_s < 1) return null;   // no voice in it: nothing is written (a model invents words over silence)
        return runLocal(pcm).then(function (res) { words = words.concat(wordsFromChunks(res.chunks, start, st.speech_s)); dlog('local-done', { n: words.length, device: res.device }); });
      });
    });
    return chain.then(function () { return draftTake(rec, words, stats); });
  }
  /* write the draft into the drop box, unless the PC got there first */
  function putDraft(rec, take) {
    var rel = 'done/' + rec.day + '_' + rec.id + '.json.enc';
    return rapi('GET', '/contents/' + rel + '?ref=' + BRANCH).then(function () { return false; }, function (e) {
      if (e.status !== 404) throw e;
      return rPutFile(rel, utf8(JSON.stringify(take))).then(function () { return true; });
    });
  }
  /* after a recording is safely uploaded: write the draft on this device, one at a time */
  function localTranscribe(rec) {
    if (!localOn() || MODE !== 'repo' || typeof Worker === 'undefined') return Promise.resolve();
    LOCAL.queue = LOCAL.queue.then(function () {
      LOCAL.active = rec.id; LOCAL.startedAt = Date.now(); LOCAL.state = LOCAL.ready ? 'ready' : 'downloading'; LOCAL.pct = 0;
      var tick = setInterval(paintLocalState, 1000);
      paintLocalState();
      return localDraft(rec).then(function (take) { return putDraft(rec, take).then(function (wrote) {
        dlog('draft', { wrote: wrote, words: take.words.length });
        if (wrote) { H.takes = [take].concat(H.takes.filter(function (t) { return t.id !== take.id; })); delete R.wait[take.id]; save(LS_WAIT, R.wait); }
      }); }).catch(function (e) {
        dlog('local-failed', String((e && e.message) || e).slice(0, 160));
        LOCAL.error = (e && e.message) || String(e);
        LOCAL.errorFor = rec.id;
      }).then(function () { clearInterval(tick); LOCAL.active = ''; paintAll(); });
    });
    return LOCAL.queue;
  }
  window.__speakLocal = function (blob) { return localDraft({ id: 'test', day: '2026-01-01', meta: { at: 0, mode: 'free', topic: '', cat: '', target: 0, think: 0, sec: 0 }, parts: [blob] }); };

  /* ---------- the microphone ---------- */
  var MIC = { stream: null, ctx: null, an: null, data: null, rec: null, chunks: [], mime: '', lastSound: 0, lock: null, level: 0 };
  var micMessage = function (e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Chrome is blocking the microphone for this site. Click the lock icon in the address bar, set Microphone to Allow, then try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone was found. Plug one in, or pick another one below.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'The microphone is busy: another app (or another tab) is using it. Close that and try again.';
    return (e && e.message) || 'The microphone could not be opened.';
  };
  function micAlive() {
    var tr = MIC.stream && MIC.stream.getAudioTracks()[0];
    return !!(tr && tr.readyState === 'live');
  }
  function openMic() {
    if (micAlive()) return Promise.resolve(MIC.stream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      return Promise.reject(new Error('This browser cannot record. Use Chrome on the PC.'));
    }
    /* Automatic volume OFF. The first real tablet recording (24 Oct) peaked at 0.99 (near distortion) and had
       noise in the pauses as loud as the voice: the tablet's auto-volume was pumping everything up. Whisper
       reads a clean, steady recording better than a boosted one. Noise reduction stays on. */
    var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 };
    if (pref.device) audio.deviceId = { ideal: pref.device };
    var asked = Date.now();
    return navigator.mediaDevices.getUserMedia({ audio: audio }).then(function (stream) {
      MIC.stream = stream;
      var tr = stream.getAudioTracks()[0];
      try {
        var st = tr.getSettings();
        dlog('mic', { ms: Date.now() - asked, label: (tr.label || '').slice(0, 40), rate: st.sampleRate, ch: st.channelCount, echo: st.echoCancellation, noise: st.noiseSuppression, agc: st.autoGainControl });
      } catch (e) { dlog('mic', { ms: Date.now() - asked }); }
      tr.onended = function () { dlog('track', 'ended'); micLost('The microphone was disconnected.'); };
      tr.onmute = function () { dlog('track', 'muted'); micNote('The microphone is muted (a button on it, or the system).', true); };
      tr.onunmute = function () { dlog('track', 'unmuted'); micNote(S.phase === 'talk' ? 'Recording…' : '', false); };
      try {
        var A = window.AudioContext || window.webkitAudioContext;
        MIC.ctx = new A();
        if (MIC.ctx.state === 'suspended') MIC.ctx.resume();
        dlog('audiocontext', MIC.ctx.state);
        MIC.an = MIC.ctx.createAnalyser();
        MIC.an.fftSize = 1024;
        MIC.ctx.createMediaStreamSource(stream).connect(MIC.an);
        MIC.data = new Uint8Array(MIC.an.fftSize);
      } catch (e) { MIC.an = null; }
      MIC.lastSound = Date.now();
      holdScreen();
      listDevices();
      return stream;
    });
  }
  /* keep the screen awake while the microphone is on: a tablet that dims and sleeps mid-talk stops the page
     (and the recorder). The browser lets go of the lock whenever the page is hidden, so it is taken again
     when the page comes back. */
  function holdScreen() {
    try {
      if (navigator.wakeLock && !MIC.lock && micAlive()) {
        navigator.wakeLock.request('screen').then(function (l) {
          MIC.lock = l;
          dlog('wakelock', 'held');
          l.addEventListener('release', function () { dlog('wakelock', 'released'); if (MIC.lock === l) MIC.lock = null; });
        }, function (e) { dlog('wakelock', 'refused: ' + ((e && e.name) || '')); });
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && micAlive()) holdScreen();
  });
  function closeMic() {
    if (MIC.rec && MIC.rec.state !== 'inactive') { try { MIC.rec.stop(); } catch (e) {} }
    if (MIC.stream) MIC.stream.getTracks().forEach(function (t) { t.onended = null; try { t.stop(); } catch (e) {} });
    if (MIC.ctx) { try { MIC.ctx.close(); } catch (e) {} }
    if (MIC.lock) { try { MIC.lock.release(); } catch (e) {} }
    MIC.stream = MIC.ctx = MIC.an = MIC.lock = MIC.rec = null;
  }
  function level() {
    if (!MIC.an) return 0;
    MIC.an.getByteTimeDomainData(MIC.data);
    var sum = 0;
    for (var i = 0; i < MIC.data.length; i++) { var v = (MIC.data[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / MIC.data.length);
  }
  function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      MIC.devices = list.filter(function (d) { return d.kind === 'audioinput'; });
      var sel = $('sdev');
      if (sel) fillDevSelect(sel);
    }, function () {});
  }
  function fillDevSelect(sel) {
    var cur = (MIC.stream && MIC.stream.getAudioTracks()[0] && MIC.stream.getAudioTracks()[0].getSettings().deviceId) || pref.device || '';
    sel.innerHTML = (MIC.devices || []).map(function (d, i) {
      return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? ' selected' : '') + '>' + esc(d.label || ('Microphone ' + (i + 1))) + '</option>';
    }).join('');
    sel.hidden = !(MIC.devices && MIC.devices.length > 1);
  }

  /* the recorder: one MediaRecorder per stretch of the talk; a take is one or more parts */
  function startRec() {
    if (!micAlive()) return false;
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    MIC.mime = '';
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) { MIC.mime = types[i]; break; }
    MIC.chunks = [];
    try {
      MIC.rec = MIC.mime ? new MediaRecorder(MIC.stream, { mimeType: MIC.mime, audioBitsPerSecond: 48000 }) : new MediaRecorder(MIC.stream, { audioBitsPerSecond: 48000 });
    } catch (e) { micNote(micMessage(e), true); return false; }
    MIC.rec.ondataavailable = function (e) { if (e.data && e.data.size) { MIC.chunks.push(e.data); if (MIC.chunks.length % 5 === 1) dlog('chunk', { n: MIC.chunks.length, bytes: e.data.size }); } };
    MIC.rec.onerror = function (e) { dlog('recorder-error', String((e && e.error && e.error.name) || 'error')); micNote('The recorder stopped unexpectedly.', true); };
    MIC.rec.onstart = function () { dlog('recorder', 'started'); };
    MIC.rec.start(1000);   // a piece every second, so a crash loses at most a second
    dlog('recorder', { mime: MIC.mime || '(default)', state: MIC.rec.state });
    return true;
  }
  function stopRec() {
    return new Promise(function (res) {
      var r = MIC.rec;
      var done = function () {
        var blob = MIC.chunks.length ? new Blob(MIC.chunks, { type: (MIC.mime || 'audio/webm').split(';')[0] }) : null;
        MIC.chunks = [];
        MIC.rec = null;
        res(blob);
      };
      if (!r || r.state === 'inactive') return done();
      r.onstop = done;
      try { r.stop(); } catch (e) { done(); }
    });
  }
  /* the microphone went away in the middle of a take: keep what was recorded, say so, and
     let a tap bring it back (a new part is recorded; the timer has kept running) */
  function micLost(msg) {
    if (S.phase !== 'talk' && S.phase !== 'think') return;
    if (S.phase === 'talk') stopRec().then(function (b) { if (b && b.size) S.parts.push(b); });
    if (MIC.stream) MIC.stream.getTracks().forEach(function (t) { t.onended = null; try { t.stop(); } catch (e) {} });
    MIC.stream = null;
    S.lost = true;
    micNote(msg + ' Plug it back in, then tap Reconnect.', true);
    var b = $('sreconnect');
    if (b) b.hidden = false;
  }

  /* ================= the practice ================= */
  var TOPICS = [];
  try { TOPICS = JSON.parse($('stopics').textContent); } catch (e) {}
  var pref = load(LS_PREF, null) || {};
  pref.target = +pref.target || 60;
  pref.think = pref.think == null ? 30 : +pref.think;
  pref.mode = pref.mode === 'free' ? 'free' : 'topic';

  /* A shape for each kind of topic, shown while thinking and talking. Thinking is the skill being
     practised: a talk with a shape needs fewer "so"s and "um"s because the next step is known. */
  var SHAPES = {
    explain: ['Say what it is, in one sentence', 'Compare it to something they know', 'Say why it matters'],
    persuade: ['Your claim, first', 'Because… (one reason)', 'For example… (one real case)', 'So… (the claim again)'],
    story: ['Where and when', 'What went wrong, or surprised you', 'What happened next', 'What it taught you'],
    describe: ['Start wide: where are we?', 'One sight, one sound, one smell', 'End on how it feels'],
    think: ['Your answer, in one sentence', 'Reason one', 'Reason two', 'One thing against it, and your reply'],
    pitch: ['Who it is for', 'What it does', 'Why they should care', 'What you want them to do'],
    free: ['One idea per sentence', 'Finish the sentence, stay silent a second, then the next']
  };
  function shapeHtml(cat) {
    var steps = SHAPES[cat] || SHAPES.free;
    return '<ol class="sshape" aria-label="A shape for this talk">' + steps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>';
  }

  var stage = $('sstage');
  var S = { phase: 'idle', free: false, topic: null, think0: 0, talk0: 0, sec: 0, parts: [], takeId: '', day: '', timer: 0, lost: false, err: '' };

  function setTopic(t) {
    S.topic = t;
    var seen = load(LS_SEEN, []);
    seen.push(t[1]);
    save(LS_SEEN, seen.slice(-60));
  }
  function newTopic() { setTopic(pickTopic(TOPICS, load(LS_SEEN, []))); }
  var fmt = function (s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + pad(s % 60); };

  function micNote(text, bad) {
    var m = $('smic');
    if (m) { m.textContent = text; m.classList.toggle('bad', !!bad); }
  }
  var meter = function () { return '<div class="slevel" aria-hidden="true"><i id="slevelfill"></i></div>'; };

  /* "write a first draft on this device": only offered where the words would otherwise wait for the PC */
  function localSwitch() {
    if (MODE !== 'repo') return '';
    return '<p class="slocal"><label><input type="checkbox" id="slocal"' + (localOn() ? ' checked' : '') + '> Write a first draft of the words on this tablet</label>'
      + '<span class="muted small"> The first time it downloads about 77 MB, once. Your PC replaces the draft with a more accurate version when it is on.</span></p>';
  }
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
          + shapeHtml(S.topic ? S.topic[0] : 'free')
          + '<div class="srow"><button type="button" class="btn ghost small" data-a="shuffle">Another topic</button>'
          + '<label class="slen">Talk for <select id="slen">' + [1, 2, 3].map(function (m) {
            return '<option value="' + m * 60 + '"' + (pref.target === m * 60 ? ' selected' : '') + '>' + m + ' min</option>';
          }).join('') + '</select></label>'
          + '<label class="slen">Think for <select id="sthink">' + [[0, 'no time'], [30, '30 s'], [60, '1 min']].map(function (o) {
            return '<option value="' + o[0] + '"' + (pref.think === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select></label></div>'
          + '<button type="button" class="btn primary big sgo" data-a="begin">' + (pref.think ? 'Start thinking' : 'Start talking') + '</button>' + localSwitch();
      } else {
        h += '<p class="stopic">Say anything: an idea, a worry, the day, a plan. No timer. Press stop when you are done.</p>' + shapeHtml('free')
          + '<button type="button" class="btn primary big sgo" data-a="free">Start talking</button>' + localSwitch();
      }
      h += '<p class="muted small' + (S.err ? ' bad' : '') + '" id="smic">' + esc(S.err) + '</p>'
        + '<select id="sdev" class="sdev" aria-label="Microphone" hidden></select>';
    } else if (S.phase === 'think') {
      h += '<p class="stopiccat">Think. Decide your first sentence only.</p>'
        + '<p class="stopic">' + esc(S.topic[1]) + '</p>' + shapeHtml(S.topic[0])
        + '<p class="sclock" id="sclock">' + fmt(pref.think) + '</p>' + meter()
        + '<p class="muted small" id="smic">The microphone is on. Recording starts by itself when the time is up.</p>'
        + '<div class="srow"><button type="button" class="btn primary big sgo" data-a="talk">I am ready</button>'
        + '<button type="button" class="btn ghost small" data-a="reconnect" id="sreconnect" hidden>Reconnect the microphone</button></div>'
        + '<select id="sdev" class="sdev" aria-label="Microphone" hidden></select>';
    } else if (S.phase === 'talk') {
      h += (S.free ? '' : '<p class="stopic small">' + esc(S.topic[1]) + '</p>' + shapeHtml(S.topic[0]))
        + '<p class="sclock live" id="sclock">' + (S.free ? '0:00' : fmt(pref.target)) + '</p>' + meter()
        + '<p class="muted small" id="smic">Recording… speak, the bar should move.</p>'
        + '<div class="srow"><button type="button" class="btn primary big sgo" data-a="stop">' + (S.free ? 'Stop' : 'Done early') + '</button>'
        + '<button type="button" class="btn ghost small" data-a="reconnect" id="sreconnect" hidden>Reconnect the microphone</button></div>'
        + '<select id="sdev" class="sdev" aria-label="Microphone" hidden></select>';
    } else if (S.phase === 'saved') {
      h += '<p class="stopiccat">' + (S.free ? 'Free talk' : esc(S.topic ? S.topic[1] : '')) + '</p>'
        + '<div id="sresult"></div>'
        + '<div class="srow"><button type="button" class="btn primary big" data-a="again">Another take</button>'
        + (S.free ? '' : '<button type="button" class="btn" data-a="repeat">Same topic again</button>')
        + '<a class="btn ghost" href="/">Back to Today</a></div>';
    }
    stage.innerHTML = h;
    if (S.phase === 'think' || S.phase === 'talk') {
      S.timer = setInterval(tick, 100);
      var sel = $('sdev');
      if (sel && MIC.devices) fillDevSelect(sel);
      if (S.lost) { var rb = $('sreconnect'); if (rb) rb.hidden = false; }
    }
    if (S.phase === 'idle') { var s2 = $('sdev'); if (s2 && MIC.devices) fillDevSelect(s2); }
    if (S.phase === 'saved') paintResult();
  }

  var warnedQuiet = false;
  var LV = { sum: 0, n: 0, max: 0, at: Date.now() };
  function tick() {
    var now = Date.now();
    var clock = $('sclock');
    var lv = level();
    LV.sum += lv; LV.n++; LV.max = Math.max(LV.max, lv);
    if (now - LV.at >= 2000) { dlog('level', { avg: Math.round(LV.sum / Math.max(1, LV.n) * 1000) / 1000, max: Math.round(LV.max * 1000) / 1000, phase: S.phase }); LV = { sum: 0, n: 0, max: 0, at: now }; }
    var fill = $('slevelfill');
    if (fill) fill.style.width = Math.min(100, Math.round(lv * 800)) + '%';
    if (lv > 0.006) { MIC.lastSound = now; if (warnedQuiet) { warnedQuiet = false; micNote(S.phase === 'talk' ? 'Recording…' : 'The microphone is on.', false); } }
    else if (!S.lost && micAlive() && now - MIC.lastSound > 6000 && !warnedQuiet) {
      warnedQuiet = true;
      dlog('warning', 'no sound for 6 s');
      micNote('I cannot hear anything. Is the microphone muted, or is the wrong one chosen? Pick another below.', true);
      var sel = $('sdev');
      if (sel) { fillDevSelect(sel); sel.hidden = false; }
    }
    /* the recorder can be stopped by the system (a tablet short of memory, a call): keep what it had and start again */
    if (S.phase === 'talk' && !S.lost && micAlive() && MIC.rec && MIC.rec.state === 'inactive') {
      dlog('recorder', 'stopped by the system');
      var kept = MIC.chunks.length ? new Blob(MIC.chunks, { type: (MIC.mime || 'audio/webm').split(';')[0] }) : null;
      MIC.chunks = [];
      if (kept && kept.size) S.parts.push(kept);
      if (startRec()) micNote('The recorder stopped by itself, so it was started again. What you said before is kept.', false);
    }
    if (S.phase === 'think') {
      var left = pref.think - (now - S.think0) / 1000;
      if (clock) clock.textContent = fmt(Math.ceil(left));
      if (left <= 0) startTalk();
    } else if (S.phase === 'talk') {
      var el = (now - S.talk0) / 1000;
      if (S.free) { if (clock) clock.textContent = fmt(el); }
      else {
        var rem = pref.target - el;
        if (clock) { clock.textContent = fmt(Math.ceil(rem)); clock.classList.toggle('low', rem <= 10); }
        if (rem <= 0) finishTalk();
      }
    }
  }

  /* "Go": a short buzz and a flash, NOT a tone. A sound out of the speaker at the moment the microphone
     opens changes the tablet's audio route and can glitch the very start of the recording (and the
     recording can pick up the beep). */
  function goSignal() {
    try { if (navigator.vibrate) navigator.vibrate(70); } catch (e) {}
    var c = $('sclock');
    if (c) { c.classList.add('go'); setTimeout(function () { c.classList.remove('go'); }, 700); }
  }

  /* ---------- the phases ---------- */
  /* the tap opens the microphone (a tap is what lets the browser do that); nothing later
     depends on another tap, so the timer can start the recording by itself */
  function begin(free) {
    LOG = []; LOG0 = Date.now();
    dlog('begin', { free: !!free, think: pref.think, target: pref.target, mode: MODE });
    S.free = !!free;
    S.err = '';
    S.lost = false;
    S.parts = [];
    openMic().then(function () {
      if (!free && pref.think > 0) { S.phase = 'think'; S.think0 = Date.now(); draw(); }
      else startTalk();
    }, function (e) {
      S.err = micMessage(e);
      draw();
    });
  }
  function startTalk() {
    if (S.phase === 'talk') return;
    if (!micAlive()) {
      // the microphone was lost while thinking: ask again (this may need a tap)
      S.phase = 'think'; S.lost = true; draw();
      micNote('The microphone is not on. Tap Reconnect.', true);
      var rb = $('sreconnect'); if (rb) rb.hidden = false;
      return;
    }
    dlog('phase', 'talk');
    S.phase = 'talk';
    S.talk0 = Date.now();
    S.day = dayKey(S.talk0);
    S.takeId = uid();
    warnedQuiet = false;
    draw();
    if (!startRec()) { micNote('The recorder could not start. Tap Reconnect.', true); var b = $('sreconnect'); if (b) b.hidden = false; return; }
    goSignal();
  }
  function reconnect() {
    S.err = '';
    openMic().then(function () {
      S.lost = false;
      MIC.lastSound = Date.now();
      var b = $('sreconnect'); if (b) b.hidden = true;
      if (S.phase === 'talk') { if (startRec()) micNote('Recording again…', false); }
      else if (S.phase === 'think') micNote('The microphone is on.', false);
    }, function (e) { micNote(micMessage(e), true); });
  }
  function finishTalk() {
    if (S.phase !== 'talk') return;
    S.sec = Math.round((Date.now() - S.talk0) / 1000);
    if (!S.free) S.sec = Math.min(S.sec, pref.target);
    dlog('phase', { finish: S.sec, parts: S.parts.length });
    clearInterval(S.timer);
    stopRec().then(function (blob) {
      if (blob && blob.size) S.parts.push(blob);
      closeMic();
      if (S.sec < 3 || !S.parts.length) {
        S.phase = 'idle';
        S.err = S.parts.length ? 'That was under three seconds, so nothing was saved.' : 'Nothing was recorded. Check the microphone and try again.';
        draw();
        return;
      }
      dlog('saved', { parts: S.parts.map(function (b) { return b.size; }) });
      var rec = {
        id: S.takeId, day: S.day, parts: S.parts, diag: diagDoc(S.takeId),
        meta: { at: S.talk0, mode: S.free ? 'free' : 'topic', topic: S.free ? '' : S.topic[1], cat: S.free ? '' : S.topic[0], target: S.free ? 0 : pref.target, think: S.free ? 0 : pref.think, sec: S.sec }
      };
      PEND.push(rec);
      if (H.days.indexOf(rec.day) < 0) { H.days.push(rec.day); H.days.sort(); save(LS_DAYS, H.days.slice(-120)); }
      S.phase = 'saved';
      draw();
      paintAll();
      // into the browser's own storage first: nothing can lose it from here
      return idbPut(rec).then(function (ok) {
        if (!ok) MEMPEND.push(rec);
        return syncNow();
      });
    });
  }

  /* ---------- results ---------- */
  function chip(label, value, note, cls) {
    return '<div class="schip' + (cls ? ' ' + cls : '') + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span>' + (note ? '<i>' + esc(note) + '</i>' : '') + '</div>';
  }
  function fillerList(st) {
    return Object.keys(st.fillers).sort(function (a, b) { return st.fillers[b] - st.fillers[a]; })
      .map(function (k) { return k + ' ×' + st.fillers[k]; }).join(', ');
  }
  function factsHtml(st, t) {
    var pa = st.pauses;
    var pace = st.wpm == null ? '–' : st.wpm;
    return '<div class="schips">'
      + chip('words', st.words, t.sec ? 'in ' + fmt(t.sec) : '')
      + chip('words a minute', pace, st.wpm == null ? '' : (st.wpm > 175 ? 'fast' : st.wpm < 95 ? 'slow' : 'steady'))
      + chip('fillers a minute', st.fillerPerMin == null ? '–' : st.fillerPerMin, st.fillerTotal ? fillerList(st) : 'none caught')
      + chip('pauses over 0.7 s', pa.count, pa.count ? 'longest ' + pa.longest + ' s' : '')
      + chip('first word after', pa.first == null ? '–' : pa.first + ' s', '')
      + (st.openers ? chip('"So" / "And" starters', st.openers.count, 'of ' + st.openers.sentences + (st.openers.sentences === 1 ? ' sentence' : ' sentences'), st.openers.count > st.openers.sentences * 0.25 ? 'warn' : '') : '')
      + '</div>'
      + (st.restarts ? '<p class="small muted">' + st.restarts + ' restart' + (st.restarts > 1 ? 's' : '') + ' (a phrase said twice).</p>' : '')
      + audioNotes(t.audio).map(function (n) { return '<p class="small audionote">' + esc(n) + '</p>'; }).join('');
  }
  function draftNote(t) {
    return t && t.draft ? '<p class="small muted draftnote">A first draft, written on this tablet. Your PC writes a more accurate version when it is on.</p>' : '';
  }
  function transcriptHtml(t, st) {
    if (!t.words || !t.words.length) return '<p class="stx">' + esc(t.text || 'No words were found in this recording.') + '</p>' + draftNote(t);
    return draftNote(t) + '<p class="stx">' + segmentsOf(t.words, st).map(function (s) {
      var h = '';
      if (s.gap) h += '<span class="wp' + (s.gap >= 1.5 ? ' long' : '') + '">' + s.gap.toFixed(1) + ' s</span> ';
      h += s.filler ? '<span class="wf">' + esc(s.w) + '</span>' : esc(s.w);
      return h;
    }).join(' ') + '</p>';
  }
  function takeOf(id) {
    for (var i = 0; i < H.takes.length; i++) if (H.takes[i].id === id) return H.takes[i];
    return null;
  }
  function stateLine(t, rec, up) {
    if (rec && !t) {
      if (rec.lastError) return 'Your recording is safe in this browser, but sending it failed (' + rec.lastError + '). Trying again.';
      if (MODE === 'repo') return 'Sending your recording to your private repo…';
      return H.up ? 'Sending your recording to the helper…'
        : 'Your recording is safe in this browser. The helper is not running, so it will be written out as soon as it is.';
    }
    if (!t && up && LOCAL.active && LOCAL.active === S.takeId) return localLine();
    if (!t && up && LOCAL.error && LOCAL.errorFor === S.takeId) return 'The tablet could not write a draft (' + LOCAL.error + '). Your PC will write the words when it is on. The recording is safe.';
    if (!t && up) return 'Uploaded. Your PC writes out the words when it is on, usually a minute or two after it sees the recording. The recording is safe.';
    if (!t) return 'Waiting…';
    if (t.status === 'queued') return 'In line to be written out…';
    if (t.status === 'transcribing') return 'Writing out your words. This takes about a minute…';
    if (t.status === 'error') return 'The words could not be written out: ' + (t.error || 'unknown problem') + '.';
    return '';
  }
  function paintResult() {
    var box = $('sresult');
    if (!box) return;
    var t = takeOf(S.takeId);
    var rec = PEND.filter(function (p) { return p.id === S.takeId; })[0];
    if (t && t.status === 'done') {
      var st = factsOf(t);
      box.innerHTML = '<p class="muted small">Saved. Here are the facts; the advice comes from me, after I read it.</p>'
        + (st ? factsHtml(st, t) : '') + transcriptHtml(t, st)
        + '<p class="muted small"><span class="wf">filler</span> words and the <span class="wp">pauses</span> are marked.</p>';
      return;
    }
    box.innerHTML = '<p class="stopic small">Saved.</p><p class="muted" id="sstateline">' + esc(stateLine(t, rec, !!R.wait[S.takeId])) + '</p>'
      + (t && t.status === 'error' && MODE === 'helper' ? '<div class="srow"><button type="button" class="btn small" data-retry="' + esc(t.id) + '">Try again</button></div>' : '');
  }

  /* ---------- history, coaching, connection ---------- */
  var timeOf = function (ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var niceDay = function (k) { return +k.slice(8) + ' ' + MON[+k.slice(5, 7) - 1]; };

  function allDays() {
    var set = {};
    H.days.forEach(function (d) { set[d] = 1; });
    PEND.forEach(function (p) { set[p.day] = 1; });
    return Object.keys(set).sort();
  }
  function paintHistory() {
    var box = $('shist');
    if (!box) return;
    var today = dayKey(Date.now());
    var s = streakOf(allDays(), today);
    var done = H.takes.filter(function (t) { return t.status === 'done'; });
    var facts = {};
    done.forEach(function (t) { facts[t.id] = factsOf(t); });
    var week = done.filter(function (t) { return t.day >= addDays(today, -6); });
    var head = '<div class="cardhead"><h3>Your practice</h3><span class="count">' + s.days + ' day' + (s.days === 1 ? '' : 's') + ' in a row</span></div>';
    var sum = '';
    if (week.length) {
      var mins = Math.round(week.reduce(function (a, t) { return a + (t.sec || 0); }, 0) / 60 * 10) / 10;
      var fpm = average(week, function (t) { return facts[t.id] && facts[t.id].fillerPerMin; });
      var wpm = average(week, function (t) { return facts[t.id] && facts[t.id].wpm; });
      sum = '<p class="small">This week: <b>' + week.length + '</b> take' + (week.length > 1 ? 's' : '') + ', <b>' + mins + '</b> min spoken'
        + (fpm != null ? ', <b>' + fpm + '</b> fillers a minute on average' : '') + (wpm != null ? ', <b>' + wpm + '</b> words a minute' : '') + '.</p>';
    }
    var waiting = PEND.map(function (p) {
      return '<div class="stake wait"><span class="sd">' + esc(niceDay(p.day)) + ' · ' + timeOf(p.meta.at) + '</span> '
        + '<span class="stt">' + esc(p.meta.mode === 'free' ? 'Free talk' : p.meta.topic) + '</span> '
        + '<span class="sm">' + (MODE === 'repo' ? 'recorded, sending…' : 'recorded, waiting for the helper') + '</span></div>';
    }).join('') + Object.keys(R.wait).filter(function (id) { return !takeOf(id) && !PEND.some(function (p) { return p.id === id; }); }).map(function (id) {
      var w = R.wait[id];
      return '<div class="stake wait"><span class="sd">' + esc(niceDay(w.day)) + ' · ' + timeOf(w.meta.at) + '</span> '
        + '<span class="stt">' + esc(w.meta.mode === 'free' ? 'Free talk' : w.meta.topic) + '</span> '
        + '<span class="sm">uploaded, waiting for your PC to write it out</span></div>';
    }).join('');
    var rows = H.takes.slice(0, 15).map(function (t) {
      var st = facts[t.id];
      var meta = t.status === 'done' && st
        ? (st.fillerPerMin != null ? st.fillerPerMin + ' fill/min · ' : '') + (st.wpm != null ? st.wpm + ' wpm · ' : '') + st.pauses.count + ' pauses'
        : stateLine(t, null);
      var audio = '';
      for (var i = 0; MODE === 'helper' && i < (t.parts || 0); i++) audio += '<audio controls preload="none" src="' + HELPER + '/audio/' + esc(t.id) + '/' + i + '"></audio>';
      return '<details class="stake" data-id="' + esc(t.id) + '"><summary><span class="sd">' + esc(niceDay(t.day)) + ' · ' + timeOf(t.at) + '</span>'
        + '<span class="stt">' + esc(t.mode === 'free' ? 'Free talk' : t.topic) + '</span>'
        + '<span class="sm">' + esc(meta) + '</span></summary>'
        + (st ? factsHtml(st, t) : '') + (t.status === 'done' ? transcriptHtml(t, st) : '')
        + (audio ? '<div class="saudio">' + audio + '</div>' : '')
        + '<button type="button" class="btn ghost small danger" data-del="' + esc(t.id) + '">Delete this take</button></details>';
    }).join('');
    box.innerHTML = head + sum + waiting + (rows || (waiting ? '' : '<p class="muted small">Nothing yet. Your first take goes here.</p>'));
  }
  function paintCoach() {
    var box = $('scoach');
    if (!box) return;
    if (!H.coach) { box.hidden = true; return; }
    box.hidden = false;
    var day = H.coach.name.replace('.md', '');
    box.innerHTML = '<div class="cardhead"><h3>Coaching</h3><span class="count">' + esc(niceDay(day)) + '</span></div>'
      + '<div class="scoachtext">' + noteHtml(H.coach.text) + '</div>';
  }
  function paintConn() {
    var box = $('sstatus');
    if (!box) return;
    var msg = '';
    if (H.asked && !H.up && !getToken()) {
      var waiting = PEND.length ? ' (' + PEND.length + ' recording' + (PEND.length > 1 ? 's' : '') + ' waiting in this browser, safe)' : '';
      msg = ON_HELPER
        ? 'The helper is not answering' + waiting + '. Start it with <b>Start Speak helper</b> in <code>C:\\Users\\shyam\\SpeechJournal</code>.'
        : 'This page cannot reach the Speak helper' + waiting + '. Open <a href="http://localhost:4777/speak/"><b>Speak on this PC</b></a> '
          + '(works even if Chrome blocks this page from reaching your PC), and record there. '
          + 'If that page does not open, start the helper with <b>Start Speak helper</b> in <code>C:\\Users\\shyam\\SpeechJournal</code>.';
    } else if (H.up && H.info && H.info.whisper === 'missing') {
      msg = 'The helper is running but the Whisper model is missing, so recordings cannot be written out yet.';
    }
    if (MODE === 'none' && H.asked && !H.up) {
      var wait2 = PEND.length ? ' Your ' + PEND.length + ' recording' + (PEND.length > 1 ? 's are' : ' is') + ' safe on this device.' : '';
      if (R.state === 'badtoken') msg = 'Your sign-in has expired or was refused. Sign in again on the <a href="/admin/#signin">Write page</a>.' + wait2;
      else if (R.state === 'offline') msg = 'No connection right now.' + wait2 + ' It goes up when you are back online.';
      else if (R.state === 'error') msg = 'The private repo did not answer (' + esc(R.error || '') + ').' + wait2 + ' It is tried again shortly.';
      else if (R.state === 'notoken' && !ON_HELPER) msg = 'This device is not signed in, and the Speak helper is not reachable from here. Sign in on the <a href="/admin/#signin">Write page</a> so recordings can go to your private repo and be written out by your PC.' + wait2;
    }
    box.hidden = !msg;
    box.innerHTML = msg;
  }
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
  function paintAll() {
    if (app) { paintHistory(); paintCoach(); paintConn(); if (S.phase === 'saved') paintResult(); }
    paintHome();
  }

  function deleteTake(id) {
    if (!window.confirm('Delete this take and its recording for good?')) return;
    var t = takeOf(id);
    var gone = MODE === 'repo'
      ? rDelete(id).then(function () { toast('Delete requested: your PC removes it the next time it is on.'); })
      : hjson('/take/' + encodeURIComponent(id), { method: 'DELETE' }, 8000).then(function () {
        H.takes = H.takes.filter(function (x) { return x.id !== id; });
        return refreshTakes();
      });
    gone.then(paintAll, function (e) { toast('Could not delete: ' + e.message, 'err'); });
  }

  /* ---------- keeping in step with the helper ---------- */
  var busy = false;
  function syncNow() {
    if (busy) return Promise.resolve();
    busy = true;
    return ping().then(function () { return loadPending(); }).then(function () {
      if (H.up) { MODE = 'helper'; return sendAllPending().then(refreshTakes); }
      /* no helper here (a tablet, a phone): the private repo, checked now and then, not on every beat */
      var fresh = R.state === 'ok' && Date.now() - (R.checkedAt || 0) < 600000;
      return (fresh ? Promise.resolve(true) : rCheck().then(function (ok) { if (ok) R.checkedAt = Date.now(); return ok; })).then(function (ok) {
        if (!ok) { MODE = 'none'; return null; }
        var was = MODE;
        MODE = 'repo';
        if (was !== MODE && S.phase === 'idle') draw();
        return sendAllPending().then(rRefresh);
      });
    }).then(function () { busy = false; paintAll(); }, function () { busy = false; paintAll(); });
  }
  /* fast while a take is being written out, slow otherwise */
  function pollDelay() {
    var working = H.takes.some(function (t) { return t.status === 'queued' || t.status === 'transcribing'; }) || PEND.length > 0 || S.phase === 'saved';
    if (MODE === 'repo' && Object.keys(R.wait).length && !PEND.length) return 8000;
    return working ? 2500 : 20000;
  }
  function loop() {
    var go = function () {
      if (document.visibilityState === 'hidden' || S.phase === 'talk') return setTimeout(go, 4000);
      syncNow().then(function () { setTimeout(go, pollDelay()); });
    };
    setTimeout(go, pollDelay());
  }

  if (!app) {
    // the Today card: the streak, from the last time the helper was asked
    loadPending().then(function () { paintHome(); return syncNow(); });
    return;
  }

  /* ---------- wiring ---------- */
  app.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) { deleteTake(del.getAttribute('data-del')); return; }
    var rt = e.target.closest('[data-retry]');
    if (rt && MODE === 'helper') { hjson('/take/' + encodeURIComponent(rt.getAttribute('data-retry')) + '/retry', { method: 'POST' }, 8000).then(syncNow, function () {}); return; }
    var mode = e.target.closest('[data-mode]');
    if (mode && S.phase === 'idle') { pref.mode = mode.getAttribute('data-mode'); save(LS_PREF, pref); S.err = ''; draw(); return; }
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'shuffle') { newTopic(); draw(); }
    else if (a === 'begin') begin(false);
    else if (a === 'free') begin(true);
    else if (a === 'talk') startTalk();
    else if (a === 'stop') finishTalk();
    else if (a === 'reconnect') reconnect();
    else if (a === 'again') { S.phase = 'idle'; S.topic = null; S.err = ''; draw(); }
    else if (a === 'repeat') { S.phase = 'idle'; S.err = ''; pref.mode = 'topic'; draw(); }
  });
  app.addEventListener('change', function (e) {
    if (e.target.id === 'slen') { pref.target = +e.target.value || 60; save(LS_PREF, pref); }
    if (e.target.id === 'sthink') { pref.think = +e.target.value; save(LS_PREF, pref); draw(); }
    if (e.target.id === 'slocal') { save(LS_LOCAL, !!e.target.checked); return; }
    if (e.target.id === 'sdev') {
      pref.device = e.target.value; save(LS_PREF, pref);
      // switch the live microphone to the chosen one
      var wasTalking = S.phase === 'talk';
      var go = function () {
        if (MIC.stream) MIC.stream.getTracks().forEach(function (t) { t.onended = null; try { t.stop(); } catch (er) {} });
        MIC.stream = null;
        reconnect();
      };
      if (wasTalking) stopRec().then(function (blob) { if (blob && blob.size) S.parts.push(blob); go(); });
      else if (S.phase === 'think') go();
    }
  });
  window.addEventListener('beforeunload', function (e) {
    if (S.phase === 'talk') { e.preventDefault(); e.returnValue = ''; }
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', listDevices);
  }

  draw();
  loadPending().then(function () { paintAll(); return syncNow(); }).then(loop);
})();
