/* Site-wide script: theme, "is this page stale?", the home page's day rollover,
   ticking tasks off from any page, and search. No dependencies, no build step.
   The focus timer lives in its own file (focus.js).

   The site is static HTML built at deploy time. That is fine for reading, but
   three things it cannot do on its own, and this file does for it:
     1. notice it is old   -- a page opened from cache, or a phone resumed after a
                              night asleep, is still showing the build it came from;
     2. turn the day over  -- the home page ships a panel for today AND tomorrow
                              and shows the one that matches the device's date;
     3. make the day's file -- if the nightly job has not, the browser holding the
                              token creates it. */
(function () {
  'use strict';

  var $$ = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };
  var norm = function (s) { return String(s || '').trim().toLowerCase(); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var meta = function (name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return m ? m.content : '';
  };

  /* the device's own calendar date -- what "today" means to the person holding it */
  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayBefore(key) {
    var d = new Date(key + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  var BUILT = meta('built');

  /* ---------- theme ---------- */
  var btn = document.getElementById('themetoggle');
  if (btn) {
    btn.addEventListener('click', function () {
      var root = document.documentElement;
      var systemDark = !window.matchMedia('(prefers-color-scheme: light)').matches;
      var current = root.dataset.theme || (systemDark ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
    });
  }

  /* ---------- toast ----------
     target: a string turns the toast into a link; a function makes it a button */
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(text, kind, ms, target) {
    if (!toastEl) return;
    toastEl.innerHTML = '';
    if (target) {
      var a = document.createElement('a');
      a.textContent = text;
      if (typeof target === 'function') {
        a.href = '#';
        a.addEventListener('click', function (e) { e.preventDefault(); target(); });
      } else {
        a.href = target;
      }
      toastEl.appendChild(a);
    } else {
      toastEl.textContent = text;
    }
    toastEl.className = 'toast show' + (kind === 'err' ? ' err' : '') + (target ? ' act' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, ms || 2200);
  }
  window.journalToast = toast;

  /* ---------- is this page stale? ----------
     GitHub Pages lets a browser keep a page for ten minutes, a deploy takes a
     minute or two after a post or a tick, and a phone app resumed from the
     background does not reload at all. So the page asks, now and then, whether a
     newer build exists (build.json is tiny and never cached) and, if so and the
     person is not in the middle of something, simply reloads. */
  var lastFresh = 0;
  var lastTouch = 0;        // 0 = not touched yet: a page that has only just loaded may reload at once
  ['pointerdown', 'keydown', 'input', 'change'].forEach(function (ev) {
    document.addEventListener(ev, function () { lastTouch = Date.now(); }, true);
  });

  function busy() {
    if (Date.now() - lastTouch < 20000) return true;           // touched it a moment ago
    try {
      /* never pull the page out from under a running focus block */
      if (document.body.classList.contains('focuspage') && localStorage.getItem('focus_running_v1')) return true;
    } catch (e) {}
    return false;
  }

  function refreshNow() {
    var last = 0;
    try { last = +sessionStorage.getItem('fresh_at') || 0; } catch (e) {}
    if (Date.now() - last < 25000) return;                      // never loop
    try { sessionStorage.setItem('fresh_at', String(Date.now())); } catch (e) {}
    var go = function () { location.reload(); };
    /* cache:'reload' refreshes the browser's copy of this page first, so the
       reload that follows cannot be answered from the stale one */
    fetch(location.href, { cache: 'reload' }).then(go, go);
  }

  function freshCheck(force) {
    if (!BUILT) return;
    var now = Date.now();
    if (!force && now - lastFresh < 15000) return;
    lastFresh = now;
    fetch('/build.json?t=' + now, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.built || j.built <= BUILT) return;
        if (busy()) toast('A newer version is ready — tap to refresh', '', 12000, refreshNow);
        else refreshNow();
      })
      .catch(function () { /* offline: what is on screen stands */ });
  }

  /* ---------- the day turns over ---------- */
  var panels = $$('.daypanel');
  var shownPanel = null;

  /* Today / Yesterday / the "today" highlight, worked out from the device's date.
     Anything inside a home-page panel is already right for its panel's date. */
  function relabel() {
    var t = localToday();
    var y = dayBefore(t);
    $$('[data-day]').forEach(function (el) {
      if (el.closest('.daypanel')) return;
      var d = el.dataset.day;
      var c = el.classList;
      if (c.contains('hg-d')) {
        c.toggle('today', d === t);
      } else if (c.contains('fcell')) {
        c.toggle('now', d === t);
      } else if (c.contains('cell')) {
        c.toggle('future', d > t);
        if (el.tagName === 'SPAN') c.toggle('none', d <= t);
        else { c.toggle('now', d === t); c.toggle('past', d < t); }
      } else if (c.contains('dghead')) {
        var rel = d === t ? 'Today' : d === y ? 'Yesterday' : '';
        var b = el.querySelector('b');
        if (rel) {
          if (!b) { b = document.createElement('b'); el.insertBefore(b, el.firstChild); }
          b.textContent = rel;
        } else if (b) {
          b.remove();
        }
      }
    });
  }

  function showPanel() {
    if (!panels.length) return;
    var t = localToday();
    var hit = panels.filter(function (p) { return p.dataset.date === t; })[0];
    if (!hit) {
      hit = panels[0];
      /* the device is past everything that was built in: a build from days ago */
      if (t > panels[panels.length - 1].dataset.date) freshCheck(true);
    }
    if (hit === shownPanel) return;
    var turned = shownPanel !== null;          // false on the first call: the page just loaded
    panels.forEach(function (p) { p.hidden = (p !== hit); });
    shownPanel = hit;
    document.documentElement.dataset.today = hit.dataset.date;
    if (turned) {
      /* the new day's numbers: focus total, and the live state of its habit page */
      if (window.__focusRender) window.__focusRender();
      if (window.__ticksSync) window.__ticksSync(true);
    }
  }

  /* ---------- tappable tasks ----------
     The site and /admin/ share an origin, so a token pasted into the editor is
     readable here too. If one exists this is the owner, and ticking a box
     rewrites the markdown in the repo.

     The pages are static, so the HTML is often older than the truth. Two things
     close that gap, for the owner only:
       1. every page with ticks asks the GitHub API for the live files and
          shows what they actually say, whatever the HTML was built with;
       2. every tick is also remembered here for a while, so it shows at once
          on the next page even before that answer comes back.

     Every box carries its task's TEXT (data-task), and a write finds the line
     by that text rather than by position. */
  (function () {
    var controls = $$('input[type="checkbox"][data-task], button.cell[data-task]');

    var token;
    try { token = localStorage.getItem('gh_token'); } catch (e) { token = null; }

    function fileOf(el) {
      if (el.dataset.file) return el.dataset.file;
      var block = el.closest('[data-file]');
      return block ? block.dataset.file : '';
    }

    /* a day that has not started cannot be ticked early */
    function tooEarly(el) {
      return el.tagName === 'BUTTON' && el.classList.contains('future');
    }

    /* Not connected in this browser. Say so, rather than doing nothing: a box
       that silently refuses to tick looks exactly like a broken site. On an
       iPhone every Home Screen app keeps its own storage, so the Write app
       being connected does not connect the Journal app. */
    if (!token) {
      controls.forEach(function (el) {
        if (!fileOf(el)) return;
        el.disabled = false;
        el.classList.add('locked');
        el.addEventListener('click', function (e) {
          e.preventDefault();
          if (tooEarly(el)) { toast('That day has not started yet'); return; }
          toast('This browser isn’t connected — tap to connect it once', 'err', 5000, '/admin/#setup');
        });
      });
      window.__ticksSync = function () {};
      return;
    }

    var cfgPromise = null;
    var chain = Promise.resolve();   // one write at a time; each refetches the sha
    var inflight = {};               // "file\ntask" -> true while a write is on its way
    var known = {};                  // file -> { task: done } as the repo last said
    var ensuring = {};               // file -> promise while its page is being made
    var OVR = 'tick_overrides_v1';
    var OVR_TTL = 30 * 60 * 1000;

    function config() {
      if (!cfgPromise) {
        cfgPromise = fetch('/admin/config.json').then(function (r) { return r.json(); });
      }
      return cfgPromise;
    }
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
    function gh(method, url, body) {
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
            var m = (data && data.message) || ('HTTP ' + r.status);
            if (r.status === 401) m = 'Token rejected — reconnect under Write → ⚙.';
            var err = new Error(m);
            err.status = r.status;
            throw err;
          }
          return data;
        });
      });
    }
    function contentsUrl(c, path) {
      return 'https://api.github.com/repos/' + c.repo + '/contents/' + path;
    }

    var TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)\r?$/;

    function parseTasks(text) {
      var state = {};
      text.split('\n').forEach(function (line) {
        var m = line.match(TASK_LINE);
        if (m) state[norm(m[4])] = m[2] !== ' ';
      });
      return state;
    }

    /* ---- making a day's file when the nightly job has not ----
       The card carries the very text the job would have written (data-seed). If
       the file is not in the repo, put it there. A file that appeared in the
       meantime (the job, or another device) is fine -- 422 means "already there". */
    function niceName(file) {
      var m = file.match(/(\d{4}-\d{2}-\d{2})-\d{4}-(day|week)\.md$/);
      if (!m) return file;
      var d = new Date(m[1] + 'T12:00:00');
      var s = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      return m[2] === 'week' ? 'weektasks: week of ' + s : 'daytasks: ' + s;
    }
    function ensureFile(file, seed) {
      if (ensuring[file]) return ensuring[file];
      ensuring[file] = config().then(function (c) {
        return gh('GET', contentsUrl(c, file) + '?ref=' + c.branch).then(function () {
          return 'exists';
        }, function (err) {
          if (err.status !== 404) throw err;
          return gh('PUT', contentsUrl(c, file), {
            message: niceName(file), content: b64encode(seed), branch: c.branch
          }).then(function () { return 'created'; }, function (e2) {
            if (e2.status === 422 || e2.status === 409) return 'exists';
            throw e2;
          });
        });
      }).then(function (what) {
        delete ensuring[file];
        return what;
      }, function () {
        delete ensuring[file];       // offline or refused: the card still works from its seed
        return 'failed';
      });
      return ensuring[file];
    }
    function ensureSeeded() {
      $$('[data-seed]').forEach(function (card) {
        var file = card.dataset.file;
        if (!file || !card.dataset.seed) return;
        ensureFile(file, card.dataset.seed).then(function (what) {
          if (what === 'created') {
            card.removeAttribute('data-seed');
            if (!card.closest('[hidden]')) toast('Made the page for this day ✓');
          } else if (what === 'exists') {
            card.removeAttribute('data-seed');
          }
        });
      });
    }

    function writeTask(path, task, checked, tries) {
      if (tries == null) tries = 2;
      /* a tick on a page that is still being made waits for it */
      return Promise.resolve(ensuring[path]).then(config).then(function (c) {
        return gh('GET', contentsUrl(c, path) + '?ref=' + c.branch).then(function (file) {
          var lines = b64decode(file.content).split('\n');
          for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(TASK_LINE);
            if (!m || norm(m[4]) !== norm(task)) continue;
            if ((m[2] !== ' ') === checked) return null;          // already that way
            lines[i] = lines[i].replace(TASK_LINE, function (_all, a, _s, b, rest) {
              return a + (checked ? 'x' : ' ') + b + rest;
            });
            return gh('PUT', contentsUrl(c, path), {
              message: (checked ? 'done: ' : 'undone: ') + task.slice(0, 60),
              content: b64encode(lines.join('\n')),
              branch: c.branch,
              sha: file.sha
            }).then(function () { known[path] = parseTasks(lines.join('\n')); });
          }
          throw new Error('"' + task + '" is not on that page any more — reload.');
        });
      }).catch(function (err) {
        /* someone else wrote the file between our read and our write */
        if (err.status === 409 && tries > 0) return writeTask(path, task, checked, tries - 1);
        throw err;
      });
    }

    var isOn = function (el) { return el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-pressed') === 'true'; };
    function setOn(el, on) {
      if (el.tagName === 'INPUT') el.checked = on;
      else el.setAttribute('aria-pressed', String(on));
    }
    var keyOf = function (file, task) { return file + '\n' + norm(task); };
    /* the same task can be on screen twice (Today's card and the week grid) */
    function twins(file, task) {
      return controls.filter(function (el) { return fileOf(el) === file && norm(el.dataset.task) === norm(task); });
    }

    /* everything on the page that is derived from ticks, recomputed */
    function refresh(file) {
      $$('[data-file]').forEach(function (block) {
        if (block.dataset.file !== file) return;
        var boxes = $$('input[type="checkbox"][data-task]', block);
        if (!boxes.length) return;
        var done = boxes.filter(function (b) { return b.checked; }).length;
        var count = block.querySelector('[data-count]');
        var bar = block.querySelector('[data-bar]');
        if (count) count.textContent = done + ' / ' + boxes.length;
        if (bar) bar.style.width = Math.round((done / boxes.length) * 100) + '%';
      });
      /* the week strip's ring for that day */
      var state = known[file];
      $$('[data-ring]').forEach(function (a) {
        if (a.dataset.ring !== file || !state) return;
        var names = Object.keys(state);
        var done = names.filter(function (n) { return state[n]; }).length;
        var fg = a.querySelector('.ring-fg');
        if (fg && names.length) {
          var c = parseFloat(fg.getAttribute('stroke-dasharray'));
          fg.setAttribute('stroke-dashoffset', (c * (1 - done / names.length)).toFixed(2));
        }
        a.classList.toggle('full', names.length > 0 && done === names.length);
      });
      /* the habit grid's weekly totals */
      $$('.hg-row').forEach(function (row) {
        var sum = row.querySelector('.hg-sum[data-target]');
        if (!sum) return;
        var n = $$('button.cell[aria-pressed="true"]', row).length;
        var target = +sum.dataset.target;
        sum.innerHTML = '<b class="' + (target && n >= target ? 'met' : '') + '">' + n + (target ? '/' + target : '') + '</b>';
      });
    }

    /* ---- remembered ticks ---- */
    function loadOvr() {
      try { return JSON.parse(localStorage.getItem(OVR) || '{}') || {}; } catch (e) { return {}; }
    }
    function saveOvr(o) { try { localStorage.setItem(OVR, JSON.stringify(o)); } catch (e) {} }
    function remember(file, task, on) {
      var o = loadOvr();
      o[keyOf(file, task)] = { on: on, at: Date.now() };
      saveOvr(o);
    }
    (function applyOvr() {
      var o = loadOvr();
      var now = Date.now();
      var touched = {};
      Object.keys(o).forEach(function (k) {
        if (now - o[k].at > OVR_TTL) { delete o[k]; return; }
        var parts = k.split('\n');
        twins(parts[0], parts[1]).forEach(function (el) { setOn(el, o[k].on); touched[parts[0]] = 1; });
      });
      saveOvr(o);
      Object.keys(touched).forEach(refresh);
    })();

    /* ---- the live files ---- */
    function syncFile(file) {
      return config().then(function (c) {
        return gh('GET', contentsUrl(c, file) + '?ref=' + c.branch);
      }).then(function (f) {
        var state = parseTasks(b64decode(f.content));
        known[file] = state;
        var changed = false;
        controls.forEach(function (el) {
          if (fileOf(el) !== file || inflight[keyOf(file, el.dataset.task)]) return;
          var v = state[norm(el.dataset.task)];
          if (v === undefined || v === isOn(el)) return;
          setOn(el, v);
          changed = true;
        });
        /* the repo now answers for this file; its remembered ticks are done */
        var o = loadOvr();
        Object.keys(o).forEach(function (k) {
          if (k.split('\n')[0] === file && !inflight[k]) delete o[k];
        });
        saveOvr(o);
        refresh(file);
        return changed;
      }).catch(function () { /* offline, or no such file yet: what is on screen stands */ });
    }

    var lastSync = 0;
    function syncAll(force) {
      var now = Date.now();
      if (!force && now - lastSync < 20000) return;
      lastSync = now;
      var files = {};
      controls.forEach(function (el) { var f = fileOf(el); if (f) files[f] = 1; });
      $$('[data-ring]').forEach(function (a) { files[a.dataset.ring] = 1; });
      /* a page that is about to be made is made first; its GET would only 404 */
      $$('[data-seed]').forEach(function (card) { delete files[card.dataset.file]; });
      Object.keys(files).forEach(syncFile);
      ensureSeeded();
    }
    window.__ticksSync = syncAll;

    controls.forEach(function (el) {
      var file = fileOf(el);
      if (!file) return;
      el.disabled = false;
      el.addEventListener(el.tagName === 'INPUT' ? 'change' : 'click', function (ev) {
        if (tooEarly(el)) {
          if (ev) ev.preventDefault();
          toast('That day has not started yet');
          return;
        }
        var task = el.dataset.task;
        var next = el.tagName === 'INPUT' ? el.checked : !isOn(el);
        var k = keyOf(file, task);
        var group = twins(file, task);
        group.forEach(function (g) { setOn(g, next); g.disabled = true; });
        if (known[file]) known[file][norm(task)] = next;
        inflight[k] = true;
        remember(file, task, next);
        refresh(file);
        toast('Saving…');
        chain = chain.then(function () {
          return writeTask(file, task, next)
            .then(function () { toast(next ? 'Ticked ✓' : 'Unticked'); })
            .catch(function (err) {
              group.forEach(function (g) { setOn(g, !next); });   // put it back the way it was
              if (known[file]) known[file][norm(task)] = !next;
              remember(file, task, !next);
              refresh(file);
              toast(err.message, 'err', 5000);
            })
            .then(function () {
              delete inflight[k];
              group.forEach(function (g) { g.disabled = false; });
            });
        });
      });
    });

    syncAll(true);
  })();

  /* ---------- wire it all together ---------- */
  function onWake() {
    showPanel();
    relabel();
    freshCheck();
    if (window.__ticksSync) window.__ticksSync();
  }
  showPanel();
  relabel();
  setTimeout(freshCheck, 900);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') onWake();
  });
  /* a page restored from the back/forward cache never reloads, so it never runs
     any of the above on its own */
  window.addEventListener('pageshow', function (e) { if (e.persisted) onWake(); });
  window.addEventListener('online', function () { freshCheck(true); });
  /* a tab left open across midnight turns over without anyone touching it */
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    showPanel();
    relabel();
  }, 30000);

  /* ---------- search ---------- */
  var q = document.getElementById('q');
  var out = document.getElementById('results');
  if (!q || !out) return;

  var index = null;
  var pending = null;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* Show the matched phrase in context rather than the post's opening line --
     when you are hunting a half-remembered thought, the hit IS the answer. */
  function snippet(text, term) {
    var i = text.toLowerCase().indexOf(term);
    if (i < 0) return esc(text.slice(0, 140)) + '…';
    var start = Math.max(0, i - 50);
    var slice = text.slice(start, i + term.length + 90);
    return (start > 0 ? '…' : '')
      + esc(slice.slice(0, i - start))
      + '<mark>' + esc(slice.slice(i - start, i - start + term.length)) + '</mark>'
      + esc(slice.slice(i - start + term.length)) + '…';
  }

  function score(p, terms) {
    var title = (p.t || '').toLowerCase();
    var text = p.x.toLowerCase();
    var tags = p.g.join(' ').toLowerCase();
    var section = (p.s || '').toLowerCase();
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var hit = 0;
      if (title.indexOf(t) >= 0) hit += 10;
      if (section.indexOf(t) >= 0) hit += 8; // "mistakes june" should work
      if (tags.indexOf(t) >= 0) hit += 6;
      if (text.indexOf(t) >= 0) hit += 2;
      if (!hit) return 0; // every term must appear somewhere
      total += hit;
    }
    return total;
  }

  function render(terms) {
    if (!terms.length) { out.innerHTML = ''; return; }
    var hits = [];
    for (var i = 0; i < index.length; i++) {
      var s = score(index[i], terms);
      if (s) hits.push({ p: index[i], s: s });
    }
    hits.sort(function (a, b) { return b.s - a.s; });

    if (!hits.length) {
      out.innerHTML = '<p class="muted">Nothing mentions that.</p>';
      return;
    }
    out.innerHTML = '<div class="rows">' + hits.slice(0, 40).map(function (h) {
      var p = h.p;
      return '<a class="erow sec-' + esc(p.i || '') + '" href="' + p.u + '">'
        + '<span class="edot"></span><span class="ebody">'
        + '<span class="ename' + (p.t ? '' : ' untitled') + '">' + esc(p.t || p.x.slice(0, 80)) + '</span>'
        + '<span class="emeta2"><b>' + esc(p.s) + '</b> · ' + esc(p.d) + '</span>'
        + '<span class="eline">' + snippet(p.x, terms[0]) + '</span>'
        + '</span></a>';
    }).join('') + '</div>';
  }

  function run() {
    var terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!index) { pending = terms; return; }
    render(terms);
  }

  fetch('/search.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      index = data;
      if (pending) { render(pending); pending = null; }
    })
    .catch(function () {
      out.innerHTML = '<p class="muted">Could not load the search index.</p>';
    });

  var timer;
  q.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 90);
  });

  /* deep-link: /search/?q=vol */
  var fromUrl = new URLSearchParams(location.search).get('q');
  if (fromUrl) { q.value = fromUrl; run(); }
})();
