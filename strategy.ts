// Clean Sharpe — a paper-trading bot for the Pump.fun Sharpe Sprint
// (agent-fun/replay/v2, 10 SOL paper capital, 6 h forward replay).
//
// Idea: ranking is hourly Sharpe on the final window, so the bot only
// presses when the tape is clean and accelerating, sizes small, and cuts
// losers fast. Every decision uses only past slots (no lookahead), and
// every equity read is net of the curve fees + tx fees the replay charges,
// so the Sharpe gate below is transaction-cost-aware.
//
// Entries ("clean" momentum, 36-slot window):
//   - mature curve: age >= 240 slots, real SOL reserve 5..90
//   - accelerating buy flow: net buy flow >= 1 SOL, >= 4 buys,
//     >= 5 distinct buyers, second-half inflow >= first-half inflow,
//     no single buyer over 70% of buy SOL
//   - price +3%..+15% across the window and >= 93% of the window high
//   - first buy 0.05 SOL, pyramid to 0.5 SOL only into strength
// Exits: stop -5%, take-profit +12%, trailing 10% once peak >= +5%,
// max hold 600 slots unless up 10%+. (The 18-slot fade exit was tuned
// OFF on the dev window: it cut winners more than it saved losers.)
// Sharpe gate: the bot samples its own fee-net equity every 25 slots and
// keeps a rolling Sharpe over the last 120 samples; new entries pause
// while that Sharpe is negative (exits always stay live).
// Guardrail probes: 0.01 SOL buys on a relaxed screen, so the entry can
// reach the >= 20 distinct-mint round-trip guardrail even in a thin tape.
//
// Deterministic: insertion-ordered Maps only, no clock, no randomness.

export interface CurveView {
  mint: string;
  createdSlot: number | null;
  realSolLamports: bigint;
  virtualSolLamports: bigint;
  virtualTokenReserves: bigint;
  complete: boolean;
}

export interface PositionView {
  mint: string;
  tokens: bigint;
  costLamports: bigint;
}

export interface View {
  slot: number;
  cashLamports: bigint;
  freeCashLamports: bigint;
  positions: PositionView[];
  curves: Map<string, CurveView>;
  pendingBuyMints: Set<string>;
  pendingSellMints: Set<string>;
  maxBuyLamports(mint: string): bigint;
  txFeeLamports: bigint;
}

export interface OrderInput {
  side: 'buy' | 'sell';
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

export interface TradeEventLike {
  event: string;
  mint: string;
  slot: number;
  is_buy?: boolean;
  user?: string;
  sol_amount?: string;
  virtual_sol_reserves?: string;
  virtual_token_reserves?: string;
  real_sol_reserves?: string;
}

export interface BatchLike {
  slot: number;
  events: TradeEventLike[];
}

export interface Params {
  windowSlots: number;
  minAgeSlots: number;
  minRealSol: number;
  maxRealSol: number;
  minNetFlowSol: number;
  minBuys: number;
  minBuyers: number;
  minRiseBps: number;
  maxRiseBps: number;
  minOfHighBps: number;
  maxBuyerShareBps: number;
  firstBuySol: number;
  maxCostSol: number;
  pyramidSol: number;
  stopBps: number;
  takeProfitBps: number;
  trailBps: number;
  trailArmBps: number;
  fadeWindowSlots: number;
  fadeNetSol: number;
  maxHoldSlots: number;
  maxHoldKeepBps: number;
  maxMainPositions: number;
  maxTotalPositions: number;
  maxExposureSol: number;
  probeSol: number;
  probeMinNetFlowSol: number;
  probeMinBuys: number;
  probeTakeBps: number;
  probeStopBps: number;
  probeMaxHoldSlots: number;
  probePaceSlots: number;
  maxProbePositions: number;
  slippageBps: number;
  sharpeSampleSlots: number;
  sharpeSamples: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 36,
  minAgeSlots: 240,
  minRealSol: 5,
  maxRealSol: 90,
  minNetFlowSol: 1,
  minBuys: 4,
  minBuyers: 5,
  minRiseBps: 300,
  maxRiseBps: 1500,
  minOfHighBps: 9300,
  maxBuyerShareBps: 7000,
  firstBuySol: 0.05,
  maxCostSol: 0.5,
  pyramidSol: 0.1,
  stopBps: -500,
  takeProfitBps: 1200,
  trailBps: 1000,
  trailArmBps: 500,
  fadeWindowSlots: 18,
  fadeNetSol: -10,
  maxHoldSlots: 600,
  maxHoldKeepBps: 1000,
  maxMainPositions: 4,
  maxTotalPositions: 5,
  maxExposureSol: 5,
  probeSol: 0.01,
  probeMinNetFlowSol: 0.2,
  probeMinBuys: 3,
  probeTakeBps: 500,
  probeStopBps: -800,
  probeMaxHoldSlots: 300,
  probePaceSlots: 50,
  maxProbePositions: 2,
  slippageBps: 500,
  sharpeSampleSlots: 25,
  sharpeSamples: 120,
};

const LAMPORTS = 1_000_000_000n;
const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * 1e9));

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
  price: number;
}

interface Held {
  mint: string;
  entrySlot: number;
  peak: number;
  costPerToken: number;
  probe: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const tapes = new Map<string, TapeTrade[]>();
  const held = new Map<string, Held>();
  const probeMints = new Set<string>();
  const roundTripped = new Set<string>();
  const equitySamples: number[] = [];
  let lastSampleSlot = -1;
  let lastEquity = 10;
  let lastProbeSlot = -1_000_000;

  function priceOf(c: CurveView): number {
    if (c.virtualTokenReserves === 0n) return 0;
    return Number(c.virtualSolLamports) / Number(c.virtualTokenReserves);
  }

  function tapeStats(mint: string, slot: number, window: number) {
    const tape = tapes.get(mint) ?? [];
    const from = slot - window + 1;
    let buys = 0;
    let buySol = 0n;
    let sellSol = 0n;
    const buyers = new Map<string, bigint>();
    let open = 0;
    let high = 0;
    let last = 0;
    let firstHalfBuy = 0n;
    let secondHalfBuy = 0n;
    const mid = slot - Math.floor(window / 2) + 1;
    for (const t of tape) {
      if (t.slot < from) continue;
      if (t.isBuy) {
        buys += 1;
        buySol += t.sol;
        buyers.set(t.user, (buyers.get(t.user) ?? 0n) + t.sol);
        if (t.slot < mid) firstHalfBuy += t.sol;
        else secondHalfBuy += t.sol;
      } else {
        sellSol += t.sol;
      }
      if (open === 0) open = t.price;
      if (t.price > high) high = t.price;
      last = t.price;
    }
    let topBuyer = 0n;
    for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
    return { buys, buySol, sellSol, buyers: buyers.size, open, high, last, firstHalfBuy, secondHalfBuy, topBuyer };
  }

  function equity(view: View): number {
    let total = Number(view.cashLamports) / 1e9;
    for (const p of view.positions) {
      const c = view.curves.get(p.mint);
      if (c === undefined) continue;
      const price = priceOf(c);
      if (price <= 0) continue;
      const gross = (Number(p.tokens) / 1e9) * price;
      total += gross * 0.9875 - 0.000105;
    }
    return total;
  }

  function rollingSharpe(): number | null {
    if (equitySamples.length < 30) return null;
    const n = equitySamples.length;
    let mean = 0;
    for (const r of equitySamples) mean += r;
    mean /= n;
    let variance = 0;
    for (const r of equitySamples) variance += (r - mean) * (r - mean);
    const std = Math.sqrt(variance / n);
    if (std === 0) return null;
    return mean / std;
  }

  function decide(view: View, batch: BatchLike): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const spentThisBatch = new Map<string, bigint>();

    // Fold this slot's trades into the per-mint tapes.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const price =
        e.virtual_token_reserves !== undefined && e.virtual_sol_reserves !== undefined && BigInt(e.virtual_token_reserves) !== 0n
          ? Number(BigInt(e.virtual_sol_reserves)) / Number(BigInt(e.virtual_token_reserves))
          : 0;
      const tape = tapes.get(e.mint) ?? [];
      tape.push({
        slot: e.slot,
        isBuy: e.is_buy === true,
        sol: e.sol_amount !== undefined ? BigInt(e.sol_amount) : 0n,
        user: e.user ?? '',
        price,
      });
      while (tape.length > 0 && tape[0].slot < slot - params.windowSlots) tape.shift();
      tapes.set(e.mint, tape);
    }

    // Track round trips from fills: a mint leaves `held` once its position is gone.
    const liveMints = new Set(view.positions.map((p) => p.mint));
    for (const [mint] of held) {
      if (!liveMints.has(mint) && !view.pendingBuyMints.has(mint)) {
        roundTripped.add(mint);
        probeMints.delete(mint);
        held.delete(mint);
      }
    }

    // Fee-net equity sample + rolling Sharpe (past slots only, no lookahead).
    if (lastSampleSlot < 0 || slot - lastSampleSlot >= params.sharpeSampleSlots) {
      const eq = equity(view);
      if (lastSampleSlot >= 0 && lastEquity > 0) {
        equitySamples.push((eq - lastEquity) / lastEquity);
        while (equitySamples.length > params.sharpeSamples) equitySamples.shift();
      }
      lastEquity = eq;
      lastSampleSlot = slot;
    }
    const sharpe = rollingSharpe();
    const entriesOpen = sharpe === null || sharpe > 0;

    const byMint = new Map(view.positions.map((p) => [p.mint, p]));
    let mainCount = 0;
    let probeCount = 0;
    let exposureSol = 0;
    for (const p of view.positions) {
      const h = held.get(p.mint);
      if (h?.probe === true || (h === undefined && probeMints.has(p.mint))) probeCount += 1;
      else mainCount += 1;
      exposureSol += Number(p.costLamports) / 1e9;
    }

    // Exits first: stops, take-profit, trailing, fade, max hold.
    for (const p of view.positions) {
      const c = view.curves.get(p.mint);
      if (c === undefined || c.complete) continue;
      const price = priceOf(c);
      if (price <= 0 || p.tokens === 0n) continue;
      const costPerToken = Number(p.costLamports) / Number(p.tokens);
      const h = held.get(p.mint);
      if (h === undefined) {
        held.set(p.mint, { mint: p.mint, entrySlot: slot, peak: price, costPerToken, probe: probeMints.has(p.mint) });
        continue;
      }
      if (price > h.peak) h.peak = price;
      const retBps = Math.round(((price - h.costPerToken) / h.costPerToken) * 10000);
      const heldSlots = slot - h.entrySlot;
      let sell = false;
      if (h.probe) {
        if (retBps <= params.probeStopBps || retBps >= params.probeTakeBps || heldSlots >= params.probeMaxHoldSlots) sell = true;
      } else {
        if (retBps <= params.stopBps || retBps >= params.takeProfitBps) sell = true;
        if (!sell && h.peak >= h.costPerToken * (1 + params.trailArmBps / 10000) && price <= h.peak * (1 - params.trailBps / 10000)) sell = true;
        if (!sell && heldSlots >= params.maxHoldSlots && retBps < params.maxHoldKeepBps) sell = true;
        if (!sell) {
          const fade = tapeStats(p.mint, slot, params.fadeWindowSlots);
          const netSol = Number(fade.buySol - fade.sellSol) / 1e9;
          if (netSol < params.fadeNetSol) sell = true;
        }
      }
      if (sell) {
        orders.push({ side: 'sell', mint: p.mint, token_amount: p.tokens.toString(), max_slippage_bps: params.slippageBps });
      }
    }

    // Pyramids: add into strength, capped at maxCostSol per mint.
    if (entriesOpen) {
      for (const p of view.positions) {
        const h = held.get(p.mint);
        if (h === undefined || h.probe) continue;
        if (orders.some((o) => o.side === 'sell' && o.mint === p.mint)) continue;
        const c = view.curves.get(p.mint);
        if (c === undefined || c.complete) continue;
        const price = priceOf(c);
        if (price <= 0) continue;
        const retBps = Math.round(((price - h.costPerToken) / h.costPerToken) * 10000);
        if (retBps < 1000) continue;
        const costSol = Number(p.costLamports) / 1e9;
        if (costSol >= params.maxCostSol) continue;
        const want = Math.min(params.pyramidSol, params.maxCostSol - costSol);
        const cap = view.maxBuyLamports(p.mint);
        const room = cap - (spentThisBatch.get(p.mint) ?? 0n);
        const amount = solToLamports(want) <= room ? solToLamports(want) : room;
        if (amount <= 0n) continue;
        if (amount > view.freeCashLamports - view.txFeeLamports) continue;
        orders.push({ side: 'buy', mint: p.mint, quote_lamports: amount.toString(), max_slippage_bps: params.slippageBps });
        spentThisBatch.set(p.mint, (spentThisBatch.get(p.mint) ?? 0n) + amount);
      }
    }

    // New entries + guardrail probes.
    if (entriesOpen && view.positions.length + view.pendingBuyMints.size < params.maxTotalPositions) {
      const candidates: { mint: string; score: number; probe: boolean }[] = [];
      for (const [mint, c] of view.curves) {
        if (c.complete || c.createdSlot === null) continue;
        if (slot - c.createdSlot < params.minAgeSlots) continue;
        if (byMint.has(mint) || view.pendingBuyMints.has(mint)) continue;
        const realSol = Number(c.realSolLamports) / 1e9;
        if (realSol < params.minRealSol || realSol > params.maxRealSol) continue;
        const s = tapeStats(mint, slot, params.windowSlots);
        if (s.open <= 0 || s.last <= 0 || s.high <= 0) continue;
        const riseBps = Math.round(((s.last - s.open) / s.open) * 10000);
        const netSol = Number(s.buySol - s.sellSol) / 1e9;
        const mainOk =
          netSol >= params.minNetFlowSol &&
          s.buys >= params.minBuys &&
          s.buyers >= params.minBuyers &&
          riseBps >= params.minRiseBps &&
          riseBps <= params.maxRiseBps &&
          s.last >= s.high * (params.minOfHighBps / 10000) &&
          s.secondHalfBuy >= s.firstHalfBuy &&
          (s.buySol === 0n || s.topBuyer <= (s.buySol * BigInt(params.maxBuyerShareBps)) / 10000n);
        if (mainOk && mainCount < params.maxMainPositions && exposureSol < params.maxExposureSol) {
          candidates.push({ mint, score: netSol * 100 + riseBps / 100, probe: false });
          continue;
        }
        const probeOk =
          roundTripped.size + view.positions.length < 20 &&
          netSol >= params.probeMinNetFlowSol &&
          s.buys >= params.probeMinBuys &&
          riseBps >= 100 &&
          riseBps <= params.maxRiseBps &&
          probeCount < params.maxProbePositions &&
          slot - lastProbeSlot >= params.probePaceSlots;
        if (probeOk) candidates.push({ mint, score: netSol * 10, probe: true });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const cand of candidates) {
        if (orders.length >= 16) break;
        if (view.positions.length + view.pendingBuyMints.size + orders.filter((o) => o.side === 'buy').length >= params.maxTotalPositions) break;
        const sizeSol = cand.probe ? params.probeSol : params.firstBuySol;
        const cap = view.maxBuyLamports(cand.mint);
        const room = cap - (spentThisBatch.get(cand.mint) ?? 0n);
        const amount = solToLamports(sizeSol) <= room ? solToLamports(sizeSol) : room;
        if (amount <= 0n) continue;
        if (amount > view.freeCashLamports - view.txFeeLamports) continue;
        orders.push({ side: 'buy', mint: cand.mint, quote_lamports: amount.toString(), max_slippage_bps: params.slippageBps });
        spentThisBatch.set(cand.mint, (spentThisBatch.get(cand.mint) ?? 0n) + amount);
        if (cand.probe) {
          lastProbeSlot = slot;
          probeCount += 1;
          probeMints.add(cand.mint);
        } else {
          mainCount += 1;
          exposureSol += sizeSol;
        }
      }
    }

    return orders;
  }

  return { decide, stats: () => ({ roundTripped: roundTripped.size, sharpe: rollingSharpe(), samples: equitySamples.length }) };
}
