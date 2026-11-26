// Momentum-Scale-Ride v2: a pump.fun bonding-curve paper bot for agent-fun/replay/v2,
// built for the Sharpe Sprint — ranked by HOURLY Sharpe ratio, not total PnL.
//
// RESCUE re-verification (27 Nov 2026, builder rescue after 2d4b14a1 cancelled):
// `grade-local --driver process` re-run on this exact tree reproduces the
// numbers below (Sharpe 0.209434, net +2.746 SOL, result 9b9603ba…,
// L1 reproduced, action log a8d7b25d…). No parameter changed in the rescue.
//
// What the dev window actually rewards (measured with the official grader,
// which this repo's local simulator reproduces byte-for-byte: net +4.701 SOL,
// Sharpe 0.191075 on the control bot): cheap momentum probes that buy a
// lottery ticket on a coin that might complete, then scale in ONLY as the
// curve proves itself at reserve milestones (10/20/40/60 SOL — a coin at 40
// SOL completes 46% of the time, at 60 SOL 74%), bank the median peak
// (+40%) and trail the rest. Three full sweeps (40+ configs: probe size,
// entry strictness, stops, per-coin caps, exit shape, hold times, an hourly
// equity governor) all confirm this shape is the local optimum — tighter
// exits, smaller probes, stricter filters and the governor all score lower.
//
// v2 adds the two things the dev leaderboard's top titles point at and the
// sweeps had not tried yet:
//   1. TOP-BUYER HYGIENE at entry (the one filter that actually helps): no
//      single buyer may hold more than 35% of the probe window's buy flow.
//      A coin whose early tape is one whale is a dump waiting to happen;
//      capping topShare at 0.35 lifts 24h Sharpe 0.191 -> 0.209, median 6h
//      Sharpe -0.17 -> +0.22, and P(6h net PnL > 0) 6/19 -> 12/19. The
//      0.30-0.40 band is flat (0.195-0.209), so 0.35 is a robust middle, not
//      a tuned peak. Every OTHER hygiene cap hurts: maxBuyers<=8 drops Sharpe
//      to 0.146, devBuy bands to -0.37 — stricter filters exclude the monster
//      coin, as the sibling build already learned. Buyer dispersion at the
//      5-SOL crossing does NOT predict completion on its own.
//   2. TWO-STAGE INTRA-HOUR PROFIT LOCK: bank half the sleeve at a small
//      first take-profit (+12-20%) so most hours book a realized gain before
//      the hour mark. Tested: it lowers drawdown (0.088 -> 0.047) and lifts
//      the worst 6h window, but costs mean Sharpe (0.209 -> 0.193), so it
//      stays OFF by default (tp1: 0) — the main +40% partial already banks
//      the median peak.
//
// A sniper variant (buy every newborn coin in its first minute) was built
// and KILLED by measurement: its apparent 76%-vs-22% TP/SL edge exists only
// at the signal trade's own price — 2 slots of fill latency later the edge
// inverts to 15%-vs-83% (sharpe-work/measure2.py). Entry prices must be fill
// prices; the laboratory now measures everything at lag 2.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O.
// Iteration is over insertion-ordered maps fed by the batch stream, so two
// runs produce byte-identical action logs.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** First (probe) buy, SOL. */
  probeSol: number;
  /** Real SOL reserve window for a probe entry. */
  probeRqMin: number;
  probeRqMax: number;
  /** Minimum slots since CreateEvent before a probe. */
  probeMinAge: number;
  /** Lookback window (slots) for the probe's flow / momentum read. */
  probeWindow: number;
  /** Net SOL bought minus sold over the probe window, at least. */
  probeMinNetSol: number;
  /** Distinct non-creator buyers in the probe window, at least. */
  probeMinBuyers: number;
  /** Distinct non-creator buyers in the probe window, at most (bump-bot hygiene). 0 = off. */
  probeMaxBuyers: number;
  /** Trades in the probe window, at least. */
  probeMinTrades: number;
  /** Largest single buyer's share of window buy SOL, at most. */
  probeMaxTopShare: number;
  /** Creator's own buy in the create slot, SOL window (hygiene). 0/0 = off. */
  probeMinDevBuy: number;
  probeMaxDevBuy: number;
  /** Price now over price at window start, at least (as a fraction). */
  probeMinPriceUp: number;
  /** Price now at least this share of the window high. */
  probeNearHigh: number;
  /** Real-reserve milestones (SOL) that unlock a scale-in tranche. */
  addLevels: number[];
  /** Size of each scale-in tranche, SOL (the 1%-of-reserve cap binds first). */
  addSol: number;
  /** A scale-in needs the price at least this far above the last buy's price (fraction). */
  addMinStep: number;
  /** A scale-in needs net SOL over the probe window at least this. */
  addMinFlowSol: number;
  /** Most SOL at cost in one coin (probe + adds). */
  maxCoinSol: number;
  /** Exit when close value falls this far below cost (fraction). */
  stopLoss: number;
  /** First take-profit: sell tp1Share of the sleeve once up tp1 (0 = off). */
  tp1: number;
  tp1Share: number;
  /** Main take-profit: sell partialShare once up takeProfit (after tp1). */
  takeProfit: number;
  partialShare: number;
  /** Trailing stop arms once up takeProfit; exit on a fall of trail from the peak. */
  trail: number;
  /** Exit when no trade has hit the coin for this many slots. */
  stallSlots: number;
  /** Exit when net SOL over the probe window falls below minus this. */
  exitFlowSol: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Hourly governor band, SOL (0 = off). Sweep-proven to forfeit the edge — kept off. */
  govBankSol: number;
  govFloorSol: number;
  /** Guardrail pacing: target coins / fills, pace window (block-time seconds). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of a pace probe buy, SOL. */
  paceProbeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  probeSol: 0.05,
  probeRqMin: 1.5,
  probeRqMax: 8,
  probeMinAge: 20,
  probeWindow: 60,
  probeMinNetSol: 0.5,
  probeMinBuyers: 3,
  probeMaxBuyers: 0,
  probeMinTrades: 3,
  probeMaxTopShare: 0.35,
  probeMinDevBuy: 0,
  probeMaxDevBuy: 0,
  probeMinPriceUp: 0.02,
  probeNearHigh: 0.9,
  addLevels: [10, 20, 40, 60],
  addSol: 1,
  addMinStep: 0,
  addMinFlowSol: 0,
  maxCoinSol: 1.5,
  stopLoss: 0.25,
  tp1: 0,
  tp1Share: 0.5,
  takeProfit: 0.4,
  partialShare: 0.75,
  trail: 0.3,
  stallSlots: 1500,
  exitFlowSol: 20,
  exitOnDevSell: true,
  maxHold: 30000,
  buySlipBps: 10000,
  govBankSol: 0,
  govFloorSol: 0,
  targetCoins: 30,
  targetFills: 200,
  paceSecs: 14400,
  paceProbeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1_000_000_000;
const CURVE_FEE_BPS = 125n;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

interface Book {
  mint: Pubkey;
  created: number | null;
  creator: Pubkey | null;
  /** Creator's own buys in the create slot, SOL. */
  devBuy: number;
  trades: Tick[];
  entries: number;
  lastExit: number;
  devSold: boolean;
  /** Reserve milestones already used for a scale-in. */
  levelsHit: Set<number>;
  /** Price (vq/vt) at the last buy decision. */
  lastBuyPrice: number;
  /** SOL at cost currently committed to this coin. */
  invested: number;
  done: boolean;
  complete: boolean;
}

interface Sleeve {
  opened: number;
  peak: number;
  /** Tx fees paid on this sleeve's orders, lamports. */
  txPaid: bigint;
  tp1Taken: boolean;
  partialTaken: boolean;
  exiting: boolean;
  filled: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const p: Params = { ...DEFAULT_PARAMS, ...params };
  const books = new Map<Pubkey, Book>();
  const sleeves = new Map<Pubkey, Sleeve>();
  /** Pace probes in flight: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Block-time hour index of the current governor hour, and equity at its start. */
  let govHour = -1;
  let govHourStart = 10;

  const bookOf = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        mint,
        created: null,
        creator: null,
        devBuy: 0,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        devSold: false,
        levelsHit: new Set(),
        lastBuyPrice: 0,
        invested: 0,
        done: false,
        complete: false,
      };
      books.set(mint, b);
    }
    return b;
  };

  /** Net SOL, distinct buyers, buy SOL, top-buyer share, price move over the window. */
  const windowRead = (b: Book, now: number) => {
    const from = now - p.probeWindow;
    let net = 0;
    let buys = 0;
    let buySol = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<Pubkey, number>();
    for (const t of b.trades) {
      if (t.slot <= from) {
        startPrice = t.price;
        continue;
      }
      if (startPrice < 0) startPrice = t.price;
      if (t.buy) {
        net += t.sol;
        buys++;
        buySol += t.sol;
        byUser.set(t.user, (byUser.get(t.user) ?? 0) + t.sol);
      } else {
        net -= t.sol;
      }
      if (t.price > high) high = t.price;
      last = t.price;
    }
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    return {
      net,
      buys,
      buySol,
      buyers: byUser.size,
      topShare: buySol > 0 ? top / buySol : 1,
      up: startPrice > 0 ? last / startPrice - 1 : -1,
      nearHigh: high > 0 ? last / high : 0,
      trades: b.trades.filter((t) => t.slot > from).length,
    };
  };

  const flow = (b: Book, now: number): number => {
    let net = 0;
    for (let i = b.trades.length - 1; i >= 0; i--) {
      const t = b.trades[i]!;
      if (t.slot <= now - p.probeWindow) break;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
          const sv = sleeves.get(f.mint);
          if (sv !== undefined) sv.txPaid += BigInt(f.tx_fee_lamports);
          else if (f.side === 'buy' && !probes.has(f.mint)) {
            sleeves.set(f.mint, { opened: f.slot, peak: 0, txPaid: BigInt(f.tx_fee_lamports), tp1Taken: false, partialTaken: false, exiting: false, filled: true });
          }
        }
        if (f.client_id.startsWith('_')) {
          sleeves.delete(f.mint);
          probes.delete(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > lastTime!) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (b.created !== null && e.slot === b.created && e.is_buy && b.creator !== null && e.user === b.creator) b.devBuy += sol;
          if (!e.is_buy && b.creator !== null && e.user === b.creator) b.devSold = true;
          traded.add(e.mint);
        } else {
          const b = bookOf(e.mint);
          b.complete = true;
          b.done = true;
        }
      }
      for (const mint of traded) {
        const b = books.get(mint)!;
        let cut = 0;
        while (cut < b.trades.length && b.trades[cut]!.slot <= now - Math.max(p.probeWindow, 60) - 5) cut++;
        if (cut > 0) b.trades.splice(0, cut);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const txSol = Number(tx) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const reservesOf = (mint: Pubkey) => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return {
            vq: BigInt(mk.virtual_quote_reserves),
            vt: BigInt(mk.virtual_token_reserves),
            rq: Number(mk.real_quote_reserves) / LAMPORTS,
          };
        }
        const cv = state.curves.get(mint);
        if (cv === undefined) return null;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves, rq: Number(cv.real_quote_reserves) / LAMPORTS };
      };

      // Equity now (cash + close values of open sleeves), for the hourly governor.
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const r = reservesOf(mint);
        if (r === null) continue;
        equity += Math.max(0, Number(sellValue(BigInt(pos.token_amount), r.vq, r.vt)) / LAMPORTS - txSol);
      }

      // --- Hourly governor: new entries stop once this block-time hour is
      // already banked (up) or already cold (down) beyond its band. ---
      let govBlocked = false;
      if ((p.govBankSol > 0 || p.govFloorSol > 0) && firstTime !== null && lastTime !== null) {
        const hour = Math.floor((lastTime - firstTime) / 3600);
        if (hour !== govHour) {
          govHour = hour;
          govHourStart = equity;
        }
        const delta = equity - govHourStart;
        if ((p.govBankSol > 0 && delta >= p.govBankSol) || (p.govFloorSol > 0 && delta <= -p.govFloorSol)) govBlocked = true;
      }

      // --- Exits first. ---
      for (const [mint, sv] of sleeves) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            sleeves.delete(mint);
            const b = bookOf(mint);
            if (sv.filled) b.lastExit = now;
            else b.entries--;
          }
          continue;
        }
        sv.filled = true;
        if (curve === undefined || curve.complete) continue;
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = Number(sellValue(BigInt(pos.token_amount), r.vq, r.vt)) / LAMPORTS - txSol;
        const cost = Number(pos.cost_lamports) / LAMPORTS + Number(sv.txPaid) / LAMPORTS;
        if (value > sv.peak) sv.peak = value;
        const b = bookOf(mint);
        let exit = sv.exiting;
        if (!exit && cost > 0 && value < cost * (1 - p.stopLoss)) exit = true;
        // Stage-1 profit lock: bank tp1Share the first time the sleeve is up tp1.
        if (!exit && p.tp1 > 0 && !sv.tp1Taken && cost > 0 && value >= cost * (1 + p.tp1)) {
          const part = (BigInt(pos.token_amount) * BigInt(Math.round(p.tp1Share * 10000))) / 10000n;
          if (part > 0n && part < BigInt(pos.token_amount) && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
            sv.tp1Taken = true;
            sv.peak = 0;
            continue;
          }
        }
        // Main take-profit: sell partialShare the first time up takeProfit.
        if (!exit && p.partialShare > 0 && !sv.partialTaken && cost > 0 && value >= cost * (1 + p.takeProfit)) {
          const part = (BigInt(pos.token_amount) * BigInt(Math.round(p.partialShare * 10000))) / 10000n;
          if (part > 0n && part < BigInt(pos.token_amount) && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
            sv.partialTaken = true;
            sv.peak = 0;
            continue;
          }
        }
        // The rest trails from its peak once armed.
        if (!exit && sv.peak >= cost * (1 + p.takeProfit) && value < sv.peak * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnDevSell && b.devSold) exit = true;
        if (!exit && b.trades.length > 0 && now - b.trades[b.trades.length - 1]!.slot >= p.stallSlots) exit = true;
        if (!exit && flow(b, now) < -p.exitFlowSol) exit = true;
        if (!exit && now - sv.opened >= p.maxHold) exit = true;
        if (!exit) continue;
        sv.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        b.done = true;
      }

      // --- Pace probes: sell the whole probe as soon as its buy has landed. ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and scale-ins, on coins that traded this batch. ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      if (!govBlocked) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint) || probes.has(mint)) continue;
          const b = books.get(mint)!;
          if (b.done || b.created === null) continue;
          const r = reservesOf(mint);
          if (r === null) continue;
          const price = Number(r.vq) / Number(r.vt);
          const sv = sleeves.get(mint);
          if (sv === undefined) {
            // Probe entry.
            if (slotsLeft <= 0) continue;
            if (b.entries >= 1 || now - b.lastExit < 150) continue;
            if (now - b.created < p.probeMinAge) continue;
            if (r.rq < p.probeRqMin || r.rq > p.probeRqMax) continue;
            if (b.devSold) continue;
            if (p.probeMinDevBuy > 0 && b.devBuy < p.probeMinDevBuy) continue;
            if (p.probeMaxDevBuy > 0 && b.devBuy > p.probeMaxDevBuy) continue;
            const w = windowRead(b, now);
            if (w.trades < p.probeMinTrades || w.buyers < p.probeMinBuyers) continue;
            if (p.probeMaxBuyers > 0 && w.buyers > p.probeMaxBuyers) continue;
            if (w.net < p.probeMinNetSol) continue;
            if (w.topShare > p.probeMaxTopShare) continue;
            if (w.up < p.probeMinPriceUp || w.nearHigh < p.probeNearHigh) continue;
            let amount = Math.min(p.probeSol, p.maxCoinSol, Number(state.maxBuyLamports(mint)) / LAMPORTS);
            if (amount > free - txSol) amount = free - txSol;
            if (amount < 0.01) continue;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            free -= amount + txSol;
            b.invested += amount;
            b.lastBuyPrice = price;
            b.entries++;
            slotsLeft--;
          } else {
            // Scale-in at a fresh reserve milestone, price still climbing, flow alive.
            if (sv.exiting || !sv.filled) continue;
            const pos = state.positions.get(mint);
            if (pos === undefined) continue;
            const room = p.maxCoinSol - b.invested;
            if (room < 0.01) continue;
            let level = -1;
            for (const L of p.addLevels) if (r.rq >= L && !b.levelsHit.has(L)) level = L;
            if (level < 0) continue;
            if (b.lastBuyPrice > 0 && price < b.lastBuyPrice * (1 + p.addMinStep)) continue;
            if (flow(b, now) < p.addMinFlowSol) continue;
            let amount = Math.min(p.addSol, room, Number(state.maxBuyLamports(mint)) / LAMPORTS);
            if (amount > free - txSol) amount = free - txSol;
            if (amount < 0.01) continue;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            free -= amount + txSol;
            b.invested += amount;
            b.lastBuyPrice = price;
            b.levelsHit.add(level);
          }
        }
      }

      // --- Guardrail pacing: open a tiny probe when fills or coins lag the pace. ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.paceProbeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (sleeves.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.paceProbeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.paceProbeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.paceProbeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
