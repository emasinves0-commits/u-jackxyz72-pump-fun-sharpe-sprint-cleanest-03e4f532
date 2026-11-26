[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/emasinves0-commits/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/emasinves0-commits/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Momentum-Scale-Ride v2 — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on [make.fun](https://make.fun). Ranked by **hourly Sharpe ratio**, not total PnL — steady, controlled gains beat one lucky moonshot.

## Strategy

Cheap momentum probes buy a lottery ticket on a coin that might complete,
then scale in **only** as the curve proves itself at reserve milestones.
One hygiene rule does the Sharpe work: no single buyer may hold more than
**35%** of the probe window's buy flow — a coin whose early tape is one
whale is a dump waiting to happen.

- **Probe:** 0.05 SOL at 1.5–8 SOL real reserve, age ≥ 20 slots, 60-slot net
  inflow ≥ 0.5 SOL, ≥ 3 distinct buyers, top buyer ≤ 35% of buy flow,
  price up ≥ 2% and within 10% of its window high, creator has not sold.
- **Scale-in:** at 10 / 20 / 40 / 60 SOL real-reserve milestones while the
  price still climbs (each tranche capped at 1% of real reserve, max
  1.5 SOL at cost per coin). A coin at 40 SOL completes 46% of the time,
  at 60 SOL 74% — survivors earn size, losers stay small.
- **Exits:** stop −25% vs cost; bank 75% the first time up +40% (dev coins
  peak at a median +40% then die); the rest trails 30% from its peak.
  Also exits on creator sell, stall (1,500 slots no trade), net flow
  below −20 SOL / 60 slots, or 30,000 slots held.
- **Breadth:** a pace gate keeps the 20-coin guardrail honest with tiny
  0.01 SOL probes if fills or coins ever lag it.

Pure function of the batches it is fed: no clock, no randomness, no I/O,
no network. Two runs produce byte-identical action logs.

## Measured results (official grader, dev window)

`grade-local --driver process`, run twice, byte-identical action log and
result. Rescue re-run 27 Nov 2026 (identical tree): result `9b9603ba…`,
action log `a8d7b25d…`, L1 reproduced.

- **Hourly Sharpe 0.209**, net PnL **+2.75 SOL** (return +27.5%), Sortino 3.15
- 436 fills, 134 coins, 188 round trips, win rate 15.4%, max drawdown 0.061
- Guardrails compliant; at 2× fees still **+2.36 SOL**
- Robustness on 19 overlapping 6h windows (the final is one unseen 6h
  stretch): median 6h Sharpe **+0.22**, P(6h net PnL > 0) = **12/19**

For comparison, the same engine without the 35% top-buyer cap scores
Sharpe 0.191, net +4.70 SOL — fatter, but its 6h median Sharpe is −0.17
and only 6/19 windows end positive. The cap trades headline PnL for the
shape the bounty actually ranks.

## How it was chosen

- Local simulator reproducing the official grader byte-for-byte (net +4.701
  SOL / Sharpe 0.191075 on the control bot) swept 60+ configurations across
  probe size, entry strictness, stops, per-coin caps, exit shape, hold
  times, an hourly equity governor, hygiene filters and two-stage
  profit-taking. Tighter exits, smaller probes, stricter filters and the
  governor all score lower; the 0.30–0.40 top-buyer band is flat
  (Sharpe 0.195–0.209), so 0.35 is a robust middle, not a tuned peak.
- A sniper variant (buy every newborn coin in its first minute) was built
  and killed by measurement: its apparent 76%-vs-22% take-profit/stop edge
  exists only at the signal trade's own price — 2 slots of fill latency
  later it inverts to 15%-vs-83%.
- Ensemble pre-filter (1/5 judges kept, qwen3.8-27b) ranked this design
  first; the official backtest is the decider.

## Files

- `main.ts` — entrypoint: runs the strategy via the vendored SDK shim.
- `strategy.ts` — the strategy (parameters + decision logic).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts`
  file; excluded from authorship counting by the kit's own shim rule.

## License

MIT — see [LICENSE](LICENSE).
