# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/aben00/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/aben00/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on [make.fun](https://make.fun/?ref=bh1grvtt&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).

## What it does

The bot trades 10 SOL of virtual money on a 6-hour replay of pump.fun bonding-curve activity, over the `agent-fun/replay/v2` protocol (NDJSON on stdin/stdout: `hello` → one `batch` per slot → `done`, exactly one JSON reply per batch echoing the batch `seq`).

Ranking is by **hourly Sharpe ratio**, not net PnL — and the final window is only six hours, so the strategy optimises for *steady* instead of *big*:

- **Equal small stakes** — every entry is 0.05 SOL, so no single coin can dominate an hour's equity mark.
- **Hour pacing** — buys are capped per hour bucket (counted in slots from the first slot seen), so activity spreads evenly across the window instead of front-loading into hour one and sitting flat.
- **Fast exits** — take profit at +30%, stop loss at −12%, a trailing stop once a position peaks at +15%, and a stale exit for positions that go nowhere. Wins are banked before a pump coin retraces, losers are cut early, keeping each hour's return small and mostly positive.
- **Guardrail probes** — a looser second pass buys 0.02 SOL of merely buy-led coins, purely to bank round trips of ≥ 0.01 SOL on ≥ 20 distinct mints inside the short window.

## How it works

`main.ts` (Node 22, zero dependencies, TypeScript run directly) uses the kit SDK at `vendor/makefun-bot.ts` via `runBot({ onHello, onBatch, onDone })`:

1. **Exits first** — every batch starts by checking held positions against the take-profit / stop-loss / trailing / stale rules, so freed slots and cash are visible to the entry passes.
2. **Tape folding** — the batch's `CreateEvent` / `TradeEvent` / `CompleteEvent` records are folded into a per-coin flow (buy vs sell volume and count, distinct buyers, window-high virtual price), in chain order.
3. **Strict entries** — young (≤ 4,000 slots), buy-led (buy volume ≥ 3× sell volume, ≥ 10 distinct buyers, ≥ 25 trades), real SOL reserve between 2 and 60, price still ≥ 95% of its window high.
4. **Probe entries** — looser gates for coverage, as above.

All money math is `BigInt` lamports; all price comparisons are bigint cross-multiplication, never floats. The bot is fully deterministic: no clock, no `Math.random`, no environment, no network, and Map iteration follows insertion order — two runs produce byte-identical action logs. The only sanctioned randomness, `hello.seed`, is deliberately unused.

## Files

- `main.ts` — the bot (entrypoint, run as `node main.ts`)
- `vendor/makefun-bot.ts` — the kit SDK, copied unchanged
- `.makefun/owner.json` — entry ownership claim
- `LICENSE` — MIT

## Competition

- **Bounty:** https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
- **Prize:** $2.00 total (1st $1.00 / 2nd $0.60 / 3rd $0.40), paid only to entries with net PnL > 0 SOL
- **Deadline:** 2026-11-28T17:00:00Z · **Final window:** 2026-11-28T17:00–23:00Z · **Results due:** 2026-12-12T23:00:00Z

---

Built for the make.fun bounty — see https://make.fun/?ref=bh1grvtt&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
