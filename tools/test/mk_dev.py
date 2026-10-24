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

  /* a fake microphone for the Speak page (a tone from WebAudio, a real MediaStream):
       mic=tone       a tone, so the level bar moves and the recording has sound
       mic=silent     a microphone that hears nothing
       mic=deny       the browser refuses (NotAllowedError)
       mic=none       there is no microphone (NotFoundError)
       mic=busy       another app has it (NotReadableError)
       lostms=3000    the microphone is unplugged this long after it was opened
       devices=2      two microphones to choose from */
  if (q.get('mic') && navigator.mediaDevices) {
    var micMode = q.get('mic');
    window.__gum = 0;
    navigator.mediaDevices.getUserMedia = function (c) {
      window.__gum++;
      window.__lastConstraints = c;
      if (micMode === 'deny') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
      if (micMode === 'none') return Promise.reject(new DOMException('none', 'NotFoundError'));
      if (micMode === 'busy') return Promise.reject(new DOMException('busy', 'NotReadableError'));
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var dst = ctx.createMediaStreamDestination();
      var o = ctx.createOscillator(), g = ctx.createGain();
      g.gain.value = micMode === 'silent' ? 0 : 0.3;
      o.frequency.value = 220; o.connect(g); g.connect(dst); o.start();
      var tr = dst.stream.getAudioTracks()[0];
      if (+q.get('lostms')) setTimeout(function () { try { tr.stop(); } catch (e) {} if (tr.onended) tr.onended(); }, +q.get('lostms'));
      window.__fakeTrack = tr;
      return Promise.resolve(dst.stream);
    };
    if (+q.get('devices') > 1) navigator.mediaDevices.enumerateDevices = function () {
      return Promise.resolve([{ kind: 'audioinput', deviceId: 'mic-a', label: 'Fake mic A' }, { kind: 'audioinput', deviceId: 'mic-b', label: 'Fake mic B' }]);
    };
  }

  /* a fake dictation engine, for the Write page's Talk button:
       sr=desktop   each result event carries only the NEW result (resultIndex says which)
       sr=android   what Android Chrome does: every event resends the WHOLE list of results, resultIndex stays 0
     it "hears" three phrases 200 ms apart ("hello", "how are you", "fine thanks"), then the browser ends the listen */
  if (q.get('sr') === 'desktop' || q.get('sr') === 'android') {
    var droid = q.get('sr') === 'android';
    var FakeSR = function () { this.continuous = false; this.interimResults = false; this.lang = ''; };
    FakeSR.prototype.start = function () {
      var self = this, phrases = ['hello', 'how are you', 'fine thanks'], list = [], i = 0;
      window.__srStarts = (window.__srStarts || 0) + 1;
      setTimeout(function () { self.onstart && self.onstart(); }, 10);
      this._t = setInterval(function () {
        if (i < phrases.length) {
          var r = [{ transcript: ' ' + phrases[i] }]; r.isFinal = true; list.push(r);
          self.onresult && self.onresult({ resultIndex: droid ? 0 : i, results: list.slice() });
          i++;
        } else { clearInterval(self._t); setTimeout(function () { self.onend && self.onend(); }, 150); }
      }, 200);
    };
    FakeSR.prototype.stop = function () { clearInterval(this._t); var s = this; setTimeout(function () { s.onend && s.onend(); }, 10); };
    FakeSR.prototype.abort = FakeSR.prototype.stop;
    window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  }

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
