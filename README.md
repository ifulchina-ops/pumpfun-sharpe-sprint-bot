[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ifulchina-ops/pumpfun-sharpe-sprint-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ifulchina-ops/pumpfun-sharpe-sprint-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean Sharpe — Pump.fun Sharpe Sprint

A paper-trading bot for the
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
competition on [make.fun](https://make.fun). It paper-trades pump.fun
bonding curves on a replayed 6-hour window; no real funds are ever
involved. Places go by hourly Sharpe ratio, so the bot optimises for
steady, controlled gains — not one lucky moonshot.

## Strategy

- **Clean momentum entries:** a curve must be mature (age 240+ slots,
  real SOL 5–90) with accelerating buy flow over a 36-slot window —
  net flow 1+ SOL, 4+ buys, 5+ distinct buyers, second-half inflow at
  least first-half, no buyer over 70% of buy SOL — and price up 3–80%
  while holding 93%+ of the window high.
- **Small sizing:** first buy 0.05 SOL, pyramid to 0.5 SOL only into
  strength, max 4 main positions, max 5 SOL exposure.
- **Fast exits:** stop −5%, take-profit +12%, trailing 10% once the
  peak is +5%, max hold 600 slots unless up 10%+. The fade exit was
  tuned off on the dev window — it cut winners more than it saved
  losers.
- **Clean Sharpe gate:** the bot samples its own fee-net equity every
  25 slots and keeps a rolling Sharpe over the last 120 samples; new
  entries pause while that Sharpe is negative. Exits always stay live.
- **Guardrail probes:** 0.01 SOL buys on a relaxed screen, paced, so
  the entry can reach the 20-distinct-mint round-trip guardrail even
  when the tape is thin.

## Determinism

The bot never reads the clock, the environment, or `Math.random`. Every
decision is a pure function of the `hello` caps and the `batch` stream,
so two grading runs produce identical action logs.

## Layout

- `main.ts` — entrypoint: speaks the `agent-fun/replay/v2` JSON-lines
  protocol on stdin/stdout (Node 22, run as `node main.ts`). No vendor
  shim — the wire layer is implemented directly in this file.
- `strategy.ts` — the Clean Sharpe strategy (entries, exits, probes,
  Sharpe gate).
- `.makefun/owner.json` — the payout wallet claim file.

## License

0BSD — see [LICENSE](LICENSE).
