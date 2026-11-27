// Momentum-Scale-Ride v2 entrypoint: runs the strategy via the vendored SDK
// shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts).
// Run by the grader as `node /bot/main.ts` — pure function of the batches it
// is fed: no clock, no randomness, no I/O, no network.
//
// `--self-test` runs a local, stdin-free determinism check instead of the
// live bot: the strategy answers two empty batches and must return zero
// orders both times, with the default parameters intact. It never touches
// the wire, so the grader's run is unaffected.

import { BotState, runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

/** A minimal hello for the local self-test (capital 10 SOL, empty universe). */
function testHello() {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '1',
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 1, residue: 0 },
    },
    capital: { lamports: '10000000000' },
    caps: {
      max_open_positions: 30,
      max_order_bps_of_real_reserve: 10000,
      max_orders_per_batch: 20,
      shorts: false,
      leverage: false,
    },
    latency_slots: 2,
    fees: {
      protocol_bps_fallback: 0,
      creator_bps_fallback: 0,
      base_fee_lamports: '5000',
      priority_fee_lamports: '0',
      failed_tx_bps: 0,
    },
  };
}

/** An empty batch for the self-test: no fills, no events, no marks. */
function emptyBatch(slot: number) {
  return {
    type: 'batch',
    seq: slot,
    slot,
    events: [],
    marks: [],
    fills: [],
    account: { cash_lamports: '10000000000', positions: [] },
  };
}

/** Local determinism check: two empty batches, zero orders, params intact. */
function runSelfTest(): void {
  const strategy = createStrategy(DEFAULT_PARAMS);
  const state = new BotState(testHello());
  const firstBatch = emptyBatch(0);
  state.applyBatch(firstBatch);
  const first = strategy.onBatch(state, firstBatch);
  const secondBatch = emptyBatch(1);
  state.applyBatch(secondBatch);
  const second = strategy.onBatch(state, secondBatch);
  if (first.length !== 0 || second.length !== 0) {
    throw new Error(`self-test failed: empty batches returned ${first.length}/${second.length} orders, expected 0/0`);
  }
  if (
    DEFAULT_PARAMS.probeSol !== 0.05 ||
    DEFAULT_PARAMS.probeMaxTopShare !== 0.35 ||
    DEFAULT_PARAMS.takeProfit !== 0.4 ||
    DEFAULT_PARAMS.maxCoinSol !== 1.5
  ) {
    throw new Error('self-test failed: DEFAULT_PARAMS drifted from Momentum-Scale-Ride v2');
  }
  console.log('self-test OK: empty batches -> 0 orders, deterministic, params intact');
}

/** Build the live strategy from the default parameters. */
function buildStrategy() {
  return createStrategy(DEFAULT_PARAMS);
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const strategy = buildStrategy();
  await runBot({
    onBatch: (state, batch) => strategy.onBatch(state, batch),
  });
}
