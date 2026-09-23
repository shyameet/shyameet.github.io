/* Focus: a block timer, and a running total of focused time.

   Two jobs, one file:
   1. On /focus/ -- the timer. Presets or a custom length, pause, +5, and an
      alarm when a block ends: a bell, a notification, a vibration, a flashing
      tab title. Every finished (or stopped) block goes into the log.
   2. On any page with [data-focus-card] -- keep "Focus today" live.

   Where the log lives:
   - localStorage first, always: instant, offline, survives a reload.
   - Then, if this browser holds the journal token, content/focus/YYYY-MM-DD.json
     in the repo -- so the total follows him from the desk to the phone, and
     the site can show it on every day page.

   Timing never counts ticks. A block is a start time plus a length, and the
   clock is recomputed from Date.now() -- so a throttled background tab, a
   sleeping laptop or a closed page cannot make it drift. The tick itself comes
   from a Worker, because browsers slow a hidden tab's own timers to about once
   a minute and the bell would ring late. */
(function () {
  'use strict';

  var dataEl = document.getElementById('focusdata');
  if (!dataEl) return;
  var DATA = {};
  try { DATA = JSON.parse(dataEl.textContent) || {}; } catch (e) { DATA = {}; }

  var LS_SESSIONS = 'focus_sessions_v1';
  var LS_RUN = 'focus_running_v1';
  var LS_PREFS = 'focus_prefs_v1';
  var LS_GONE = 'focus_deleted_v1';

  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function save(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  var token = '';
  try { token = localStorage.getItem('gh_token') || ''; } catch (e) {}

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
  var today = function () { return dayKey(Date.now()); };

  /* ---------- the log ----------
     a session: { id, start, end (ms), sec (focused seconds), day, synced } */
  var sessions = load(LS_SESSIONS, []);
  var gone = load(LS_GONE, []);            // [{id, day}] deleted here, not yet in the repo
  var remote = {};                          // day -> sessions as the repo has them

  function fromRepo(s) {
    var a = Date.parse(s && s.start);
    if (!s || !s.id || isNaN(a) || !(+s.sec > 0)) return null;
    var b = Date.parse(s.end);
    return { id: s.id, start: a, end: isNaN(b) ? a + s.sec * 1000 : b, sec: +s.sec, day: dayKey(a), synced: true };
  }
  function toRepo(s) {
    return { id: s.id, start: localIso(s.start), end: localIso(s.end), sec: Math.round(s.sec) };
  }
  /* what the build already knew about its "today" */
  if (DATA.today && Array.isArray(DATA.sessions)) {
    remote[DATA.today] = DATA.sessions.map(fromRepo).filter(Boolean);
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
      .sort(function (a, b) { return a.start - b.start; });
  }
  var sumSec = function (list) { return list.reduce(function (t, s) { return t + s.sec; }, 0); };

  /* A past day: the build's total, plus anything logged here that has not
     reached the repo yet. Today: the full de-duplicated list. */
  function secOn(day) {
    if (day === today() || remote[day]) return sumSec(dayList(day));
    var base = (DATA.days && DATA.days[day] && DATA.days[day].sec) || 0;
    return base + sumSec(sessions.filter(function (s) { return s.day === day && !s.synced; }));
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
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      cache: 'no-store',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((data && data.message) || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }
  var fileUrl = function (day) {
    return 'https://api.github.com/repos/' + DATA.repo + '/contents/content/focus/' + day + '.json';
  };
  function getDay(day) {
    return api('GET', fileUrl(day) + '?ref=' + encodeURIComponent(DATA.branch || 'main'))
      .then(function (file) {
        var list = [];
        try { list = (JSON.parse(b64decode(file.content)).sessions || []); } catch (e) { list = []; }
        return { sha: file.sha, list: list };
      })
      .catch(function (err) { if (err.status === 404) return { sha: null, list: [] }; throw err; });
  }

  var chain = Promise.resolve();
  var syncState = token ? 'ok' : 'local';

  /* Merge this device's blocks for one day into the repo's file, one write at
     a time. A 409 means another device wrote in between: fetch and merge again. */
  function syncDay(day) {
    if (!token || !DATA.repo) { syncState = 'local'; renderSync(); return Promise.resolve(false); }
    var attempt = function (triesLeft) {
      return getDay(day).then(function (got) {
        var byId = {};
        got.list.forEach(function (s) { if (s && s.id) byId[s.id] = s; });
        var addedSec = 0;
        var removed = 0;
        sessions.forEach(function (s) {
          if (s.day === day && !byId[s.id]) { byId[s.id] = toRepo(s); addedSec += s.sec; }
        });
        gone.forEach(function (g) {
          if (g.day === day && byId[g.id]) { delete byId[g.id]; removed++; }
        });
        var list = Object.keys(byId).map(function (k) { return byId[k]; })
          .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
        var finish = function () {
          remote[day] = list.map(fromRepo).filter(Boolean);
          sessions.forEach(function (s) { if (s.day === day) s.synced = true; });
          gone = gone.filter(function (g) { return g.day !== day; });
          persist();
          syncState = 'ok';
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
    chain = chain.then(function () { return attempt(2); }).catch(function (err) {
      syncState = err.status === 401 ? 'badtoken' : 'offline';
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

  var lastFetch = 0;
  function fetchToday() {
    if (!token || !DATA.repo || Date.now() - lastFetch < 20000) return;
    lastFetch = Date.now();
    var day = today();
    getDay(day).then(function (got) {
      remote[day] = got.list.map(fromRepo).filter(Boolean);
      syncState = 'ok';
      renderAll();
    }, function (err) {
      syncState = err.status === 401 ? 'badtoken' : 'offline';
      renderSync();
    });
  }

  /* ---------- the timer ---------- */
  var prefs = load(LS_PREFS, {});
  if (prefs.sound == null) prefs.sound = true;
  if (prefs.wake == null) prefs.wake = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  var presets = Array.isArray(DATA.presets) && DATA.presets.length ? DATA.presets : [25, 30, 45, 60, 90];
  var minutes = +prefs.minutes || +DATA.defaultMinutes || 30;

  /* the running block: { id, startedAt, planned (sec), acc (sec banked before
     the current stretch), seg (ms the current stretch began, null = paused) } */
  var run = load(LS_RUN, null);
  var state = 'idle';
  var alarmAt = 0;
  var bellsRung = 0;

  function elapsed() {
    if (!run) return 0;
    return run.acc + (run.seg ? (Date.now() - run.seg) / 1000 : 0);
  }
  function remaining() { return run ? run.planned - elapsed() : minutes * 60; }

  var app = $('focusapp');

  function start(mins) {
    unlockAudio();
    askNotify();
    if (mins) minutes = mins;
    prefs.minutes = minutes;
    save(LS_PREFS, prefs);
    var now = Date.now();
    run = { id: uid(), startedAt: now, planned: minutes * 60, acc: 0, seg: now };
    save(LS_RUN, run);
    stopAlarm();
    state = 'running';
    note('');
    softBell();
    wake(true);
    ticking(true);
    renderAll();
  }
  function pause() {
    if (!run || !run.seg) return;
    run.acc = elapsed();
    run.seg = null;
    save(LS_RUN, run);
    state = 'paused';
    wake(false);
    renderAll();
  }
  function resume() {
    if (!run || run.seg) return;
    unlockAudio();
    run.seg = Date.now();
    save(LS_RUN, run);
    state = 'running';
    wake(true);
    ticking(true);
    renderAll();
  }
  function extend() {
    if (!run) return;
    run.planned += 300;
    save(LS_RUN, run);
    renderAll();
  }

  /* close the running block and log it (if it is worth logging) */
  function closeRun(sec, endMs) {
    var r = run;
    run = null;
    save(LS_RUN, null);
    wake(false);
    if (!r) return null;
    /* another tab may have closed this same block already */
    sessions = load(LS_SESSIONS, sessions);
    if (sec < 60 || sessions.some(function (s) { return s.id === r.id; })) return null;
    var s = { id: r.id, start: r.startedAt, end: endMs || Date.now(), sec: Math.round(sec), day: dayKey(r.startedAt), synced: false };
    sessions.push(s);
    persist();
    syncDay(s.day);
    return s;
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
    var endMs = r.seg ? r.seg + (r.planned - r.acc) * 1000 : Date.now();
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
    if (state === 'running' && run && run.seg && remaining() <= 0) { complete(false); return; }
    if (state === 'alarm') {
      if (alarmAt) {
        var since = Date.now() - alarmAt;
        document.title = Math.floor(since / 900) % 2 ? baseTitle : '⏰ Time!';
        if (prefs.sound && bellsRung < 7 && since > bellsRung * 7000) { bells(2); bellsRung++; }
        if (since > 70000) alarmAt = 0;
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

  function ringSvg(frac, size, stroke) {
    var r = (size - stroke) / 2;
    var c = 2 * Math.PI * r;
    var h = size / 2;
    return '<svg class="ring focusring" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" aria-hidden="true">'
      + '<circle class="ring-bg" cx="' + h + '" cy="' + h + '" r="' + r + '" stroke-width="' + stroke + '"/>'
      + '<circle class="ring-fg" cx="' + h + '" cy="' + h + '" r="' + r + '" stroke-width="' + stroke + '" stroke-dasharray="' + c.toFixed(2)
      + '" stroke-dashoffset="' + (c * (1 - Math.min(1, frac))).toFixed(2) + '" transform="rotate(-90 ' + h + ' ' + h + ')"/></svg>';
  }

  var TARGET = +DATA.target || 7 * 3600;

  function renderToday() {
    if (!app) return;
    var day = today();
    var list = dayList(day);
    var total = sumSec(list);
    $('ftotal').textContent = dur(total);
    $('fsub').textContent = 'of ' + dur(TARGET) + ' · ' + list.length + ' block' + (list.length === 1 ? '' : 's')
      + (total >= TARGET ? ' · target met' : '');
    $('fring').innerHTML = ringSvg(total / TARGET, 76, 8);

    var mins = function (ms) { var d = new Date(ms); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
    var blocks = list.map(function (s) {
      return '<i style="left:' + (mins(s.start) / 14.4).toFixed(2) + '%;width:' + (Math.max(s.sec / 60, 4) / 14.4).toFixed(2) + '%"></i>';
    });
    if (run && (state === 'running' || state === 'paused') && dayKey(run.startedAt) === day) {
      blocks.push('<i class="live" style="left:' + (mins(run.startedAt) / 14.4).toFixed(2) + '%;width:'
        + (Math.max(elapsed() / 60, 4) / 14.4).toFixed(2) + '%"></i>');
    }
    $('ftimeline').innerHTML = blocks.join('');

    $('fsessions').innerHTML = list.length
      ? list.slice().reverse().map(function (s) {
        return '<li><span>' + hm(s.start) + ' – ' + hm(s.end) + '</span>'
          + (s.synced ? '' : '<span class="tagx">this device</span>')
          + '<span class="len">' + dur(s.sec) + '</span>'
          + '<button type="button" class="del" data-del="' + s.id + '" aria-label="Delete this block">×</button></li>';
      }).join('')
      : '<li class="none">Nothing logged yet today.</li>';
  }

  function renderWeek() {
    if (!app) return;
    var now = new Date();
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
    var unsynced = sessions.filter(function (s) { return !s.synced; }).length + gone.length;
    el.textContent = {
      local: 'Saved on this device only. Connect once under Write → ⚙ and blocks also go into the journal, so the total shows on your phone too.',
      ok: unsynced ? 'Saving to the journal…' : 'Blocks are saved to the journal as they finish.',
      offline: 'Could not reach GitHub — blocks are safe on this device and will be saved next time.',
      badtoken: 'The token was rejected — reconnect under Write → ⚙. Blocks are safe on this device.'
    }[syncState] || '';
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

  /* the Focus card on Today (and anywhere else it is dropped in) */
  function renderCard() {
    var card = document.querySelector('[data-focus-card]');
    if (!card) return;
    var list = dayList(today());
    var total = sumSec(list);
    var t = card.querySelector('[data-f-total]');
    var sub = card.querySelector('[data-f-sub]');
    var ringBox = card.querySelector('[data-f-ring]');
    var running = card.querySelector('[data-f-running]');
    if (t) t.textContent = dur(total);
    if (sub) sub.textContent = 'of ' + dur(TARGET) + ' · ' + list.length + ' block' + (list.length === 1 ? '' : 's');
    if (ringBox) ringBox.innerHTML = ringSvg(total / TARGET, 72, 7);
    if (running) {
      var live = run && run.seg && remaining() > 0;
      running.hidden = !(run && (live || !run.seg));
      running.textContent = !run ? '' : run.seg
        ? '● ' + Math.ceil(remaining() / 60) + ' min left in this block'
        : '❚❚ block paused';
    }
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
    fetchToday();
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
    } else if (e.key === LS_SESSIONS || e.key === LS_GONE) {
      sessions = load(LS_SESSIONS, []);
      gone = load(LS_GONE, []);
      renderAll();
    }
  });

  /* ---------- boot ---------- */
  if (run) {
    if (run.seg && remaining() <= 0) complete(true);     // it ended while the page was closed
    else state = run.seg ? 'running' : 'paused';
  }
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
  syncPending();
  fetchToday();
  setInterval(function () { if (document.visibilityState === 'visible') fetchToday(); }, 5 * 60 * 1000);
})();
