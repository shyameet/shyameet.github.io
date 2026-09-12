---
title: "Put the logic on the chart before you trust it"
date: 2026-09-12T18:48:00+05:30
section: feynman
tags: [quant, trading]
---

If I have a strategy or some logic in my head, the first thing is to **see** it. Not
backtest it — see it.

The way to do that is to build the logic as an indicator and plot it. If I am working on
MACD, I plot the MACD lines against the price. Then I can see the gap between what the
formula is doing underneath and what is actually showing up on the chart. Those two are
not always the same thing, and looking is the only way you find that out.

So: the logic goes into an indicator first. If the indicator looks right, then you have
something worth testing.

## The history limit

TradingView will not let you go back as far as you want. On a one-minute chart you get
about five to seven days. On a five-minute chart, ten to fifteen. There is a hard limit,
and you have to hold it in your head while you are building — because it quietly decides
how much evidence you are allowed to see in the first place.

## And here is the trap

You can tune a logic until it works beautifully on the past week. Every signal lands.
All seven days are profitable. The trades look perfect.

That is not how the market works.

If it worked for five days, the next five can just as easily go the other way — and the
losses can be bigger than anything you have seen. A week is not evidence. A week is a
week. The shorter the window, the easier it is to fit to it without noticing you are
doing it.

So the chart is where this starts, not where it finishes. The visual tells you the logic
is *doing what you think it is doing*. It tells you nothing about whether it will keep
working. For that you need the other metrics.

## The monster

And even once you have an edge — even when the metrics say it is real — you do not let
it out.

Call the edge a monster. It is yours, and it is still dangerous. It stays in the lab.
You do not turn it loose just because it looked good.

Before it leaves, you need to know three things about it:

- **What it eats.** The conditions it needs to survive. Which regime, which volatility,
  which hours. Feed it the wrong market and it dies.
- **How much it kills.** What it takes off you when it is wrong. Not the average — the
  worst.
- **How much it helps.** What it actually gives back, after everything it costs.

An edge you have not measured on all three is not an edge. It is an animal you have not
looked at properly.
