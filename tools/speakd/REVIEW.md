# How the daily speech review is done

This is the method for the review of the owner's speaking practice. It is read by whoever does the
review (Claude, in a scheduled run at night or in a chat when asked "review my speech"). It is not
code and it holds no personal data.

## What the review is

A coach reading what he actually said, and telling him the one or two things that will change how he
speaks tomorrow. It is **not** a score, a dashboard or a list of every flaw. The page already shows
the facts (pace, fillers, pauses, the marked transcript); the review is the part that needs a reader.

## Steps

1. Run `python tools/speakd/review_pack.py --days 7` (the data folder is `C:\Users\shyam\SpeechJournal`).
   It prints each take with its transcript, silences marked inline like `[1.7s]`, and the last two
   notes already written.
2. Talks recorded on the tablet reach the PC hours (or a day) late, so review every day of the last
   seven that has finished takes and no note yet, oldest first, not only today. Then read those takes
   the way a listener would. If there are no takes today, write nothing and stop
   (never an empty or invented note). If a note for today already exists, read it: rewrite it only when
   there are takes newer than the note (add them in and keep its numbers right), otherwise leave it alone.
3. Read the last two notes. Do not repeat advice that was followed; if a drill was not followed or
   the same habit is still there, say so kindly and make the next step smaller, not longer.
4. Write `C:\Users\shyam\SpeechJournal\coaching\YYYY-MM-DD.md` (UTF-8; today's date). Never edit or
   delete a take. The Speak page shows the newest note.

## What to look for (in this order of importance for him)

- **Did he answer the question?** For a topic: a clear first sentence, one example, a reason, an
  ending. For a free talk: one idea at a time, or a pile?
- **The habit that costs the most**, by count and by effect: "um/uh", "so", "like", "you know",
  "I mean", "basically", "matlab"; restarts (a phrase begun twice); trailing off ("so yeah…").
  Say which ONE to work on, with a quote from his own words.
- **Pauses.** A pause before an idea is good; a long one in the middle of a sentence is a hunt for a
  word. Tell them apart by what comes after. A pause is not a failure: silence beats a filler.
- **The start and the end.** How long before the first word, and how the talk finished.
- **Pace and sentence length**, only if they got in the way (too fast to follow, or stalling).
- **Hindi and English mixed.** Natural switching is fine. Only mention it if it made a sentence
  unclear. Whisper can mis-hear Hindi or an accent: never criticise a word that looks like
  mis-hearing; if the transcript is clearly wrong somewhere, say so instead of blaming him.

## How it is written

- Short and plain: under about 250 words. Short sentences, everyday words (he asked for "plain, small
  format"). Warm and direct; honest, not flattering. No scores, no percentages, no jargon.
- Quote his real words, in quotation marks, so he can see what you mean.
- Structure (headings and bullets are shown on the page; bold is allowed):

```
## Today
One or two sentences: what the talk was like, honestly.

## Good
- one specific thing he did well, with a quote

## Work on
- the ONE habit, with a quote and what to do instead

## Tomorrow's drill
- a concrete two-minute exercise (for example: "say your first sentence, then stop for a full second
  before the next one"), tied to the habit above

## Since last time
- one line: better, same, or worse, and by how much in plain words
```

## Counting

Count, never estimate. "Starts a sentence with So / And" is counted per sentence: Whisper puts the full
stops in, so a sentence starts at the first word and after any word ending . ? or !. The Speak page shows
the same count for each take (the "So / And starters" chip); say "7 of 14 sentences", not "a lot". Check
any number you quote against the transcript before writing it (the first note once said "about 25
sentences" when there were 14).

## Rules

- Never claim a number you did not see. The facts line in each take of the review pack is what to cite.
- Audio is never sent anywhere; do not describe how he sounds (tone, accent): only what he said and when.
- The review is advice for the owner alone. Nothing from the data folder goes in any repository,
  message or page other than the Speak page on his own PC.
