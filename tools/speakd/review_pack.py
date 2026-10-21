#!/usr/bin/env python3
"""review_pack - the day's talks laid out to be read by a person (or by Claude), not scored.

    python tools/speakd/review_pack.py [--days 7] [--data DIR] [--day YYYY-MM-DD]

For every take it prints when it was, the topic, how long, the pace, when the first word came,
and the transcript exactly as Whisper wrote it, with each silence of 0.7 s or more marked
inline like [1.7s] and a short list of the pauses. Nothing here judges: no score, no verdict.
The advice is written by a reader, from the words, into <data>/coaching/YYYY-MM-DD.md.

Also prints the notes already written (the last two), so a new review builds on the last one
instead of repeating it.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

HARD = {'um', 'umm', 'ummm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mmm', 'mm'}


def load(data, since=None, day=None):
    out = []
    for f in sorted((Path(data) / 'takes').glob('*.json')):
        if day and f.stem != day:
            continue
        if since and f.stem < since:
            continue
        try:
            out.extend(json.loads(f.read_text(encoding='utf-8')).get('takes', []))
        except Exception as e:
            print('(could not read %s: %s)' % (f.name, e), file=sys.stderr)
    out.sort(key=lambda t: t.get('at', 0))
    return out


def marked(words, min_gap=0.7):
    parts, gaps = [], []
    for i, w in enumerate(words):
        if i:
            g = w['s'] - words[i - 1]['e']
            if g >= min_gap:
                parts.append('[%.1fs]' % g)
                gaps.append(round(g, 1))
        parts.append(w['w'])
    return ' '.join(parts), gaps


def one(t):
    when = datetime.fromtimestamp(t['at'] / 1000).strftime('%a %d %b, %H:%M')
    head = '### %s — %s' % (when, 'free talk' if t.get('mode') == 'free' else t.get('topic', ''))
    lines = [head]
    if t.get('status') != 'done':
        lines.append('(status: %s%s)' % (t.get('status'), ' — ' + t['error'] if t.get('error') else ''))
        return '\n'.join(lines)
    words = t.get('words') or []
    sec = t.get('sec') or 0
    text, gaps = marked(words)
    n = len(words)
    um = sum(1 for w in words if re.sub(r'[^a-z]', '', w['w'].lower()) in HARD)
    bits = ['%d s spoken' % sec, '%d words' % n]
    if sec >= 5:
        bits.append('%d words/min' % round(n / (sec / 60)))
    if words:
        bits.append('first word at %.1f s' % words[0]['s'])
    bits.append('%d um/uh/er' % um)
    bits.append('%d pauses ≥0.7 s%s' % (len(gaps), (' (longest %.1f s)' % max(gaps)) if gaps else ''))
    lines.append('; '.join(bits) + '.')
    lines.append('')
    lines.append(text if words else (t.get('text') or '(no words)'))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--day')
    ap.add_argument('--data', default=os.environ.get('SPEAK_DATA', r'C:\Users\shyam\SpeechJournal'))
    a = ap.parse_args()
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
    since = (datetime.now() - timedelta(days=a.days - 1)).strftime('%Y-%m-%d')
    takes = load(a.data, since, a.day)
    print('# Speech takes%s (%d)\n' % (' for ' + a.day if a.day else ' since ' + since, len(takes)))
    day = None
    for t in takes:
        if t['day'] != day:
            day = t['day']
            print('\n## %s\n' % day)
        print(one(t))
        print()
    notes = sorted((Path(a.data) / 'coaching').glob('*.md'))[-2:]
    if notes:
        print('\n# Notes already written (newest last)\n')
        for n in notes:
            print('## ' + n.name + '\n')
            print(n.read_text(encoding='utf-8').strip() + '\n')


if __name__ == '__main__':
    main()
