// Clean Sharpe — entrypoint for agent-fun/replay/v2.
//
// The grader runs `node /bot/main.ts`. This file speaks the replay
// protocol directly on stdin/stdout (JSON lines: hello, batch, done) and
// hands every batch to the strategy in strategy.ts. No vendor shim: the
// whole wire layer is the ~200 lines below, which keeps the entry tree
// small and every line authored here.
//
// Protocol recap (from the kit docs):
//   - hello: protocol 'agent-fun/replay/v2', capital, caps, fees, latency.
//   - batch: seq, slot, events (this slot's universe events), marks,
//     fills (orders resolved since the last batch), account.
//   - reply: exactly one per batch, { type: 'reply', seq, orders }.
//     Orders decided on slot s fill at slot s + latency_slots.
//   - done: final account, positions already flattened; no reply.
// Orders: buy { side, mint, quote_lamports, max_slippage_bps }, sell
// { side, mint, token_amount, max_slippage_bps }; client_id 1-64 chars
// of [A-Za-z0-9_-], never starting with '_' (the harness reserves that).
// Buys on one mint in one reply may spend at most
// caps.max_order_bps_of_real_reserve of that mint's real SOL reserve.

import { createStrategy, DEFAULT_PARAMS, type CurveView, type OrderInput, type View } from './strategy.ts';

const PROTOCOL = 'agent-fun/replay/v2';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;

interface Hello {
  type: 'hello';
  protocol: string;
  capital: { lamports: string };
  caps: { max_open_positions: number; max_order_bps_of_real_reserve: number; max_orders_per_batch: number };
  latency_slots: number;
  fees: { base_fee_lamports: string; priority_fee_lamports: string };
}

interface ChainEvent {
  event: string;
  mint: string;
  slot: number;
  is_buy?: boolean;
  user?: string;
  sol_amount?: string;
  virtual_sol_reserves?: string;
  virtual_token_reserves?: string;
  real_sol_reserves?: string;
  real_token_reserves?: string;
}

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

interface Fill {
  client_id: string;
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: string; positions: { mint: string; token_amount: string; cost_lamports: string }[] };
}

interface CurveState extends CurveView {
  reservesSlot: number;
}

class Runner {
  private hello: Hello | null = null;
  private curves = new Map<string, CurveState>();
  private pending = new Map<string, OrderInput & { client_id: string }>();
  private nextId = 1;
  private strategy = createStrategy(DEFAULT_PARAMS);

  private clientId(): string {
    for (;;) {
      const id = `o${this.nextId++}`;
      if (!this.pending.has(id)) return id;
    }
  }

  private txFee(): bigint {
    const h = this.hello as Hello;
    return BigInt(h.fees.base_fee_lamports) + BigInt(h.fees.priority_fee_lamports);
  }

  private foldBatch(batch: Batch): View {
    const hello = this.hello as Hello;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reservesSlot) continue;
      const curve: CurveState =
        c ??
        ({
          mint: m.mint,
          createdSlot: null,
          realSolLamports: 0n,
          virtualSolLamports: 0n,
          virtualTokenReserves: 0n,
          complete: false,
          reservesSlot: m.slot,
        } as CurveState);
      curve.virtualTokenReserves = BigInt(m.virtual_token_reserves);
      curve.virtualSolLamports = BigInt(m.virtual_quote_reserves);
      curve.realSolLamports = BigInt(m.real_quote_reserves);
      curve.reservesSlot = m.slot;
      this.curves.set(m.mint, curve);
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve: CurveState = {
          mint: e.mint,
          createdSlot: e.slot,
          realSolLamports: 0n,
          virtualSolLamports: BigInt(e.virtual_sol_reserves ?? '0'),
          virtualTokenReserves: BigInt(e.virtual_token_reserves ?? '0'),
          complete: false,
          reservesSlot: e.slot,
        };
        this.curves.set(e.mint, curve);
      } else if (e.event === 'TradeEvent') {
        const curve =
          this.curves.get(e.mint) ??
          ({
            mint: e.mint,
            createdSlot: null,
            realSolLamports: 0n,
            virtualSolLamports: 0n,
            virtualTokenReserves: 0n,
            complete: false,
            reservesSlot: e.slot,
          } as CurveState);
        curve.virtualSolLamports = BigInt(e.virtual_sol_reserves ?? '0');
        curve.virtualTokenReserves = BigInt(e.virtual_token_reserves ?? '0');
        curve.realSolLamports = BigInt(e.real_sol_reserves ?? '0');
        curve.reservesSlot = e.slot;
        this.curves.set(e.mint, curve);
      } else if (e.event === 'CompleteEvent') {
        const curve = this.curves.get(e.mint);
        if (curve !== undefined) curve.complete = true;
      }
    }
    const cash = BigInt(batch.account.cash_lamports);
    let free = cash;
    const pendingBuyMints = new Set<string>();
    const pendingSellMints = new Set<string>();
    for (const p of this.pending.values()) {
      free -= this.txFee();
      if (p.side === 'buy') {
        free -= BigInt(p.quote_lamports ?? '0');
        pendingBuyMints.add(p.mint);
      } else {
        pendingSellMints.add(p.mint);
      }
    }
    const view: View = {
      slot: batch.slot,
      cashLamports: cash,
      freeCashLamports: free,
      positions: batch.account.positions.map((p) => ({ mint: p.mint, tokens: BigInt(p.token_amount), costLamports: BigInt(p.cost_lamports) })),
      curves: this.curves,
      pendingBuyMints,
      pendingSellMints,
      txFeeLamports: this.txFee(),
      maxBuyLamports: (mint: string): bigint => {
        const c = this.curves.get(mint);
        if (c === undefined || c.complete) return 0n;
        return (c.realSolLamports * BigInt(hello.caps.max_order_bps_of_real_reserve)) / BPS;
      },
    };
    return view;
  }

  private toWireOrders(orders: OrderInput[], seq: number): { side: string; client_id: string; mint: string; quote_lamports?: string; token_amount?: string; max_slippage_bps: number }[] {
    const hello = this.hello as Hello;
    if (orders.length > hello.caps.max_orders_per_batch) {
      throw new Error(`batch ${seq}: ${orders.length} orders over cap ${hello.caps.max_orders_per_batch}`);
    }
    const out = [];
    for (const o of orders) {
      if (o.side !== 'buy' && o.side !== 'sell') throw new Error(`batch ${seq}: bad side`);
      if (!PUBKEY_RE.test(o.mint)) throw new Error(`batch ${seq}: bad mint`);
      const amount = o.side === 'buy' ? o.quote_lamports : o.token_amount;
      if (amount === undefined || !U64_RE.test(amount) || BigInt(amount) === 0n) throw new Error(`batch ${seq}: bad amount`);
      if (!Number.isInteger(o.max_slippage_bps) || o.max_slippage_bps < 0 || o.max_slippage_bps > 10_000) {
        throw new Error(`batch ${seq}: bad slippage`);
      }
      const client_id = this.clientId();
      if (!CLIENT_ID_RE.test(client_id)) throw new Error(`batch ${seq}: bad client_id`);
      const wire = o.side === 'buy'
        ? { side: 'buy' as const, client_id, mint: o.mint, quote_lamports: amount, max_slippage_bps: o.max_slippage_bps }
        : { side: 'sell' as const, client_id, mint: o.mint, token_amount: amount, max_slippage_bps: o.max_slippage_bps };
      this.pending.set(client_id, { ...o, client_id });
      out.push(wire);
    }
    return out;
  }

  async run(): Promise<void> {
    let buffer = '';
    for await (const chunk of process.stdin) {
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== '') this.handleLine(line);
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.trim() !== '') this.handleLine(buffer);
    if (this.hello === null) throw new Error('input ended before hello');
  }

  private handleLine(line: string): void {
    let msg: { type?: unknown };
    try {
      msg = JSON.parse(line) as { type?: unknown };
    } catch {
      throw new Error('input line is not JSON');
    }
    if (msg.type === 'hello') {
      const hello = msg as unknown as Hello;
      if (this.hello !== null) throw new Error('a second hello');
      if (hello.protocol !== PROTOCOL) throw new Error(`harness speaks ${hello.protocol}; this bot speaks ${PROTOCOL}`);
      this.hello = hello;
    } else if (msg.type === 'batch') {
      if (this.hello === null) throw new Error('a batch before hello');
      const batch = msg as unknown as Batch;
      const view = this.foldBatch(batch);
      const orders = this.strategy.decide(view, { slot: batch.slot, events: batch.events });
      const wire = this.toWireOrders(orders, batch.seq);
      process.stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders: wire })}\n`);
    } else if (msg.type === 'done') {
      process.exit(0);
    } else {
      throw new Error(`unknown message type ${String(msg.type)}`);
    }
  }
}

void LAMPORTS_PER_SOL;
await new Runner().run();
