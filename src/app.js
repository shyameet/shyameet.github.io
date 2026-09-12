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
