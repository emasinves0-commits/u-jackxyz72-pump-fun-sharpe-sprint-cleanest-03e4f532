// Steady-Sleeve Scalper: a pump.fun paper bot for agent-fun/replay/v2, built for
// the Sharpe Sprint (hourly Sharpe ratio, not total PnL). Strategy in strategy.ts,
// protocol in the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical copy
// of the kit's sdk/ts file). Run by the grader as `node /bot/main.ts`.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
