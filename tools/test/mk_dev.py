"""A test copy of any built page that talks to the fake GitHub (fake_gh.mjs) instead of
api.github.com -- and to its fakes of raw.githubusercontent.com and ntfy.sh.

  python tools/test/mk_dev.py <page> <out> [oldbuild]
  e.g.  python tools/test/mk_dev.py tasks/index.html _t_tasks.html
        python tools/test/mk_dev.py admin/index.html admin/_t_admin.html

Build first (npm run build -- it wipes dist/, so make the copies again after every build).
Open the copy on DIFFERENT ORIGINS to play different devices (each origin has its own
localStorage): localhost:4321, 127.0.0.1:4321, [::1]:4321. (The Claude browser pane
blocks 127.0.0.2.) "oldbuild" stamps the copy as built long ago, to test the refresh.

Query string:
  fresh=1        wipe this origin's storage first (once per tab session)
  token=0        a browser that has no token (not signed in)
  off=600000     this device's clock is that many ms fast (the site's offset check cancels it)
  vis=0          do not force visibilityState (the pane reports every tab as hidden,
                 and the site only polls when visible, so by default it is forced)
  ua=iphone      pretend to be an iPhone
Window helpers: __off (mutable clock error, ms), __calls (every faked call made here),
__vis('hidden'|'visible').
"""
import pathlib
import re
import sys

SITE = pathlib.Path(__file__).resolve().parents[2]
page, out = sys.argv[1], sys.argv[2]
src = (SITE / "dist" / page).read_text(encoding="utf-8")

STUB = r"""<script>
(function () {
  var q = new URLSearchParams(location.search);
  var Real = Date;
  window.__off = +q.get('off') || 0;
  function Fake() {
    var a = [].slice.call(arguments);
    if (!a.length) return new Real(Real.now() + window.__off);
    return new (Function.prototype.bind.apply(Real, [null].concat(a)))();
  }
  Fake.prototype = Real.prototype; Fake.now = function () { return Real.now() + window.__off; };
  Fake.UTC = Real.UTC; Fake.parse = Real.parse; window.Date = Fake;

  if (q.get('fresh') && !sessionStorage.getItem('t_init')) {
    localStorage.clear();
    sessionStorage.setItem('t_init', '1');
  }
  if (q.get('token') === '0') localStorage.removeItem('gh_token');
  else if (!localStorage.getItem('gh_token')) localStorage.setItem('gh_token', 'FAKE-TOKEN-FOR-TEST');

  /* the browser pane reports every tab as hidden; the site only polls when visible */
  if (q.get('vis') !== '0') {
    var vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: function () { return vis; }, configurable: true });
    Object.defineProperty(document, 'hidden', { get: function () { return vis !== 'visible'; }, configurable: true });
    window.__vis = function (v) { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
  }

  if (q.get('ua') === 'iphone') Object.defineProperty(navigator, 'userAgent', { get: function () { return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'; } });

  window.__calls = [];
  var real = window.fetch;
  window.fetch = function (url, opts) {
    url = String(url);
    /* the fakes sit on the same host as the page: the browser pane blocks some cross-host requests */
    if (url.indexOf('https://api.github.com/') === 0) {
      var u = 'http://' + location.hostname + ':4400/' + url.slice('https://api.github.com/'.length);
      window.__calls.push(((opts && opts.method) || 'GET') + ' ' + url.replace('https://api.github.com', ''));
      return real.call(window, u, opts);
    }
    if (url.indexOf('https://raw.githubusercontent.com/') === 0) {
      var rw = 'http://' + location.hostname + ':4400/raw/' + url.slice('https://raw.githubusercontent.com/'.length);
      window.__calls.push('GET raw/' + url.slice('https://raw.githubusercontent.com/'.length).split('?')[0]);
      return real.call(window, rw, opts);
    }
    if (url.indexOf('https://ntfy.sh') === 0) {
      var n = 'http://' + location.hostname + ':4400/ntfy' + url.slice('https://ntfy.sh'.length);
      window.__calls.push(((opts && opts.method) || 'GET') + ' ntfy' + url.slice('https://ntfy.sh'.length));
      return real.call(window, n, opts);
    }
    return real.apply(window, arguments);
  };
})();
</script>"""

html = src.replace("<head>", "<head>\n" + STUB, 1)
if len(sys.argv) > 3 and sys.argv[3] == "oldbuild":
    html = re.sub(r'(<meta name="built" content=")[^"]+', r'\g<1>2000-01-01T00:00:00.000Z', html)
(SITE / "dist" / out).write_text(html, encoding="utf-8")
print("wrote dist/" + out)
