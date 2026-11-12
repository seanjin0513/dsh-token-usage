/**
 * Unit tests for the pure billing / aggregation rules in `stats.js`.
 *
 * Every timestamp is built with a local-time Date constructor at a fixed
 * calendar date, so the suite never depends on the machine clock or on the
 * machine timezone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_SPAN_DAYS,
  DEFAULT_CURRENCY,
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  DEFAULT_VALLEY_END,
  DEFAULT_VALLEY_START,
  STAT_PERIODS,
  addUsage,
  aggregate,
  aggregatePeriod,
  costOf,
  dailySeries,
  emptyPriceSet,
  emptyUsage,
  ensureModelRules,
  foldSessionEvents,
  formatClock,
  isModelPriced,
  isPriced,
  isValleyTime,
  isWeekend,
  localDayKey,
  localMinuteOfDay,
  modelKey,
  normalizeModelRule,
  normalizePriceSet,
  normalizeState,
  observedModels,
  observedProviders,
  parseClock,
  periodBounds,
  promptTokens,
  ruleFor,
  selectTier,
  startOfLocalDay,
  usageTotal,
} from '../stats.js';

/** Per-million prices used by the cost tests. */
const BASE = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 };
const VALLEY = { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1.5 };
const LONG = { input: 4, output: 16, cacheRead: 1, cacheWrite: 6 };

/** Local-time milliseconds. */
const local = (year, month, day, hour = 0, minute = 0) =>
  new Date(year, month, day, hour, minute, 0, 0).getTime();

/** Fixed "now": Monday 2026-06-15 15:30 local time. */
const NOW = local(2026, 5, 15, 15, 30);
/** Wednesday 2026-06-10 noon. */
const NOON_WED = local(2026, 5, 10, 12, 0);

/** One usage entry with defaults. */
const at = (overrides = {}) => ({
  t: 0,
  provider: 'p',
  model: 'm',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  ...overrides,
});

/** Normalized configuration holding one rule for `p/m`. */
const makeConfig = (rule = {}) => normalizeState({ models: { 'p/m': rule } });

/** Compare costs that involve non-exact binary fractions. */
function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

test('token helpers count prompt tokens and billed totals', () => {
  assert.equal(promptTokens(at({ input: 10, cacheRead: 20, cacheWrite: 30, output: 999, reasoning: 999 })), 60);
  assert.equal(promptTokens(at()), 0);
  // reasoning is deliberately excluded from the billed total.
  assert.equal(usageTotal(at({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 1000 })), 100);
  assert.deepEqual(emptyUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(emptyPriceSet(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(
    addUsage(
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 },
    ),
    { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, reasoning: 55 },
  );
});

test('costOf bills each token family at its base per-million price', () => {
  const config = makeConfig({ base: BASE });

  const allFamilies = costOf(
    at({ t: NOON_WED, input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
    config,
  );
  // 2 + 8 + 8 (reasoning at the output price) + 0.5 + 3
  assert.deepEqual(allFamilies, { cost: 21.5, tier: 'base', priced: true });
  assert.equal(costOf(at({ t: NOON_WED, output: 1_000_000 }), config).cost, 8);
  assert.equal(costOf(at({ t: NOON_WED, reasoning: 1_000_000 }), config).cost, 8);
  assert.equal(costOf(at({ t: NOON_WED, cacheRead: 1_000_000 }), config).cost, 0.5);
  assert.equal(costOf(at({ t: NOON_WED, cacheWrite: 1_000_000 }), config).cost, 3);
  close(
    costOf(
      at({ t: NOON_WED, input: 250_000, output: 125_000, reasoning: 500_000, cacheRead: 2_000_000, cacheWrite: 400_000 }),
      config,
    ).cost,
    7.7,
  );
});

test('long-context tier has priority and uses the strict prompt > threshold rule', () => {
  const rule = normalizeModelRule({ base: BASE, valley: VALLEY, long: LONG, longContextThreshold: 100 });
  const inValley = local(2026, 5, 10, 7, 0); // Wednesday, inside the default 18:00–09:00 valley

  assert.equal(selectTier(rule, 101, inValley).tier, 'long');
  assert.deepEqual(selectTier(rule, 101, inValley).price, LONG);
  // The threshold itself is not "long context": strictly greater is required.
  assert.equal(selectTier(rule, 100, inValley).tier, 'valley');
  assert.equal(selectTier(rule, 100, NOON_WED).tier, 'base');
  assert.equal(selectTier(rule, 99, NOON_WED).tier, 'base');

  // A zero threshold disables the long tier even with a `long` price set.
  const zeroThreshold = normalizeModelRule({
    base: BASE,
    valley: VALLEY,
    long: LONG,
    longContextThreshold: 0,
  });
  assert.equal(zeroThreshold.longContextThreshold, 0);
  assert.equal(selectTier(zeroThreshold, 10_000_000, inValley).tier, 'valley');

  // A large prompt without a `long` price falls through to valley/base.
  const noLong = normalizeModelRule({ base: BASE, valley: VALLEY, longContextThreshold: 10 });
  assert.equal(selectTier(noLong, 10_000_000, inValley).tier, 'valley');

  const longConfig = makeConfig({ base: BASE, valley: VALLEY, long: LONG, longContextThreshold: 100 });
  const longEntry = at({
    t: inValley,
    input: 1_000_000,
    output: 1_000_000,
    reasoning: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  });
  const priced = costOf(longEntry, longConfig);
  assert.equal(priced.tier, 'long');
  assert.equal(priced.cost, 43); // 4 + 16 + 16 + 1 + 6
});

test('valley window defaults to local 18:00–09:00 (cross-midnight), start-inclusive and end-exclusive', () => {
  const rule = normalizeModelRule({ base: BASE, valley: VALLEY });
  assert.equal(rule.valleyWindow.start, DEFAULT_VALLEY_START);
  assert.equal(rule.valleyWindow.end, DEFAULT_VALLEY_END);
  assert.deepEqual({ start: DEFAULT_VALLEY_START, end: DEFAULT_VALLEY_END }, { start: '18:00', end: '09:00' });

  const ms = (hour, minute) => local(2026, 5, 10, hour, minute); // Wednesday
  assert.equal(isValleyTime(rule, ms(17, 59)), false);
  assert.equal(selectTier(rule, 10, ms(17, 59)).tier, 'base');
  assert.equal(selectTier(rule, 10, ms(18, 0)).tier, 'valley');
  assert.equal(selectTier(rule, 10, ms(23, 0)).tier, 'valley');
  assert.equal(selectTier(rule, 10, ms(0, 0)).tier, 'valley');
  assert.equal(selectTier(rule, 10, ms(7, 0)).tier, 'valley');
  assert.equal(selectTier(rule, 10, ms(8, 59)).tier, 'valley');
  assert.equal(isValleyTime(rule, ms(9, 0)), false);
  assert.equal(selectTier(rule, 10, ms(9, 0)).tier, 'base');
  assert.equal(selectTier(rule, 10, ms(12, 0)).tier, 'base');

  // costOf picks the valley price set.
  const config = makeConfig({ base: BASE, valley: VALLEY });
  close(
    costOf(
      at({ t: ms(7, 0), input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
      config,
    ).cost,
    10.75,
  );
});

test('valley window supports cross-midnight (start > end) and an all-day window', () => {
  const overnight = normalizeModelRule({
    base: BASE,
    valley: VALLEY,
    valleyWindow: { start: '22:00', end: '06:00' },
  });
  const ms = (hour, minute) => local(2026, 5, 10, hour, minute);
  assert.equal(selectTier(overnight, 10, ms(23, 0)).tier, 'valley');
  assert.equal(selectTier(overnight, 10, ms(0, 0)).tier, 'valley');
  assert.equal(selectTier(overnight, 10, ms(5, 59)).tier, 'valley');
  assert.equal(selectTier(overnight, 10, ms(6, 0)).tier, 'base');
  assert.equal(selectTier(overnight, 10, ms(12, 0)).tier, 'base');

  // start === end is treated as an all-day window by stats.js.
  const allDay = normalizeModelRule({
    base: BASE,
    valley: VALLEY,
    valleyWindow: { start: '09:00', end: '09:00' },
  });
  assert.equal(selectTier(allDay, 10, ms(12, 0)).tier, 'valley');
  assert.equal(selectTier(allDay, 10, ms(3, 0)).tier, 'valley');
});

test('weekend and holiday flags extend the valley tier to whole days', () => {
  const weekendRule = normalizeModelRule({ base: BASE, valley: VALLEY, valleyWindow: { weekends: true } });
  assert.equal(selectTier(weekendRule, 10, local(2026, 5, 13, 12, 0)).tier, 'valley'); // Saturday
  assert.equal(selectTier(weekendRule, 10, local(2026, 5, 14, 23, 0)).tier, 'valley'); // Sunday
  assert.equal(selectTier(weekendRule, 10, local(2026, 5, 15, 12, 0)).tier, 'base'); // Monday
  // Same date, flags off -> outside the window => base.
  assert.equal(selectTier(normalizeModelRule({ base: BASE, valley: VALLEY }), 10, local(2026, 5, 13, 12, 0)).tier, 'base');

  const holidayRule = normalizeModelRule({
    base: BASE,
    valley: VALLEY,
    holidays: ['2026-06-10', '2026-06-11'],
    valleyWindow: { holidays: true },
  });
  assert.equal(selectTier(holidayRule, 10, local(2026, 5, 10, 12, 0)).tier, 'valley');
  assert.equal(selectTier(holidayRule, 10, local(2026, 5, 11, 12, 0)).tier, 'valley');
  assert.equal(selectTier(holidayRule, 10, local(2026, 5, 12, 12, 0)).tier, 'base');
  // Listed holiday but the flag is off -> base.
  const holidayOff = normalizeModelRule({ base: BASE, valley: VALLEY, holidays: ['2026-06-10'] });
  assert.equal(selectTier(holidayOff, 10, local(2026, 5, 10, 12, 0)).tier, 'base');
});

test('unpriced and partially priced models are reported honestly', () => {
  const unknown = costOf(at({ t: NOON_WED, input: 1_000_000, output: 1_000_000 }), makeConfig({}));
  assert.deepEqual(unknown, { cost: 0, tier: 'base', priced: false });

  const zero = costOf(at({ t: NOON_WED, input: 1_000_000 }), makeConfig({ base: {} }));
  assert.equal(zero.cost, 0);
  assert.equal(zero.priced, false);

  // Only one of the four prices set: priced, other families cost 0.
  const partial = costOf(at({ t: NOON_WED, input: 1_000_000, output: 1_000_000 }), makeConfig({ base: { input: 2 } }));
  assert.equal(partial.cost, 2);
  assert.equal(partial.priced, true);

  assert.equal(isPriced({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
  assert.equal(isPriced(BASE), true);
  assert.equal(isModelPriced(makeConfig({ base: BASE }), 'p', 'm'), true);
  // The unpriced marker looks at the base price only.
  assert.equal(isModelPriced(makeConfig({ valley: VALLEY }), 'p', 'm'), false);
  assert.equal(ruleFor(makeConfig({ base: BASE }), 'p', 'missing'), undefined);
});

test('periodBounds returns local-day boundaries for the five periods', () => {
  const bounds = periodBounds(NOW);
  assert.deepEqual(Object.keys(bounds), STAT_PERIODS);

  assert.equal(bounds.today.from, startOfLocalDay(NOW));
  assert.equal(bounds.week.from, startOfLocalDay(new Date(2026, 5, 9)));
  assert.equal(bounds.month.from, startOfLocalDay(new Date(2026, 4, 17)));
  assert.equal(localDayKey(bounds.week.from), '2026-06-09');
  assert.equal(localDayKey(bounds.month.from), '2026-05-17');

  assert.equal(bounds.session.from, Number.NEGATIVE_INFINITY);
  assert.equal(bounds.session.to, Number.POSITIVE_INFINITY);
  assert.equal(bounds.all.from, Number.NEGATIVE_INFINITY);
  assert.equal(bounds.all.to, Number.POSITIVE_INFINITY);
  assert.equal(bounds.today.to, Number.POSITIVE_INFINITY);
});

test('aggregatePeriod applies inclusive from / exclusive to boundaries and sums every period', () => {
  const config = makeConfig({ base: BASE });
  const entry = (t) => at({ t, input: 1_000_000 }); // cost 2 per call
  const entries = [
    entry(local(2026, 5, 15, 0, 0)), // today start
    entry(local(2026, 5, 14, 23, 59)), // yesterday
    entry(local(2026, 5, 9, 0, 0)), // week window start (6 days back)
    entry(local(2026, 5, 8, 23, 59)), // before the week window
    entry(local(2026, 4, 17, 0, 0)), // month window start (29 days back)
    entry(local(2026, 4, 16, 23, 59)), // before the month window
    entry(local(2020, 0, 1, 12, 0)), // ancient
  ];

  const bounds = periodBounds(NOW);
  const today = aggregatePeriod(entries, config, bounds.today);
  assert.equal(today.calls, 1);
  assert.equal(today.cost, 2);
  assert.equal(today.tokens.input, 1_000_000);

  assert.equal(aggregatePeriod(entries, config, bounds.week).calls, 3);
  assert.equal(aggregatePeriod(entries, config, bounds.month).calls, 5);
  assert.equal(aggregatePeriod(entries, config, bounds.all).calls, 7);

  // from is inclusive, to is exclusive.
  assert.equal(aggregatePeriod(entries, config, { from: local(2026, 5, 15), to: local(2026, 5, 16) }).calls, 1);
  assert.equal(aggregatePeriod(entries, config, { from: local(2026, 5, 16), to: local(2026, 5, 17) }).calls, 0);
  assert.equal(aggregatePeriod(entries, config, { from: local(2026, 5, 15, 0, 0), to: local(2026, 5, 15, 0, 1) }).calls, 1);
  assert.equal(aggregatePeriod(entries, config, { from: local(2026, 5, 15, 0, 0) + 1, to: local(2026, 5, 16) }).calls, 0);
  // A null range means "everything".
  assert.equal(aggregatePeriod(entries, config, null).calls, 7);
});

test('aggregatePeriod keeps a per-model breakdown and flags unpriced models', () => {
  const config = normalizeState({ models: { 'p/m': { base: BASE }, 'q/n': { base: BASE } } });
  const result = aggregatePeriod(
    [
      at({ t: NOON_WED, input: 1_000_000 }), // p/m, cost 2
      at({ t: NOON_WED, provider: 'q', model: 'n', input: 2_000_000, reasoning: 100 }), // q/n, cost 4
    ],
    config,
    null,
  );
  assert.equal(result.calls, 2);
  // 2 + (4 + 100 reasoning tokens * output price 8 / 1e6)
  close(result.cost, 6.0008);
  assert.equal(result.tokens.input, 3_000_000);
  assert.equal(result.tokens.reasoning, 100);
  assert.deepEqual(result.models.map((row) => row.id), ['q/n', 'p/m']); // sorted by cost desc
  close(result.models[0].cost, 4.0008);
  assert.equal(result.models[0].calls, 1);
  assert.deepEqual(result.unpriced, []);

  const mixed = aggregatePeriod(
    [at({ t: NOON_WED, provider: 'u', model: 'x', input: 5 }), at({ t: NOON_WED, input: 1_000_000 })],
    config,
    null,
  );
  assert.deepEqual(mixed.unpriced, ['u/x']);
  assert.equal(mixed.calls, 2);
  assert.equal(mixed.cost, 2); // the unpriced call contributes nothing
});

test('aggregate scopes session separately and applies day windows to the full corpus', () => {
  const config = makeConfig({ base: BASE });
  const sessionEntries = [
    at({ t: local(2026, 5, 15, 10, 0), input: 1_000_000 }),
    at({ t: local(2020, 0, 1, 10, 0), input: 1_000_000 }),
  ];
  const allEntries = [
    ...sessionEntries,
    at({ t: local(2026, 4, 1, 10, 0), provider: 'q', model: 'n', input: 1_000_000 }),
  ];

  const periods = aggregate(sessionEntries, allEntries, config, NOW);
  assert.deepEqual(Object.keys(periods), STAT_PERIODS);
  assert.equal(periods.session.calls, 2); // session ignores dates
  assert.equal(periods.session.cost, 4);
  assert.equal(periods.today.calls, 1);
  assert.equal(periods.week.calls, 1);
  assert.equal(periods.month.calls, 1); // the May 1 call is older than 29 days
  assert.equal(periods.all.calls, 3);
  assert.equal(periods.all.cost, 4);
  assert.deepEqual(periods.all.unpriced, ['q/n']);
});

test('dailySeries returns 14 ascending local days ending today, zeroed when empty', () => {
  const series = dailySeries([], makeConfig({ base: BASE }), NOW);
  assert.equal(series.length, DAILY_SPAN_DAYS);
  assert.equal(series.length, 14);
  assert.equal(series[0].day, '2026-06-02');
  assert.equal(series[series.length - 1].day, '2026-06-15');
  assert.deepEqual(Object.keys(series[0]), ['day', 'tokens', 'cost']);
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index - 1].day < series[index].day);
  }
  assert.ok(series.every((row) => usageTotal(row.tokens) === 0 && row.cost === 0));
});

test('dailySeries attributes entries to the correct local day and sums tokens/cost', () => {
  const config = makeConfig({ base: BASE });
  const entries = [
    at({ t: local(2026, 5, 15, 9, 0), input: 1_000_000 }), // today
    at({ t: local(2026, 5, 15, 23, 59), input: 1_000_000 }), // still today
    at({ t: local(2026, 5, 14, 9, 0), input: 2_000_000 }), // yesterday
    at({ t: local(2026, 5, 2, 0, 0), input: 3_000_000 }), // first day of the window
    at({ t: local(2026, 5, 1, 23, 59), input: 9_000_000 }), // day before the window
    at({ t: local(2026, 5, 16, 0, 0), input: 4_000_000 }), // tomorrow
  ];

  const series = dailySeries(entries, config, NOW);
  const byDay = new Map(series.map((row) => [row.day, row]));
  assert.equal(byDay.get('2026-06-15').tokens.input, 2_000_000);
  assert.equal(byDay.get('2026-06-15').cost, 4);
  assert.equal(byDay.get('2026-06-14').tokens.input, 2_000_000);
  assert.equal(byDay.get('2026-06-14').cost, 4);
  assert.equal(byDay.get('2026-06-02').tokens.input, 3_000_000);
  assert.equal(byDay.get('2026-06-02').cost, 6);
  assert.equal(byDay.has('2026-06-01'), false);
  const total = series.reduce((sum, row) => sum + row.tokens.input, 0);
  assert.equal(total, 7_000_000); // only the entries inside the 14-day window
});

test('foldSessionEvents keeps only model-authored assistant messages with usage', () => {
  const modelEvent = (time, usage, source = { kind: 'model', provider: 'p', model: 'm' }) => ({
    type: 'assistant/message',
    time,
    data: { message: { source }, usage },
  });

  const entries = foldSessionEvents([
    modelEvent(1000, {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      reasoningTokens: 50,
    }),
    modelEvent(2000, { inputTokens: 1 }, { kind: 'user', provider: 'p', model: 'm' }),
    modelEvent(3000, { inputTokens: 1 }, { kind: 'model', provider: 'q', model: 'n' }),
    { type: 'user/message', time: 4000, data: { usage: { inputTokens: 99 } } },
    { type: 'assistant/message', time: 5000, data: { message: { source: { kind: 'model', provider: 'p', model: 'm' } } } },
    modelEvent(6000, { inputTokens: 1 }, { kind: 'model', provider: '', model: 'm' }),
    modelEvent(7000, { inputTokens: 0, outputTokens: 0 }),
    null,
    { type: 'assistant/message' },
  ]);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    t: 1000,
    provider: 'p',
    model: 'm',
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    reasoning: 50,
  });
  assert.deepEqual(entries[1], {
    t: 3000,
    provider: 'q',
    model: 'n',
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  });
});

test('foldSessionEvents coerces missing/negative usage fields and defaults time to 0', () => {
  const entries = foldSessionEvents([
    {
      type: 'assistant/message',
      time: undefined,
      data: {
        message: { source: { kind: 'model', provider: 'p', model: 'm' } },
        usage: { inputTokens: '5', outputTokens: -2, cacheReadTokens: null, cacheWriteTokens: Infinity, reasoningTokens: 7 },
      },
    },
    {
      type: 'assistant/message',
      time: 'not-a-number',
      data: {
        message: { source: { kind: 'model', provider: 'p', model: 'm' } },
        usage: { reasoningTokens: 3 },
      },
    },
    {
      type: 'assistant/message',
      time: 42,
      data: {
        message: { source: { kind: 'model', provider: 'p', model: undefined } },
        usage: { inputTokens: 5 },
      },
    },
  ]);

  // A reasoning-only call has no billed tokens, so the fold drops it as well.
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    t: 0,
    provider: 'p',
    model: 'm',
    input: 5,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 7,
  });
});

test('normalizeState fills defaults and drops unusable state', () => {
  assert.deepEqual(normalizeState(undefined), {
    version: 1,
    currency: DEFAULT_CURRENCY,
    models: {},
    balances: {},
  });

  const state = normalizeState({
    version: 7,
    currency: '  USD  ',
    extra: 'dropped',
    models: {
      'p/m': {
        base: { input: '2', output: -3 },
        valleyWindow: { weekends: 1 },
        longContextThreshold: '1000.7',
      },
      '': { base: { input: 1 } },
    },
    balances: {
      p: { amount: '5', baselineCost: -2, updatedAt: 'x' },
      q: { amount: 'not-a-number' },
      '': { amount: 1 },
      r: 5,
    },
  });

  assert.equal(state.version, 1);
  assert.equal(state.currency, 'USD');
  assert.equal('extra' in state, false);
  assert.deepEqual(Object.keys(state.models), ['p/m']);
  assert.equal(state.models['p/m'].base.input, 2);
  assert.equal(state.models['p/m'].base.output, 0);
  assert.equal(state.models['p/m'].longContextThreshold, 1001);
  assert.equal(state.models['p/m'].valleyWindow.weekends, false);
  assert.deepEqual(state.balances, { p: { amount: 5, baselineCost: 0, updatedAt: 0 } });
  assert.deepEqual(normalizeState({ models: [], balances: [] }).models, {});
  assert.deepEqual(normalizeState({ models: [], balances: [] }).balances, {});
  assert.equal(normalizeState({ currency: '   ' }).currency, DEFAULT_CURRENCY);
});

test('normalizeModelRule defaults, clamps and sanitizes one rule', () => {
  const defaults = normalizeModelRule(null);
  assert.deepEqual(defaults.base, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(defaults.valley, null);
  assert.equal(defaults.long, null);
  assert.deepEqual(defaults.valleyWindow, {
    start: DEFAULT_VALLEY_START,
    end: DEFAULT_VALLEY_END,
    weekends: false,
    holidays: false,
  });
  assert.deepEqual(defaults.holidays, []);
  assert.equal(defaults.longContextThreshold, DEFAULT_LONG_CONTEXT_THRESHOLD);
  assert.deepEqual(normalizeModelRule({}), defaults);

  // Negative thresholds fall back to the default instead of becoming 0.
  assert.equal(normalizeModelRule({ longContextThreshold: -5 }).longContextThreshold, DEFAULT_LONG_CONTEXT_THRESHOLD);
  assert.equal(normalizeModelRule({ longContextThreshold: 1000.4 }).longContextThreshold, 1000);
  assert.equal(normalizeModelRule({ longContextThreshold: 1000.5 }).longContextThreshold, 1001);

  const window = normalizeModelRule({
    valleyWindow: { start: '8:05', end: 'bogus', weekends: 1, holidays: 'yes' },
  });
  assert.equal(window.valleyWindow.start, '08:05');
  assert.equal(window.valleyWindow.end, DEFAULT_VALLEY_END);
  assert.equal(window.valleyWindow.weekends, false);
  assert.equal(window.valleyWindow.holidays, false);

  assert.deepEqual(
    normalizeModelRule({ holidays: ['2026-10-01', '2026-10-01', 'bad', '2026-1-1', 5] }).holidays,
    ['2026-10-01'],
  );

  const equalWindow = normalizeModelRule({ valleyWindow: { start: '09:00', end: '09:00' } });
  assert.equal(equalWindow.valleyWindow.start, '09:00');
  assert.equal(equalWindow.valleyWindow.end, '09:00');
});

test('normalizePriceSet rejects non-objects and coerces values to non-negative numbers', () => {
  assert.equal(normalizePriceSet(undefined), null);
  assert.equal(normalizePriceSet(null), null);
  assert.equal(normalizePriceSet([]), null);
  assert.equal(normalizePriceSet('2'), null);
  assert.deepEqual(
    normalizePriceSet({ input: '2.5', output: -1, cacheRead: 'abc', cacheWrite: Infinity }),
    { input: 2.5, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.deepEqual(normalizePriceSet({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('modelKey, ruleFor and observed-model helpers', () => {
  assert.equal(modelKey('cnit', 'deepseek-flash'), 'cnit/deepseek-flash');
  const config = makeConfig({ base: BASE });
  assert.equal(ruleFor(config, 'p', 'm').base.input, 2);
  assert.equal(ruleFor(config, 'p', 'n'), undefined);
  assert.equal(ruleFor(null, 'p', 'm'), undefined);

  const entries = [
    at({ provider: 'b', model: '2' }),
    at({ provider: 'a', model: '1' }),
    at({ provider: 'b', model: '2' }),
  ];
  assert.deepEqual(observedModels(entries), [
    { id: 'a/1', provider: 'a', model: '1' },
    { id: 'b/2', provider: 'b', model: '2' },
  ]);
  assert.deepEqual(observedProviders(entries), ['a', 'b']);
});

test('ensureModelRules adds defaults for observed models without clobbering saved values', () => {
  const savedRule = normalizeModelRule({ base: { input: 9, output: 10 }, longContextThreshold: 5000 });
  const config = {
    ...makeConfig({}),
    models: { 'a/1': savedRule },
    currency: 'USD',
    balances: { a: { amount: 5, baselineCost: 0, updatedAt: 0 } },
  };

  const next = ensureModelRules(config, [
    { id: 'a/1', provider: 'a', model: '1' },
    { id: 'b/2', provider: 'b', model: '2' },
  ]);

  assert.notEqual(next, config);
  assert.notEqual(next.models, config.models);
  assert.deepEqual(next.models['a/1'], savedRule);
  assert.deepEqual(next.models['b/2'], normalizeModelRule({}));
  assert.equal(config.models['b/2'], undefined); // input config stays untouched
  assert.equal(next.currency, 'USD');
  assert.deepEqual(next.balances, config.balances);
});

test('selectTier handles a missing rule and a base-only rule', () => {
  const baseOnly = normalizeModelRule({ base: BASE });
  assert.deepEqual(selectTier(null, 100, NOON_WED), { tier: 'base', price: emptyPriceSet() });
  assert.equal(selectTier(baseOnly, 10, NOON_WED).tier, 'base');
  assert.deepEqual(selectTier(baseOnly, 10, NOON_WED).price, BASE);
  assert.equal(selectTier(baseOnly, 10, local(2026, 5, 10, 7, 0)).tier, 'base');
});

test('parseClock and formatClock edge cases', () => {
  assert.equal(parseClock('00:30'), 30);
  assert.equal(parseClock('8:05'), 485);
  assert.equal(parseClock(' 09:15 '), 555);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('12:60'), null);
  assert.equal(parseClock('12'), null);
  assert.equal(parseClock('0:0'), null);
  assert.equal(parseClock('001:00'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(null), null);

  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(30), '00:30');
  assert.equal(formatClock(510), '08:30');
  assert.equal(formatClock(89.6), '01:30');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(24 * 60), '23:59');
});

test('local calendar helpers use the machine-local day', () => {
  assert.equal(isWeekend(local(2026, 5, 13, 12, 0)), true); // Saturday
  assert.equal(isWeekend(local(2026, 5, 14, 0, 0)), true); // Sunday
  assert.equal(isWeekend(local(2026, 5, 15, 12, 0)), false); // Monday
  assert.equal(localDayKey(local(2026, 0, 1, 23, 59)), '2026-01-01');
  assert.equal(localDayKey(local(2026, 11, 31, 0, 0)), '2026-12-31');
  assert.equal(localDayKey(startOfLocalDay(local(2026, 5, 15, 15, 30))), '2026-06-15');
  assert.ok(startOfLocalDay(local(2026, 5, 15, 15, 30)) <= local(2026, 5, 15, 15, 30));
  assert.equal(localMinuteOfDay(local(2026, 5, 15, 7, 5)), 425);
  assert.equal(localMinuteOfDay(local(2026, 5, 15, 23, 59)), 1439);
});
