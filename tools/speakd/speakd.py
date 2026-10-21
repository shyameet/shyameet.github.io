#!/usr/bin/env python3
"""speakd - the Speak page's helper. It runs on the owner's PC and nothing leaves it.

The Speak page (https://shyameet.github.io/speak/) records the microphone and sends each
take here, to http://127.0.0.1:4777. This helper

  * keeps the audio and the take on disk, in a private folder (default
    C:\\Users\\shyam\\SpeechJournal, or $SPEAK_DATA),
  * turns the audio into words with Whisper (faster-whisper, on the CPU), with a time for
    every word, so "um", "uh" and pauses are kept rather than cleaned away,
  * serves the takes back to the page, and the coaching notes written for them,
  * and serves the site's own pages (a copy fetched from the site, cached for when there is no
    internet), so the Speak page can be opened at http://localhost:4777/speak/ -- the same address
    as the helper, which no browser rule about web pages reaching local programs can get in the way of.

Layout of the data folder:
  audio/YYYY-MM-DD/<take id>_<part>.webm   the recording (a take can have more than one part)
  takes/YYYY-MM-DD.json                    {"v": 1, "takes": [...]}  the transcript lives here
  coaching/YYYY-MM-DD.md                   the advice written for that day (by Claude)
  speakd.log

Nothing here is published: this file is only code. Only pages from the site (or from a
local test server) may talk to it, and only on the loopback address.

    python speakd.py [--port 4777] [--data DIR] [--model DIR] [--fake]

--fake replaces Whisper with a stand-in that returns scripted words (for the tests).
"""
import argparse
import hashlib
import json
import mimetypes
import os
import queue
import re
import sys
import threading
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

VERSION = 2
UPSTREAM = 'https://shyameet.github.io'
ALLOWED_ORIGINS = {
    'https://shyameet.github.io',
    'http://localhost:4321', 'http://127.0.0.1:4321',   # the local test server
    'http://localhost:4777', 'http://127.0.0.1:4777',
}
MAX_AUDIO = 200 * 1024 * 1024
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,40}$')

# a prompt that makes Whisper write the way the owner speaks: English with Hindi mixed in,
# Hindi in Roman letters, and the filler words left in rather than tidied away
PROMPT = ("Umm, so, uh, basically I was like, you know, thinking about it. "
          "Haan, main yeh bol raha hoon, matlab, kuch toh karna padega, na? "
          "Okay, so, uh, let me explain.")


class Store:
    """The data folder. One lock: the takes are tiny and writes are rare."""

    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()
        for d in ('audio', 'takes', 'coaching', 'site_cache'):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        self.index = {}   # take id -> day
        for f in sorted((self.root / 'takes').glob('*.json')):
            for t in self._read(f.stem):
                self.index[t['id']] = f.stem

    def _path(self, day):
        return self.root / 'takes' / (day + '.json')

    def _read(self, day):
        p = self._path(day)
        if not p.exists():
            return []
        try:
            return json.loads(p.read_text(encoding='utf-8')).get('takes', [])
        except Exception:
            # a file that cannot be read is moved aside, never written over
            p.replace(p.with_suffix('.broken-%d.json' % int(time.time())))
            return []

    def _write(self, day, takes):
        p = self._path(day)
        if not takes:
            if p.exists():
                p.unlink()
            return
        tmp = p.with_suffix('.tmp')
        tmp.write_text(json.dumps({'v': 1, 'takes': takes}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        os.replace(tmp, p)

    def days(self):
        return sorted(p.stem for p in (self.root / 'takes').glob('*.json') if DAY_RE.match(p.stem))

    def takes(self, since=None):
        out = []
        with self.lock:
            for d in self.days():
                if since and d < since:
                    continue
                out.extend(self._read(d))
        out.sort(key=lambda t: t.get('at', 0))
        return out

    def get(self, tid):
        with self.lock:
            day = self.index.get(tid)
            if not day:
                return None
            for t in self._read(day):
                if t['id'] == tid:
                    return t
        return None

    def put(self, take):
        """Add a take, or replace it when the id is known and this version is not older."""
        with self.lock:
            day = take['day']
            cur = self._read(day)
            for i, t in enumerate(cur):
                if t['id'] == take['id']:
                    if take.get('mod', 0) >= t.get('mod', 0):
                        cur[i] = take
                    break
            else:
                cur.append(take)
            cur.sort(key=lambda t: t.get('at', 0))
            self._write(day, cur)
            self.index[take['id']] = day
        return take

    def update(self, tid, **fields):
        with self.lock:
            t = self.get(tid)
            if not t:
                return None
            t.update(fields)
            t['mod'] = int(time.time() * 1000)
            return self.put(t)

    def delete(self, tid):
        with self.lock:
            day = self.index.pop(tid, None)
            if not day:
                return False
            self._write(day, [t for t in self._read(day) if t['id'] != tid])
            for f in (self.root / 'audio' / day).glob(tid + '_*'):
                f.unlink()
            return True

    def audio_path(self, day, tid, part):
        return self.root / 'audio' / day / ('%s_%d.webm' % (tid, part))

    def save_audio(self, day, tid, part, data):
        p = self.audio_path(day, tid, part)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix('.part')
        tmp.write_bytes(data)
        os.replace(tmp, p)
        return p

    def coaching(self):
        names = sorted(p.name for p in (self.root / 'coaching').glob('*.md') if DAY_RE.match(p.stem))
        if not names:
            return None
        text = (self.root / 'coaching' / names[-1]).read_text(encoding='utf-8')
        return {'name': names[-1], 'text': text, 'all': names}


# ---------------------------------------------------------------- transcription

class Whisper:
    """faster-whisper, loaded on first use (a few seconds), kept for the next take."""

    def __init__(self, model_dir):
        self.model_dir = model_dir
        self.model = None
        self.state = 'idle'   # idle | loading | ready | missing

    def available(self):
        return Path(self.model_dir).exists() and (Path(self.model_dir) / 'model.bin').exists()

    def load(self):
        if self.model is not None:
            return
        if not self.available():
            self.state = 'missing'
            raise RuntimeError('the Whisper model is not at ' + str(self.model_dir))
        self.state = 'loading'
        from faster_whisper import WhisperModel
        self.model = WhisperModel(str(self.model_dir), device='cpu', compute_type='int8',
                                  cpu_threads=max(2, (os.cpu_count() or 4) - 2))
        self.state = 'ready'

    def transcribe(self, paths):
        """-> {'text', 'words': [{w, s, e}], 'lang'}; the parts of a take are joined in order,
        each part's times shifted by the length of the parts before it."""
        self.load()
        words, texts, offset, lang = [], [], 0.0, ''
        for p in paths:
            segs, info = self.model.transcribe(
                str(p), language='en', task='transcribe', beam_size=5, temperature=0.0,
                word_timestamps=True, vad_filter=False, condition_on_previous_text=False,
                initial_prompt=PROMPT)
            lang = info.language
            for seg in segs:
                texts.append(seg.text.strip())
                for w in (seg.words or []):
                    words.append({'w': w.word.strip(), 's': round(offset + w.start, 2), 'e': round(offset + w.end, 2)})
            offset += info.duration
        return {'text': ' '.join(t for t in texts if t), 'words': [w for w in words if w['w']], 'lang': lang}


class FakeWhisper:
    """A stand-in with the same shape, for the tests: the words come from the take's own
    'fake' field (or a fixed sentence), 0.4 s apart, with a 1.6 s silence after the third."""
    state = 'ready'

    def available(self):
        return True

    def transcribe(self, paths, fake=None):
        text = fake or 'um so the thing is I want to explain it to you'
        words, t = [], 1.2
        for i, w in enumerate(text.split()):
            words.append({'w': w, 's': round(t, 2), 'e': round(t + 0.3, 2)})
            t += 0.4 + (1.6 if i == 2 else 0)
        return {'text': text, 'words': words, 'lang': 'en'}


class Worker(threading.Thread):
    def __init__(self, store, engine, log):
        super().__init__(daemon=True)
        self.store, self.engine, self.log = store, engine, log
        self.q = queue.Queue()
        self.busy = ''

    def add(self, tid):
        self.q.put(tid)

    def pending(self):
        return self.q.qsize() + (1 if self.busy else 0)

    def run(self):
        while True:
            tid = self.q.get()
            self.busy = tid
            try:
                self.one(tid)
            except Exception as e:   # one bad take never stops the line
                self.log('transcription of %s failed: %s' % (tid, ''.join(traceback.format_exception_only(type(e), e)).strip()))
                self.store.update(tid, status='error', error=str(e)[:300])
            finally:
                self.busy = ''

    def one(self, tid):
        t = self.store.get(tid)
        if not t or t.get('status') == 'done':
            return
        paths = [self.store.audio_path(t['day'], tid, i) for i in range(int(t.get('parts') or 0))]
        paths = [p for p in paths if p.exists()]
        if not paths:
            self.store.update(tid, status='done' if t.get('text') else 'error', error='' if t.get('text') else 'no audio arrived')
            return
        self.store.update(tid, status='transcribing')
        began = time.time()
        if isinstance(self.engine, FakeWhisper):
            res = self.engine.transcribe(paths, t.get('fake'))
        else:
            res = self.engine.transcribe(paths)
        self.log('take %s transcribed in %.0f s (%d words)' % (tid, time.time() - began, len(res['words'])))
        # the dictated words (if any) are kept next to Whisper's; Whisper's are the take's words
        fields = dict(status='done', text=res['text'], words=res['words'], lang=res['lang'], error='')
        if t.get('text') and not t.get('dictated'):
            fields['dictated'] = t['text']
        self.store.update(tid, **fields)


# ---------------------------------------------------------------- http

def make_handler(store, worker, engine, log, upstream=UPSTREAM):
    class H(BaseHTTPRequestHandler):
        server_version = 'speakd/%d' % VERSION
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *a):
            pass

        # -- guards: loopback only, and only the site's own pages
        def _host_ok(self):
            h = (self.headers.get('Host') or '').split(':')[0].lower()
            return h in ('localhost', '127.0.0.1')

        def _origin(self):
            o = self.headers.get('Origin')
            return o if o in ALLOWED_ORIGINS else None

        def _cors(self):
            o = self._origin()
            if o:
                self.send_header('Access-Control-Allow-Origin', o)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
                # Chrome asks before a public site may reach a private (local) address
                self.send_header('Access-Control-Allow-Private-Network', 'true')

        def _send(self, status, body=b'', ctype='application/json; charset=utf-8', extra=None):
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self._cors()
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def _allowed(self):
            """Data is only for the site's pages. A request with no Origin (a plain GET typed in
            the address bar, a local tool) is fine from this machine; one from another website is not."""
            if not self._host_ok():
                self._send(403, {'error': 'bad host'})
                return False
            if self.headers.get('Origin') and not self._origin():
                self._send(403, {'error': 'origin not allowed'})
                return False
            return True

        def do_OPTIONS(self):
            if not self._host_ok() or not self._origin():
                return self._send(403, {'error': 'not allowed'})
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self._cors()
            self.send_header('Access-Control-Max-Age', '600')
            self.end_headers()

        def _json_body(self, limit=5 * 1024 * 1024):
            n = int(self.headers.get('Content-Length') or 0)
            if n > limit:
                raise ValueError('body too large')
            raw = self.rfile.read(n) if n else b''
            return json.loads(raw.decode('utf-8')) if raw else {}

        def do_GET(self):
            if not self._allowed():
                return
            u = urlparse(self.path)
            q = parse_qs(u.query)
            p = u.path
            if p == '/health':
                return self._send(200, {
                    'ok': True, 'v': VERSION, 'whisper': engine.state if engine.available() else 'missing',
                    'pending': worker.pending(), 'data': str(store.root)})
            if p == '/takes':
                since = (q.get('since') or [''])[0]
                since = since if DAY_RE.match(since) else None
                return self._send(200, {'takes': store.takes(since), 'days': store.days()})
            m = re.match(r'^/take/([A-Za-z0-9_-]+)$', p)
            if m:
                t = store.get(m.group(1))
                return self._send(200, t) if t else self._send(404, {'error': 'no such take'})
            m = re.match(r'^/audio/([A-Za-z0-9_-]+)/(\d+)$', p)
            if m:
                t = store.get(m.group(1))
                f = store.audio_path(t['day'], m.group(1), int(m.group(2))) if t else None
                if not f or not f.exists():
                    return self._send(404, {'error': 'no audio'})
                return self._send(200, f.read_bytes(), 'audio/webm')
            if p == '/coaching':
                c = store.coaching()
                return self._send(200, c or {'name': '', 'text': '', 'all': []})
            self._site(u)

        def _site(self, u):
            """The site's own pages and files, fetched from the site (and kept, for when there is no
            internet). Only GET, only from the one host, never a path that climbs out."""
            path = u.path
            if path == '/':
                self.send_response(302)
                self.send_header('Location', '/speak/')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if '..' in path or chr(92) in path or not path.startswith('/') or len(path) > 300:
                return self._send(404, {'error': 'not found'})
            url = upstream.rstrip('/') + quote(path, safe='/%:@') + ('?' + u.query if u.query else '')
            key = hashlib.sha1(url.encode('utf-8')).hexdigest()
            cache = store.root / 'site_cache' / key
            ctype = None
            body = None
            try:
                req = Request(url, headers={'User-Agent': 'speakd/%d' % VERSION})
                with urlopen(req, timeout=8) as r:
                    body = r.read(20 * 1024 * 1024)
                    ctype = r.headers.get('Content-Type')
                    status = r.status
                if status == 200:
                    cache.write_bytes(body)
                    cache.with_suffix('.type').write_text(ctype or '', encoding='utf-8')
                else:
                    body = None
            except Exception as e:
                if getattr(e, 'code', None) == 404:
                    return self._send(404, {'error': 'not found'})
                body = None   # no internet, or the site is down: fall back to the copy
            if body is None:
                if not cache.exists():
                    return self._send(502, {'error': 'the site could not be reached and nothing is kept for this page yet'})
                body = cache.read_bytes()
                tf = cache.with_suffix('.type')
                ctype = tf.read_text(encoding='utf-8') if tf.exists() else None
            if not ctype:
                ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
            return self._send(200, body, ctype)

        def do_POST(self):
            if not self._allowed():
                return
            u = urlparse(self.path)
            q = parse_qs(u.query)
            p = u.path
            try:
                if p == '/audio':
                    tid = (q.get('id') or [''])[0]
                    day = (q.get('day') or [''])[0]
                    part = int((q.get('n') or ['0'])[0])
                    n = int(self.headers.get('Content-Length') or 0)
                    if not ID_RE.match(tid) or not DAY_RE.match(day) or not 0 <= part < 50:
                        return self._send(400, {'error': 'bad id, day or part'})
                    if n <= 0 or n > MAX_AUDIO:
                        return self._send(400, {'error': 'bad size'})
                    data = self.rfile.read(n)
                    store.save_audio(day, tid, part, data)
                    return self._send(200, {'ok': True, 'bytes': len(data)})
                if p == '/take':
                    b = self._json_body()
                    tid, day = str(b.get('id') or ''), str(b.get('day') or '')
                    if not ID_RE.match(tid) or not DAY_RE.match(day):
                        return self._send(400, {'error': 'bad id or day'})
                    parts = max(0, min(50, int(b.get('parts') or 0)))
                    take = {
                        'id': tid, 'day': day, 'at': int(b.get('at') or time.time() * 1000), 'mod': int(time.time() * 1000),
                        'mode': 'free' if b.get('mode') == 'free' else 'topic',
                        'topic': str(b.get('topic') or '')[:300], 'cat': str(b.get('cat') or '')[:30],
                        'target': int(b.get('target') or 0), 'think': int(b.get('think') or 0),
                        'sec': int(b.get('sec') or 0), 'delay': b.get('delay'),
                        'parts': parts, 'text': str(b.get('text') or ''),
                        'status': 'queued' if parts else 'done',
                    }
                    if b.get('fake'):
                        take['fake'] = str(b['fake'])[:2000]
                    # a repeat of a take already done keeps its words
                    old = store.get(tid)
                    if old and old.get('status') == 'done' and old.get('words'):
                        return self._send(200, old)
                    store.put(take)
                    if parts:
                        worker.add(tid)
                    return self._send(200, take)
                m = re.match(r'^/take/([A-Za-z0-9_-]+)/text$', p)
                if m:
                    b = self._json_body()
                    t = store.update(m.group(1), text=str(b.get('text') or ''), edited=True)
                    return self._send(200, t) if t else self._send(404, {'error': 'no such take'})
                m = re.match(r'^/take/([A-Za-z0-9_-]+)/retry$', p)
                if m:
                    t = store.update(m.group(1), status='queued', error='')
                    if not t:
                        return self._send(404, {'error': 'no such take'})
                    worker.add(m.group(1))
                    return self._send(200, t)
            except (ValueError, json.JSONDecodeError) as e:
                return self._send(400, {'error': str(e)})
            self._send(404, {'error': 'not found'})

        def do_DELETE(self):
            if not self._allowed():
                return
            m = re.match(r'^/take/([A-Za-z0-9_-]+)$', urlparse(self.path).path)
            if m:
                return self._send(200, {'deleted': store.delete(m.group(1))})
            self._send(404, {'error': 'not found'})

    return H


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--port', type=int, default=int(os.environ.get('SPEAK_PORT', 4777)))
    ap.add_argument('--data', default=os.environ.get('SPEAK_DATA', r'C:\Users\shyam\SpeechJournal'))
    ap.add_argument('--model', default=os.environ.get('SPEAK_MODEL'))
    ap.add_argument('--fake', action='store_true', help='use a stand-in for Whisper (tests)')
    ap.add_argument('--upstream', default=os.environ.get('SPEAK_UPSTREAM', UPSTREAM), help="where the site's pages come from")
    a = ap.parse_args(argv)

    store = Store(a.data)
    logf = open(store.root / 'speakd.log', 'a', encoding='utf-8')

    def log(msg):
        logf.write(datetime.now().strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
        logf.flush()

    engine = FakeWhisper() if a.fake else Whisper(a.model or str(store.root / 'models' / 'medium'))
    worker = Worker(store, engine, log)
    worker.start()
    # takes that were still waiting when the helper last stopped
    for t in store.takes():
        if t.get('status') in ('queued', 'transcribing'):
            worker.add(t['id'])
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(store, worker, engine, log, a.upstream))
    log('speakd %d listening on 127.0.0.1:%d, data %s, whisper %s' % (VERSION, a.port, store.root, 'FAKE' if a.fake else engine.model_dir))
    if sys.stdout:   # pythonw (no console) has none
        print('speakd listening on http://127.0.0.1:%d  (data: %s)' % (a.port, store.root), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
