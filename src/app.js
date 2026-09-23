/* Theme toggle, ticking tasks off from any page, and search. No dependencies,
   no build step. The focus timer lives in its own file (focus.js). */
(function () {
  'use strict';

  var $$ = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };
  var norm = function (s) { return String(s || '').trim().toLowerCase(); };

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

  /* ---------- toast ---------- */
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(text, kind, ms) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.className = 'toast show' + (kind === 'err' ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast' + (kind === 'err' ? ' err' : ''); }, ms || 2200);
  }
  window.journalToast = toast;

  /* ---------- tappable tasks ----------
     The site and /admin/ share an origin, so a token pasted into the editor is
     readable here too. If one exists this is the owner on their own device, and
     ticking a box rewrites the markdown in the repo. Everyone else gets the
     checkboxes exactly as the HTML ships them: disabled.

     Every box carries its task's TEXT (data-task), and the write finds the
     line by that text rather than by position -- so a box still hits the right
     line after the page was edited somewhere else. */
  (function () {
    var controls = $$('input[type="checkbox"][data-task], button.cell[data-task]');
    if (!controls.length) return;

    var token;
    try { token = localStorage.getItem('gh_token'); } catch (e) { token = null; }
    if (!token) return;

    var cfgPromise = null;
    var chain = Promise.resolve();   // one write at a time; each refetches the sha

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
            throw new Error(m);
          }
          return data;
        });
      });
    }

    var TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)\r?$/;

    function writeTask(path, task, checked) {
      return config().then(function (c) {
        var base = 'https://api.github.com/repos/' + c.repo + '/contents/' + path;
        return gh('GET', base + '?ref=' + c.branch).then(function (file) {
          var lines = b64decode(file.content).split('\n');
          for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(TASK_LINE);
            if (!m || norm(m[4]) !== norm(task)) continue;
            if ((m[2] !== ' ') === checked) return null;          // already that way
            lines[i] = lines[i].replace(TASK_LINE, function (_all, a, _s, b, rest) {
              return a + (checked ? 'x' : ' ') + b + rest;
            });
            return gh('PUT', base, {
              message: (checked ? 'done: ' : 'undone: ') + task.slice(0, 60),
              content: b64encode(lines.join('\n')),
              branch: c.branch,
              sha: file.sha
            });
          }
          throw new Error('"' + task + '" is not on that page any more — reload.');
        });
      });
    }

    function fileOf(el) {
      if (el.dataset.file) return el.dataset.file;
      var block = el.closest('[data-file]');
      return block ? block.dataset.file : '';
    }
    var isOn = function (el) { return el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-pressed') === 'true'; };
    function setOn(el, on) {
      if (el.tagName === 'INPUT') el.checked = on;
      else el.setAttribute('aria-pressed', String(on));
    }
    /* the same task can be on screen twice (Today's card and the week grid) */
    function twins(file, task) {
      return controls.filter(function (el) { return fileOf(el) === file && norm(el.dataset.task) === norm(task); });
    }
    function recount(file) {
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
    }

    controls.forEach(function (el) {
      var file = fileOf(el);
      if (!file) return;
      el.disabled = false;
      el.addEventListener(el.tagName === 'INPUT' ? 'change' : 'click', function () {
        var next = el.tagName === 'INPUT' ? el.checked : !isOn(el);
        var group = twins(file, el.dataset.task);
        group.forEach(function (g) { setOn(g, next); g.disabled = true; });
        recount(file);
        toast('Saving…');
        chain = chain.then(function () {
          return writeTask(file, el.dataset.task, next)
            .then(function () { toast(next ? 'Ticked · live in a minute' : 'Unticked · live in a minute'); })
            .catch(function (err) {
              group.forEach(function (g) { setOn(g, !next); });   // put it back the way it was
              recount(file);
              toast(err.message, 'err', 5000);
            })
            .then(function () { group.forEach(function (g) { g.disabled = false; }); });
        });
      });
    });
  })();

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
    if (i < 0) return esc(text.slice(0, 200)) + '…';
    var start = Math.max(0, i - 70);
    var slice = text.slice(start, i + term.length + 130);
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
    out.innerHTML = hits.slice(0, 40).map(function (h) {
      var p = h.p;
      var head = p.t
        ? '<h3 class="etitle"><a href="' + p.u + '">' + esc(p.t) + '</a></h3>'
        : '<h3 class="etitle untitled"><a href="' + p.u + '">' + esc(p.x.slice(0, 90)) + '</a></h3>';
      return '<article class="entry">'
        + '<div class="emeta">'
        + (p.s ? '<span class="chip sec-' + esc(p.i || '') + '">' + esc(p.s) + '</span>' : '')
        + '<a class="when" href="' + p.u + '">' + esc(p.d) + '</a></div>'
        + head
        + '<p class="ex">' + snippet(p.x, terms[0]) + '</p>'
        + (p.g.length ? '<div class="tags">' + p.g.map(function (t) {
            return '<a class="tag" href="/tags/' + esc(t) + '/">#' + esc(t) + '</a>';
          }).join('') + '</div>' : '')
        + '</article>';
    }).join('');
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
