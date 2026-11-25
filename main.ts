// Pump.fun Sharpe Sprint — paper bot (agent-fun/replay/v2).
//
// The ranking metric here is the HOURLY Sharpe ratio, not net PnL, and the
// final window is only six hours long. That changes everything about how a
// bot should trade:
//
//   * Sharpe = mean(hourly returns) / sample stdev(hourly returns). Six
//     hourly returns only. One big moonshot hour followed by five flat hours
//     scores badly; six small, even, positive hours score well. So this bot
//     optimises for STEADY, not big: equal small stakes, quick exits, and
//     activity paced evenly across the hours of the window.
//   * Every position is the same size, so no single coin can dominate an
//     hour's mark. Wins are banked fast (take profit at +10%) and losers
//     are cut fast (stop loss at -6%), which keeps each hour's equity move
//     small and mostly positive. Probe positions — the weak-signal buys
//     that only exist to clear the 20-coin bar — exit even faster
//     (+6% / -4%), so they bank their round trip and free the slot.
//   * The guardrail needs round trips of >= 0.01 SOL on >= 20 distinct
//     mints inside a 6-hour window, so the bot also runs a looser "probe"
//     pass: tiny 0.02 SOL buys on merely buy-led coins, purely to widen
//     coverage. A probe still clears the 0.01 SOL round-trip bar.
//
// Plumbing: the kit SDK owns the wire. runBot reads hello, then one batch
// per slot, and this bot answers exactly one JSON line per batch echoing
// the batch seq, with at most 16 orders. Orders decided on the batch for
// slot s fill at slot s + 2. All money math is BigInt lamports; all price
// comparisons are bigint cross-multiplication, never floats. There is no
// clock, no Math.random, no env, no network in here: the only "time" the
// bot sees is the slot number, and iteration follows Map insertion order,
// so two runs produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------ sizing & fees
// One entry costs ~125 bps curve fees + 105,000 lamports tx fees per side.
// On a 0.05 SOL stake that is ~0.00073 SOL per leg, ~2.9% round trip, so a
// +10% take-profit still nets about +7% and a -6% stop nets about -9%.
// Probe buys are 0.02 SOL, so their round trip costs ~3.5% of stake —
// their exits are tighter (+6% / -4%) to compensate.
const STAKE = (LAMPORTS_PER_SOL * 5n) / 100n; // 0.05 SOL, every entry equal
const PROBE_STAKE = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL probe entries
const MIN_STAKE = (LAMPORTS_PER_SOL * 2n) / 100n; // never buy below this
const MAX_SLIPPAGE_BPS = 1000; // 10%: 2-slot latency, reject wild fills

// ------------------------------------------------------------ hour pacing
// Solana slots run ~0.4 s, so ~9,000 slots make an hour. The bot counts
// hours from the first slot it sees and caps how many buys it may place in
// any one hour bucket, so it cannot spend the whole window's activity in
// the first hour and then sit flat. Flat hours drag the Sharpe mean down
// and push the stdev up; paced hours keep the return stream even.
const SLOTS_PER_HOUR = 9000;
const MAX_BUYS_PER_HOUR = 8;

// ------------------------------------------------------------ entry gates
// Strict pass: a coin is young, its tape is clearly buy-led, and its price
// is still holding near its window high (rising, not fading). The bar is
// deliberately high — every extra trade pays ~3% in fees, so a marginal
// setup is worse than no trade at all.
const STRICT_MAX_AGE = 6000; // slots since CreateEvent (~40 min)
const STRICT_MIN_TRADES = 40;
const STRICT_MIN_BUYERS = 20;
const STRICT_MIN_BUY_VOL_X = 4n; // buy volume >= 4x sell volume
const STRICT_MIN_REAL_SOL = 5n * LAMPORTS_PER_SOL;
const STRICT_MAX_REAL_SOL = 80n * LAMPORTS_PER_SOL;
const STRICT_NEAR_HIGH_PCT = 92n; // price >= 92% of window high

// Probe pass: much looser, only to reach 20 distinct coins. A probe is a
// real trade with the same exits, just a smaller stake and a weaker signal.
const PROBE_MIN_AGE = 1200;
const PROBE_MAX_AGE = 20000;
const PROBE_MIN_TRADES = 4;
const PROBE_MIN_BUYERS = 3;
const PROBE_MIN_REAL_SOL = (LAMPORTS_PER_SOL * 5n) / 10n; // 0.5 SOL
const PROBE_MAX_REAL_SOL = 80n * LAMPORTS_PER_SOL;
const PROBE_NEAR_HIGH_PCT = 70n;

// ------------------------------------------------------------ exit plan
// Bank wins early, cut losers early, trail a winner that keeps running,
// and free the slot when a position goes nowhere. Probes exit tighter:
// they are weak-signal coverage buys, not convictions.
const TAKE_PROFIT_PCT = 110n; // value >= 110% of cost
const STOP_LOSS_PCT = 94n; // value <= 94% of cost
const TRAIL_ARM_PCT = 105n; // trailing arms once peak >= 105% of cost
const TRAIL_PULLBACK_PCT = 97n; // sell when value <= 97% of peak
const PROBE_TAKE_PROFIT_PCT = 106n; // probe value >= 106% of cost
const PROBE_STOP_LOSS_PCT = 96n; // probe value <= 96% of cost
const PROBE_TRAIL_ARM_PCT = 102n; // probe trailing arms once peak >= 102%
const PROBE_TRAIL_PULLBACK_PCT = 98n; // probe sell at <= 98% of peak
const STALE_AGE = 3000; // slots held without progress
const STALE_MAX_PCT = 102n; // stale exit only while value < 102% of cost

const REENTRY_COOLDOWN = 15000; // slots before the same mint may re-enter

// ------------------------------------------------------------ per-coin flow
// The tape a coin leaves behind while it is young: how much SOL bought vs
// sold, how many buys vs sells, how many distinct buyers, and the best
// virtual price seen so far (virtual SOL per virtual token).
interface CoinFlow {
  createdSlot: number | null;
  trades: number;
  buyVol: bigint;
  sellVol: bigint;
  buyCount: number;
  sellCount: number;
  buyers: Set<string>;
  highQuote: bigint; // virtual SOL reserves at the window-high price
  highTokens: bigint; // virtual token reserves at the window-high price
}

function freshFlow(): CoinFlow {
  return {
    createdSlot: null,
    trades: 0,
    buyVol: 0n,
    sellVol: 0n,
    buyCount: 0,
    sellCount: 0,
    buyers: new Set<string>(),
    highQuote: 0n,
    highTokens: 1n,
  };
}

// ------------------------------------------------------------ module state
// All of this is rebuilt from the event stream every run, in event order,
// so the run is a pure function of the hello + batches it receives.
const flows = new Map<string, CoinFlow>();
const reenterAfter = new Map<string, number>(); // mint -> earliest re-entry slot
const peakValue = new Map<string, bigint>(); // mint -> best mark value seen
const probeHeld = new Set<string>(); // mints bought by the probe pass (tighter exits)
const buysPerHour = new Map<number, bigint>(); // hour bucket -> buys placed
let firstSlot = -1;

/** Mark-to-market value of `tokens` at virtual reserves (quote per token). */
function markValue(tokens: bigint, quoteRes: bigint, tokenRes: bigint): bigint {
  if (tokenRes === 0n || tokens === 0n) return 0n;
  return (tokens * quoteRes) / tokenRes;
}

/**
 * Is price (aQuote/aTokens) at least `pct` percent of price
 * (bQuote/bTokens)? Cross-multiplied in bigint, no floats.
 */
function priceHoldsPct(
  aQuote: bigint,
  aTokens: bigint,
  bQuote: bigint,
  bTokens: bigint,
  pct: bigint,
): boolean {
  return aQuote * bTokens * 100n >= bQuote * aTokens * pct;
}

/** Which hour bucket (from the first slot seen) does `slot` fall in? */
function hourOf(slot: number): number {
  if (firstSlot < 0) return 0;
  return Math.floor((slot - firstSlot) / SLOTS_PER_HOUR);
}

/**
 * One reason a held position should be sold now, or null to keep holding.
 * Thresholds are passed in so probe positions (weak-signal coverage buys)
 * can exit on a tighter plan than strict entries.
 */
function exitReason(
  value: bigint,
  cost: bigint,
  peak: bigint,
  ageSlots: number,
  takeProfitPct: bigint,
  stopLossPct: bigint,
  trailArmPct: bigint,
  trailPullbackPct: bigint,
): string | null {
  if (value * 100n >= cost * takeProfitPct) return 'take-profit';
  if (value * 100n <= cost * stopLossPct) return 'stop-loss';
  if (peak * 100n >= cost * trailArmPct && value * 100n <= peak * trailPullbackPct) {
    return 'trailing-stop';
  }
  if (ageSlots > STALE_AGE && value * 100n < cost * STALE_MAX_PCT) return 'stale';
  return null;
}

await runBot({
  onHello(state: BotState): void {
    // The seed is the run's only sanctioned randomness; this strategy needs
    // none — every decision is a pure function of the event stream — so it
    // is deliberately left unused. Nothing else is read here.
    void state.hello.seed;
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot < 0) firstSlot = batch.slot;
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    const hour = hourOf(batch.slot);
    const buysThisHour = buysPerHour.get(hour) ?? 0n;
    let buysLeftThisHour = MAX_BUYS_PER_HOUR - Number(buysThisHour);
    if (buysLeftThisHour < 0) buysLeftThisHour = 0;

    const countBuy = (): void => {
      buysPerHour.set(hour, (buysPerHour.get(hour) ?? 0n) + 1n);
      buysLeftThisHour -= 1;
    };

    // --- step 1: manage what we already hold. Exits go first so a freed
    // slot (and freed cash) is visible to the entry passes below. --------
    const sellPending = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') sellPending.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      const cost = holding.cost_lamports;
      if (cost === 0n) continue;
      const value = markValue(
        holding.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      const seenPeak = peakValue.get(mint) ?? 0n;
      if (value > seenPeak) peakValue.set(mint, value);
      const peak = peakValue.get(mint) ?? value;
      const flow = flows.get(mint);
      const age =
        flow !== undefined && flow.createdSlot !== null
          ? batch.slot - flow.createdSlot
          : 0;
      const isProbe = probeHeld.has(mint);
      const reason = exitReason(
        value,
        cost,
        peak,
        age,
        isProbe ? PROBE_TAKE_PROFIT_PCT : TAKE_PROFIT_PCT,
        isProbe ? PROBE_STOP_LOSS_PCT : STOP_LOSS_PCT,
        isProbe ? PROBE_TRAIL_ARM_PCT : TRAIL_ARM_PCT,
        isProbe ? PROBE_TRAIL_PULLBACK_PCT : TRAIL_PULLBACK_PCT,
      );
      if (reason === null) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      peakValue.delete(mint);
      probeHeld.delete(mint);
    }

    // --- step 2: fold this batch's events into the per-coin flows. The
    // SDK already folded them into state.curves; this is our own tape. ----
    // `touched` keeps event order (insertion order of a Set), so entries
    // are considered in the order the chain produced them — deterministic.
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const flow = flows.get(e.mint) ?? freshFlow();
        flow.createdSlot = e.slot;
        flows.set(e.mint, flow);
        touched.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const flow = flows.get(e.mint) ?? freshFlow();
        flow.trades += 1;
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          flow.buyVol += sol;
          flow.buyCount += 1;
          flow.buyers.add(e.user);
        } else {
          flow.sellVol += sol;
          flow.sellCount += 1;
        }
        const vq = BigInt(e.virtual_sol_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (vt > 0n && (flow.highQuote === 0n || vq * flow.highTokens > flow.highQuote * vt)) {
          flow.highQuote = vq;
          flow.highTokens = vt;
        }
        flows.set(e.mint, flow);
        touched.add(e.mint);
      } else {
        // CompleteEvent: the harness closes the position itself; drop the
        // local tracking so a later re-creation of the mint starts clean.
        flows.delete(e.mint);
        peakValue.delete(e.mint);
        reenterAfter.delete(e.mint);
        probeHeld.delete(e.mint);
      }
    }

    // --- step 3: strict entries — young, buy-led, near-high coins. -------
    for (const mint of touched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (openSlots <= 0 || buysLeftThisHour <= 0) break;
      if (batch.slot < (reenterAfter.get(mint) ?? 0)) continue;
      const flow = flows.get(mint);
      const curve = state.curves.get(mint);
      if (flow === undefined || curve === undefined || curve.complete) continue;
      if (flow.createdSlot === null) continue;
      if (batch.slot - flow.createdSlot > STRICT_MAX_AGE) continue;
      if (flow.trades < STRICT_MIN_TRADES) continue;
      if (flow.buyers.size < STRICT_MIN_BUYERS) continue;
      if (flow.buyCount <= flow.sellCount) continue;
      if (flow.buyVol < flow.sellVol * STRICT_MIN_BUY_VOL_X) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < STRICT_MIN_REAL_SOL || realSol > STRICT_MAX_REAL_SOL) continue;
      if (
        !priceHoldsPct(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          flow.highQuote,
          flow.highTokens,
          STRICT_NEAR_HIGH_PCT,
        )
      ) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_STAKE) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (free < amount + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      reenterAfter.set(mint, batch.slot + REENTRY_COOLDOWN);
      free -= amount + txFee;
      openSlots -= 1;
      countBuy();
    }

    // --- step 4: probe entries — looser, purely for the 20-coin bar. -----
    // A coin that missed the strict window still gets one small buy if its
    // tape is at least buy-led, so the bot banks the round trip early in
    // the window instead of hunting for perfect setups that never come.
    for (const mint of touched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (openSlots <= 0 || buysLeftThisHour <= 0) break;
      if (batch.slot < (reenterAfter.get(mint) ?? 0)) continue;
      const flow = flows.get(mint);
      const curve = state.curves.get(mint);
      if (flow === undefined || curve === undefined || curve.complete) continue;
      if (flow.createdSlot === null) continue;
      const age = batch.slot - flow.createdSlot;
      if (age < PROBE_MIN_AGE || age > PROBE_MAX_AGE) continue;
      if (flow.trades < PROBE_MIN_TRADES) continue;
      if (flow.buyers.size < PROBE_MIN_BUYERS) continue;
      if (flow.buyCount < flow.sellCount) continue;
      if (flow.buyVol <= flow.sellVol) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < PROBE_MIN_REAL_SOL || realSol > PROBE_MAX_REAL_SOL) continue;
      if (
        !priceHoldsPct(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          flow.highQuote,
          flow.highTokens,
          PROBE_NEAR_HIGH_PCT,
        )
      ) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_STAKE) continue;
      if (free < PROBE_STAKE + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: PROBE_STAKE,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      reenterAfter.set(mint, batch.slot + REENTRY_COOLDOWN);
      probeHeld.add(mint);
      free -= PROBE_STAKE + txFee;
      openSlots -= 1;
      countBuy();
    }

    return orders;
  },

  onDone(state: BotState): void {
    // The run is over; the harness flattens any open positions itself.
    // Nothing is persisted and nothing is read here.
    void state;
  },
});
