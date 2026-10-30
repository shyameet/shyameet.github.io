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
import shutil
import subprocess
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
INBOX_REMOTE = 'https://github.com/shyameet/shyameet.github.io.git'   # public: everything in the drop box branch is encrypted
ALLOWED_ORIGINS = {
    'https://shyameet.github.io',
    'http://localhost:4321', 'http://127.0.0.1:4321',   # the local test server
    'http://localhost:4777', 'http://127.0.0.1:4777',
}
MAX_AUDIO = 200 * 1024 * 1024
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,40}$')

# A hint that makes Whisper write the way the owner speaks: English with Hindi mixed in, Hindi
# in Roman letters, and the filler words kept rather than tidied away. A hint has a cost, found by
# testing on 21 Oct: on a stretch with no speech Whisper repeats it ("Umm, so, uh, basically..."),
# and with no hint at all it writes "Thanks for watching!". So a recording with no voice in it is
# never given to Whisper (VAD is used ONLY to decide that), and anything that still looks like an
# echo of the hint, a stock phrase or a loop is dropped.
PROMPT = ("Umm, so, uh, basically I was like, you know, thinking about it. "
          "Haan, main yeh bol raha hoon, matlab, kuch toh karna padega, na? "
          "Okay, so, uh, let me explain.")
# What counts as "a voice" for that decision: a soft "um" is voice too, hence a threshold below the default 0.5.
VAD = dict(threshold=0.35, min_silence_duration_ms=1500, speech_pad_ms=400)
MIN_SPEECH = 1.0         # seconds of voice a recording needs before Whisper is asked to write anything
# Whisper is NOT given the VAD's cut-up audio: on the first real tablet talk (24 Oct) that made the
# transcript tidier and wrong, hiding two of the owner's "so"s and turning "my opinion" into "mapping your
# work". It reads the whole recording, with a fallback to a little randomness when a pass loops or is unsure.
TEMPS = (0.0, 0.2, 0.4)
NO_SPEECH_HARD = 0.85    # a stretch Whisper itself is this sure has no speech is dropped
NO_SPEECH_SOFT = 0.30    # with this much doubt, a stretch made only of the hint's own words, or of a stock phrase, is dropped
MAX_RUN = 4              # the same word more than this many times in a row is the model looping, not a person
KNOWN_NOISE_TEXT = ('thanks for watching', 'thank you for watching', 'thank you very much', 'subscribe')


def _norm(text):
    return re.sub(r'[^a-z0-9 ]+', ' ', str(text).lower().replace("'", '')).split()


def keep_segment(seg, prompt=PROMPT):
    """False for a stretch that is not the owner speaking: Whisper's own no-speech call, the hint
    repeated back, or the stock phrases it makes up over noise."""
    nsp = getattr(seg, 'no_speech_prob', 0.0) or 0.0
    words = _norm(seg.text)
    if not words:
        return False
    if nsp >= NO_SPEECH_HARD:
        return False
    flat = ' ' + ' '.join(words) + ' '
    if nsp >= NO_SPEECH_SOFT:
        if any(k in flat for k in KNOWN_NOISE_TEXT):
            return False
        if flat.strip() in ' ' + ' '.join(_norm(prompt)) + ' ':
            return False
        hint = set(_norm(prompt))
        if len(words) >= 3 and sum(1 for w in words if w in hint) / len(words) >= 0.8:
            return False   # the hint's own words again and again: a loop over noise
    return True


def collapse_runs(words, max_run=MAX_RUN):
    """Whisper sometimes loops on one word ("hello hello hello ..." a hundred times). A person does not say
    a word more than a few times in a row: a run longer than `max_run` is cut to its first two."""
    key = lambda w: ' '.join(_norm(w['w'])) or w['w']
    out, i = [], 0
    while i < len(words):
        j = i
        while j < len(words) and key(words[j]) == key(words[i]):
            j += 1
        run = words[i:j]
        out.extend(run if len(run) <= max_run else run[:2])
        i = j
    return out


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

    def deleted_ids(self):
        try:
            return set(json.loads((self.root / 'deleted.json').read_text(encoding='utf-8')))
        except Exception:
            return set()

    def delete(self, tid):
        with self.lock:
            gone = self.deleted_ids()
            if tid not in gone:
                gone.add(tid)
                (self.root / 'deleted.json').write_text(json.dumps(sorted(gone)), encoding='utf-8')
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

    def _audio(self, path):
        from faster_whisper.audio import decode_audio
        return decode_audio(str(path), sampling_rate=16000)

    def _speech_seconds(self, audio):
        """Seconds of voice in the recording (VAD is used for this and nothing else)."""
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        return sum(t['end'] - t['start'] for t in get_speech_timestamps(audio, VadOptions(**VAD))) / 16000.0

    def transcribe(self, paths):
        """-> {'text', 'words': [{w, s, e}], 'lang'}; the parts of a take are joined in order,
        each part's times shifted by the length of the parts before it."""
        self.load()
        words, offset, lang = [], 0.0, ''
        for p in paths:
            audio = self._audio(p)
            if self._speech_seconds(audio) >= MIN_SPEECH:
                segs, info = self.model.transcribe(
                    audio, language='en', task='transcribe', beam_size=5, temperature=TEMPS,
                    word_timestamps=True, vad_filter=False, condition_on_previous_text=False,
                    initial_prompt=PROMPT)
                lang = info.language
                part = []
                for seg in segs:
                    if not keep_segment(seg):
                        continue
                    for w in (seg.words or []):
                        part.append({'w': w.word.strip(), 's': round(offset + w.start, 2), 'e': round(offset + w.end, 2)})
                words.extend(collapse_runs([w for w in part if w['w']]))
            offset += len(audio) / 16000.0
        return {'text': ' '.join(w['w'] for w in words), 'words': words, 'lang': lang}


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


# ---------------------------------------------------------------- the drop box

NOWIN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)   # no console flashing up for each git call (pythonw)
HEX64 = re.compile(r'^[0-9a-f]{64}$', re.I)


class Crypt:
    """The drop box's lock, the same as the pages' (src/dropcrypto.js): AES-256-GCM, done with Node
    (tools/speakd/crypt.mjs). The key is made from the journal's sign-in; a signed-in page on this PC
    tells it to the helper (POST /dropkey) and it is kept in <data>/drop.key."""

    def __init__(self, keyfile):
        self.keyfile = Path(keyfile)
        self.node = shutil.which('node') or 'node'
        self.tool = Path(__file__).with_name('crypt.mjs')

    def key(self):
        try:
            k = self.keyfile.read_text(encoding='ascii').strip().lower()
        except OSError:
            return None
        return k if HEX64.match(k) else None

    def set_key(self, hexkey):
        """-> True if this is a new key."""
        if not HEX64.match(str(hexkey or '')):
            raise ValueError('the key must be 64 hex digits')
        hexkey = hexkey.lower()
        if self.key() == hexkey:
            return False
        tmp = self.keyfile.with_suffix('.tmp')
        tmp.write_text(hexkey, encoding='ascii')
        os.replace(tmp, self.keyfile)
        return True

    def _run(self, mode, data):
        k = self.key()
        if not k:
            raise RuntimeError('no key yet')
        p = subprocess.run([self.node, str(self.tool), mode, k], input=data, capture_output=True, timeout=120, creationflags=NOWIN)
        return p.returncode, p.stdout

    def seal(self, data):
        rc, out = self._run('enc', data)
        if rc != 0:
            raise RuntimeError('could not lock a file')
        return out

    def open(self, data):
        """-> the bytes, or None if the key is wrong or the file was changed."""
        rc, out = self._run('dec', data)
        return out if rc == 0 else None


class Inbox(threading.Thread):
    """Recordings made on another device (the tablet) reach this PC through a branch of the journal's own
    repository, and the finished words go back the same way, so every device shows the same takes. That
    repository is PUBLIC, so every file in the branch is encrypted (see Crypt); the key comes from the
    journal's sign-in, so there is nothing for the owner to set up.

    The layout of the branch `speech-drop` (the Speak page writes inbox/, this helper writes the rest):
      inbox/<day>/<id>_<n>.webm.enc   the audio, part n (written first)
      inbox/<day>/<id>.json.enc       the take's details (written after its audio: it means "complete")
      inbox/delete/<id>.enc           a request from a device to delete a take
      done/<day>_<id>.json.enc        a finished take: words with times, as in takes/ here
      coaching/<day>.md.enc           the advice, copied from the data folder
    A recording taken in is removed from the tip of the branch. The branch's history is squashed now and then
    (never when a device has pushed in between), so old ciphertext does not pile up. The audio is only ever
    transcribed here, on the PC. If the PC is off, recordings simply wait in the branch.

    All of it goes through plain `git` with the login this PC already has. Nothing here needs a token.
    """

    def __init__(self, store, worker, log, remote, workdir, interval=45, crypt=None, branch='speech-drop', keep=150):
        super().__init__(daemon=True)
        self.store, self.worker, self.log = store, worker, log
        self.remote, self.dir, self.interval = remote, Path(workdir), interval
        self.crypt = crypt or Crypt(store.root / 'drop.key')
        self.branch_name, self.keep = branch, keep
        self.stop = threading.Event()
        self.statefile = store.root / 'dropbox_state.json'   # what was last written to the branch: plaintext hashes
        self.last_trim = 0
        self.status = {'configured': True, 'has_key': bool(self.crypt.key()), 'last_ok': 0, 'last_error': '', 'imported': 0, 'cycles': 0}

    # -- git
    def _env(self):
        return dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never', LC_ALL='C')

    def git(self, *args, check=True, timeout=180):
        p = subprocess.run(['git', *args], cwd=str(self.dir), capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=timeout, env=self._env(), creationflags=NOWIN)
        if check and p.returncode != 0:
            raise RuntimeError('git %s failed: %s' % (' '.join(args[:2]), (p.stderr or p.stdout).strip()[:300]))
        return p

    def _config(self):
        self.git('config', 'user.name', 'Speak helper')
        self.git('config', 'user.email', 'speak-helper@users.noreply.github.com')

    def ensure_clone(self):
        if (self.dir / '.git').exists():
            return
        self.dir.parent.mkdir(parents=True, exist_ok=True)
        p = subprocess.run(['git', 'clone', '-q', '--single-branch', '--branch', self.branch_name, self.remote, str(self.dir)],
                           capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300,
                           env=self._env(), creationflags=NOWIN)
        err = (p.stderr or p.stdout).strip().replace('\n', ' ')
        if p.returncode == 0:
            self._config()
            return
        shutil.rmtree(self.dir, ignore_errors=True)
        if 'not found in upstream' in err or 'Could not find remote branch' in err:
            self._create_branch()   # the first time ever: an empty branch of its own, with nothing of the site in it
            return
        raise RuntimeError('git clone failed: ' + err[:300])

    def _create_branch(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            self.git('init', '-q', '-b', self.branch_name)
            self._config()
            self.git('remote', 'add', 'origin', self.remote)
            (self.dir / 'README.md').write_text(
                'Encrypted drop box for the Speak page. Every file here is locked; none can be read without the key.\n', encoding='utf-8')
            self.git('add', '-A')
            self.git('commit', '-q', '-m', 'speak: drop box')
            self.git('push', '-q', '-u', 'origin', self.branch_name)
        except Exception:
            shutil.rmtree(self.dir, ignore_errors=True)   # e.g. a device made the branch first: the next cycle clones it
            raise

    def sync_down(self):
        self.git('fetch', '-q', 'origin', check=False)
        if self.git('rev-parse', '--verify', '-q', 'origin/' + self.branch_name, check=False).returncode == 0:
            p = self.git('rebase', '--autostash', 'origin/' + self.branch_name, check=False)
            if p.returncode != 0:
                self.git('rebase', '--abort', check=False)
                raise RuntimeError('could not rebase onto the remote: ' + (p.stderr or p.stdout).strip()[:200])

    # -- reading the branch
    def _read(self, path):
        """-> the plain bytes of a locked file, or None (wrong key, damaged)."""
        try:
            return self.crypt.open(path.read_bytes())
        except OSError:
            return None

    def import_new(self):
        base = self.dir / 'inbox'
        n = 0
        if not base.exists():
            return 0
        # a device asked for a take to be deleted
        for f in sorted((base / 'delete').glob('*.enc')):
            tid = f.name[:-4]
            if ID_RE.match(tid):
                self.store.delete(tid)
            f.unlink()
        for meta_path in sorted(base.glob('*/*.json.enc')):
            if meta_path.parent.name == 'delete':
                continue
            raw = self._read(meta_path)
            if raw is None:
                self.log('drop box: could not unlock %s (a different key?)' % meta_path.name)
                continue
            try:
                m = json.loads(raw.decode('utf-8'))
            except Exception:
                self.log('drop box: could not read %s' % meta_path.name)
                continue
            tid, day = str(m.get('id') or ''), str(m.get('day') or '')
            if not ID_RE.match(tid) or not DAY_RE.match(day) or meta_path.parent.name != day:
                continue
            if self.store.get(tid) or tid in self.store.deleted_ids():
                continue
            parts = int(m.get('parts') or 0)
            files = [meta_path.parent / ('%s_%d.webm.enc' % (tid, i)) for i in range(parts)]
            if not 0 <= parts <= 50 or not all(p.exists() for p in files):
                continue   # still arriving
            audio = [self._read(p) for p in files]
            if any(a is None for a in audio):
                self.log('drop box: could not unlock the audio of %s' % tid)
                continue
            for i, a in enumerate(audio):
                self.store.save_audio(day, tid, i, a)
            self.store.put({
                'id': tid, 'day': day, 'at': int(m.get('at') or time.time() * 1000), 'mod': int(time.time() * 1000),
                'mode': 'free' if m.get('mode') == 'free' else 'topic',
                'topic': str(m.get('topic') or '')[:300], 'cat': str(m.get('cat') or '')[:30],
                'target': int(m.get('target') or 0), 'think': int(m.get('think') or 0), 'sec': int(m.get('sec') or 0),
                'delay': None, 'parts': parts, 'text': '', 'origin': 'drop box',
                'status': 'queued' if parts else 'error', 'error': '' if parts else 'no audio',
            })
            if parts:
                self.worker.add(tid)
            n += 1
        self.status['imported'] += n
        return n

    # -- writing the branch
    def _state(self):
        try:
            return json.loads(self.statefile.read_text(encoding='utf-8'))
        except Exception:
            return {}

    def _write_locked(self, state, rel, plain):
        """Lock `plain` into <rel> unless the branch already holds exactly this (locking is random, so compare the plain)."""
        h = hashlib.sha256(plain).hexdigest()
        out = self.dir / rel
        if state.get(rel) == h and out.exists():
            return False
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(self.crypt.seal(plain))
        state[rel] = h
        return True

    def export(self):
        changed = False
        state = self._state()
        gone = self.store.deleted_ids()
        for t in self.store.takes():
            if t.get('status') not in ('done', 'error'):
                continue
            doc = {k: v for k, v in t.items() if k not in ('fake', 'edited')}
            plain = (json.dumps(doc, ensure_ascii=False, indent=1) + '\n').encode('utf-8')
            changed |= self._write_locked(state, 'done/%s_%s.json.enc' % (t['day'], t['id']), plain)
            # the audio of a recording that came in through the branch is not needed there any more
            box = self.dir / 'inbox' / t['day']
            for f in list(box.glob(t['id'] + '*')) if box.exists() else []:
                f.unlink()
                changed = True
        # takes deleted (here, or by a device) are removed from the branch; nothing else ever is
        for f in list((self.dir / 'done').glob('*.json.enc')) if (self.dir / 'done').exists() else []:
            tid = f.name[:-9].split('_', 1)[-1]
            if tid in gone:
                f.unlink()
                state.pop('done/' + f.name, None)
                changed = True
        for f in sorted((self.store.root / 'coaching').glob('*.md')):
            changed |= self._write_locked(state, 'coaching/%s.enc' % f.name, f.read_bytes())
        tmp = self.statefile.with_suffix('.tmp')
        tmp.write_text(json.dumps(state), encoding='utf-8')
        os.replace(tmp, self.statefile)
        return changed

    def push(self):
        self.git('add', '-A')
        if not self.git('status', '--porcelain').stdout.strip():
            return False
        self.git('commit', '-q', '-m', 'speak: sync')
        last = ''
        for _ in range(3):
            p = self.git('push', '-q', 'origin', 'HEAD:' + self.branch_name, check=False)
            if p.returncode == 0:
                return True
            last = (p.stderr or p.stdout).strip()[:200]
            self.sync_down()   # a device pushed in between: put ours on top and try again
        raise RuntimeError('push failed: ' + last)

    def trim(self):
        """Squash the branch's history when it is long (about once a day at most). A force push that only
        replaces exactly the commit just fetched, so a device that pushed in between is never overwritten."""
        if time.time() - self.last_trim < 86400:
            return False
        n = int(self.git('rev-list', '--count', 'HEAD').stdout.strip() or 0)
        if n <= self.keep:
            return False
        self.last_trim = time.time()
        self.git('fetch', '-q', 'origin')
        tip = self.git('rev-parse', 'origin/' + self.branch_name).stdout.strip()
        if self.git('rev-parse', 'HEAD').stdout.strip() != tip:
            return False   # something new arrived: try another day
        self.git('checkout', '-q', '--orphan', 'trim-tmp')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'speak: history squashed')
        self.git('branch', '-q', '-M', self.branch_name)
        self.git('push', '-q', '--force-with-lease=%s:%s' % (self.branch_name, tip), 'origin', self.branch_name)
        self.git('reflog', 'expire', '--expire=now', '--all', check=False)
        self.git('gc', '-q', '--prune=now', check=False)
        self.log('drop box: history squashed (%d commits)' % n)
        return True

    def cycle(self):
        self.status['has_key'] = bool(self.crypt.key())
        if not self.status['has_key']:
            raise RuntimeError('waiting for the key: open the journal once on this PC while signed in')
        self.ensure_clone()
        self.sync_down()
        self.import_new()
        self.export()
        self.push()
        self.trim()
        self.status['cycles'] += 1
        self.status['last_ok'] = int(time.time())
        self.status['last_error'] = ''

    def run(self):
        while not self.stop.is_set():
            wait = 15 if self.worker.pending() else self.interval
            try:
                self.cycle()
            except Exception as e:
                msg = str(e)
                if msg != self.status['last_error']:
                    self.log('drop box: ' + msg)
                self.status['last_error'] = msg
                wait = max(wait, 60 if not self.status['has_key'] else 120)   # not reachable, or no key yet: do not hammer it
            self.stop.wait(wait)


# ---------------------------------------------------------------- http

def make_handler(store, worker, engine, log, upstream=UPSTREAM, inbox=None, crypt=None):
    crypt = crypt or (inbox.crypt if inbox else Crypt(store.root / 'drop.key'))
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
            # the log keeps every write, and every request that failed, so a take that "did not arrive" can be traced
            path = self.path.split('?')[0]
            if self.command in ('POST', 'DELETE') or (status >= 400 and path not in ('/favicon.ico',)):
                log('%s %s -> %d (origin %s, %d bytes)' % (self.command, path, status, self.headers.get('Origin') or '-', len(body)))

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
                    'pending': worker.pending(), 'data': str(store.root),
                    'dropbox': dict(inbox.status, has_key=bool(inbox.crypt.key())) if inbox else None})
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
            if p == '/dropkey':
                return self._send(200, {'has': bool(crypt.key())})   # whether it has one, never the key
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
                if p == '/dropkey':
                    b = self._json_body()
                    try:
                        changed = crypt.set_key(str(b.get('key') or ''))
                    except ValueError as e:
                        return self._send(400, {'error': str(e)})
                    if inbox:
                        inbox.status['has_key'] = True
                    return self._send(200, {'ok': True, 'changed': changed})
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
    ap.add_argument('--inbox-remote', default=os.environ.get('SPEAK_INBOX_REMOTE'), help='the git repo whose speech-drop branch carries (encrypted) recordings from other devices')
    ap.add_argument('--inbox-dir', default=None, help='where this PC keeps its clone of it (default <data>/dropbox)')
    ap.add_argument('--inbox-interval', type=int, default=45)
    ap.add_argument('--no-inbox', action='store_true', help='do not use the drop box')
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
    inbox = None
    remote = a.inbox_remote or (None if a.fake else INBOX_REMOTE)
    if remote and not a.no_inbox:
        inbox = Inbox(store, worker, log, remote, a.inbox_dir or str(store.root / 'dropbox'), a.inbox_interval)
        inbox.start()
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(store, worker, engine, log, a.upstream, inbox))
    log('speakd %d listening on 127.0.0.1:%d, data %s, whisper %s' % (VERSION, a.port, store.root, 'FAKE' if a.fake else engine.model_dir))
    if sys.stdout:   # pythonw (no console) has none
        print('speakd listening on http://127.0.0.1:%d  (data: %s)' % (a.port, store.root), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
