#!/usr/bin/env python3
"""Run the real Whisper on one audio file and print the words with their times.

    C:\\Users\\shyam\\SpeechJournal\\venv\\Scripts\\python.exe tools/speakd/try_whisper.py <audio file> [model dir]

For checking the setup by hand (a spoken test clip, or one of the recordings in the data folder).
Needs the model in <data>/models/medium; nothing is saved anywhere.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import speakd  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    audio = Path(sys.argv[1])
    model = sys.argv[2] if len(sys.argv) > 2 else r'C:\Users\shyam\SpeechJournal\models\medium'
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
    w = speakd.Whisper(model)
    t0 = time.time()
    w.load()
    print('model loaded in %.1f s' % (time.time() - t0))
    t1 = time.time()
    res = w.transcribe([audio])
    took = time.time() - t1
    last = res['words'][-1]['e'] if res['words'] else 0
    print('transcribed %.1f s of speech in %.1f s' % (last, took))
    print('text:', res['text'])
    print()
    prev = 0.0
    for x in res['words']:
        gap = x['s'] - prev
        print('%6.2f-%6.2f  %s%s' % (x['s'], x['e'], x['w'], ('   <-- gap %.1f s' % gap) if gap >= 0.7 else ''))
        prev = x['e']
    return 0


if __name__ == '__main__':
    sys.exit(main())
