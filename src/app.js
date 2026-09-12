/* Theme toggle + client-side search. No dependencies, no build step. */
(function () {
  'use strict';

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

  /* ---------- tappable task lists ----------
     The site and /admin/ share an origin, so a token pasted into the editor is
     readable here too. If one exists this is the owner on their own device, and
     ticking a box rewrites the markdown in the repo. Everyone else gets the
     checkboxes exactly as marked renders them: disabled. */
  (function () {
    var article = document.querySelector('.post[data-file]');
    if (!article) return;

    var boxes = [].slice.call(article.querySelectorAll('.prose input[type="checkbox"]'));
    if (!boxes.length) return;

    var token;
    try { token = localStorage.getItem('gh_token'); } catch (e) { token = null; }
    if (!token) return;

    var path = article.dataset.file;
    var cfg = null;
    var chain = Promise.resolve();   // one write at a time; each refetches the sha
    var status = document.createElement('div');
    status.className = 'tasksave';
    var progress = article.querySelector('.progress');
    (progress || article).insertAdjacentElement(progress ? 'afterend' : 'afterbegin', status);

    function say(text, kind) {
      status.textContent = text || '';
      status.className = 'tasksave' + (kind ? ' ' + kind : '');
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
          if (!r.ok) throw new Error((data && data.message) || ('HTTP ' + r.status));
          return data;
        });
      });
    }

    function config() {
      if (cfg) return Promise.resolve(cfg);
      return fetch('/admin/config.json').then(function (r) { return r.json(); })
        .then(function (c) { cfg = c; return c; });
    }

    function refreshProgress() {
      if (!progress) return;
      var done = boxes.filter(function (b) { return b.checked; }).length;
      var pct = Math.round((done / boxes.length) * 100);
      progress.innerHTML = done + ' of ' + boxes.length + ' done'
        + '<span class="bar"><i style="width:' + pct + '%"></i></span>' + pct + '%';
    }

    var TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\])/;

    function writeToggle(index, checked) {
      return config().then(function (c) {
        var base = 'https://api.github.com/repos/' + c.repo + '/contents/' + path;
        return gh('GET', base + '?ref=' + c.branch).then(function (file) {
          var lines = b64decode(file.content).split('\n');
          var seen = -1;
          for (var i = 0; i < lines.length; i++) {
            if (!TASK_LINE.test(lines[i])) continue;
            seen++;
            if (seen !== index) continue;
            lines[i] = lines[i].replace(TASK_LINE, function (m, a, _s, b) {
              return a + (checked ? 'x' : ' ') + b;
            });
            return gh('PUT', base, {
              message: (checked ? 'done: ' : 'undone: ')
                + lines[i].replace(TASK_LINE, '').trim().slice(0, 60),
              content: b64encode(lines.join('\n')),
              branch: c.branch,
              sha: file.sha
            });
          }
          throw new Error('That task is no longer in the file — reload the page.');
        });
      });
    }

    boxes.forEach(function (box, index) {
      box.disabled = false;
      box.style.cursor = 'pointer';
      box.addEventListener('change', function () {
        var checked = box.checked;
        box.disabled = true;
        refreshProgress();
        say('saving…');
        chain = chain.then(function () {
          return writeToggle(index, checked)
            .then(function () { say('saved · live in a minute', 'ok'); })
            .catch(function (err) {
              box.checked = !checked;          // put it back the way it was
              refreshProgress();
              say(err.message, 'err');
            })
            .then(function () { box.disabled = false; });
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
      out.innerHTML = '<p class="empty">No post mentions that.</p>';
      return;
    }
    out.innerHTML = hits.slice(0, 40).map(function (h) {
      var p = h.p;
      var head = p.t
        ? '<h2 class="pt"><a href="' + p.u + '">' + esc(p.t) + '</a></h2>'
        : '<h2 class="pt untitled"><a href="' + p.u + '">' + esc(p.x.slice(0, 80)) + '</a></h2>';
      return '<article class="card">'
        + '<div class="meta">'
        + (p.s ? '<span class="secref">' + esc(p.s) + '</span> <span class="sep">·</span> ' : '')
        + '<a href="' + p.u + '">' + esc(p.d) + '</a></div>'
        + head
        + '<p class="ex">' + snippet(p.x, terms[0]) + '</p>'
        + (p.g.length ? '<div class="tags">' + p.g.map(function (t) {
            return '<a class="tag" href="/tags/' + esc(t) + '/">' + esc(t) + '</a>';
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
      out.innerHTML = '<p class="empty">Could not load the search index.</p>';
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
