---
title: "A volume filter for entries — and why it didn't work"
date: 2026-09-15T17:23:00+05:30
day: 2026-09-14
section: feynman
tags: [quant, trading]
---

Rahul and I were talking through a filter for our trades, based on volume rather than
price or time.

The idea: on any given day, most of the day's trading volume gets done inside a fairly
tight price range — call it the zone. Because so much volume piles up there, it tends to
be consolidated, chopping back and forth rather than trending. So: find that zone, and
just don't trade inside it.

Concretely — mark the smallest price range that contains 70% of the day's total volume.
That range is now a no-entry zone. Longs only trigger above the top of the zone. Shorts
only trigger below the bottom of it. Nothing in between.

The logic behind it: if that's where most of the volume already happened, it's the zone
where the market has already agreed on a price — not where a real move starts. A move
starting would need to break out of that agreement first.

**I backtested it against our current configs. It did not hold up.** It did cut some
losing trades, which is the part that makes an idea like this feel like it's working. But
it cut *more* winning trades than losing ones — net, it made things worse, not better.

So this exact version is scrapped. The underlying idea — that a volume-consolidated zone
behaves differently from the rest of the day — might still be worth something, just not
applied this bluntly as an entry filter. That's still open.
