/**
 * Pure pricing and aggregation rules for the token-usage panel.
 *
 * Every function here is deterministic and free of Host services so the same
 * code can be unit-tested from Node and reused by the Host entry. Cost is
 * always derived from stored token counts with the CURRENT price configuration,
 * which is why folding keeps per-call entries instead of folding cost.
 *
 * Price selection order for one call: long-context tier > valley tier > base.
 * Prices are currency units per 1,000,000 tokens.
 */

/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} PriceSet */
/** @typedef {{ t: number, provider: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }} UsageEntry */
/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }} Usage */

export const DEFAULT_CURRENCY = 'CNY';
export const DEFAULT_VALLEY_START = '18:00';
export const DEFAULT_VALLEY_END = '09:00';
export const DEFAULT_LONG_CONTEXT_THRESHOLD = 272000;
export const STAT_PERIODS = ['session', 'today', 'week', 'month', 'all'];
export const DAILY_SPAN_DAYS = 14;

/** Zero token counts. */
export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** A zero price set. */
export function emptyPriceSet() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Sum two usage records into a fresh record. */
export function addUsage(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** Total billed tokens of one usage record. */
export function usageTotal(u) {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** Prompt size of one call, i.e. every input-side token. */
export function promptTokens(entry) {
  return entry.input + entry.cacheRead + entry.cacheWrite;
}

/** Clamp any incoming value into a non-negative finite number. */
function nonNegative(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read one of the four price fields. */
function priceNumber(value, family) {
  return nonNegative(value && value[family]);
}

/**
 * Normalize one price set. A missing or non-object value stays `null` so the
 * tier is genuinely absent instead of silently free.
 * @param {unknown} raw
 * @returns {PriceSet | null}
 */
export function normalizePriceSet(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    input: priceNumber(raw, 'input'),
    output: priceNumber(raw, 'output'),
    cacheRead: priceNumber(raw, 'cacheRead'),
    cacheWrite: priceNumber(raw, 'cacheWrite'),
  };
}

/** Parse `HH:MM` into minutes after midnight, or `null`. */
export function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Format minutes after midnight back into `HH:MM`. */
export function formatClock(minutes) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Normalize one model's price rule. */
export function normalizeModelRule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const window = source.valleyWindow && typeof source.valleyWindow === 'object' ? source.valleyWindow : {};
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  const holidays = Array.isArray(source.holidays)
    ? [...new Set(source.holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)))]
    : [];
  const threshold = nonNegative(source.longContextThreshold, DEFAULT_LONG_CONTEXT_THRESHOLD);
  return {
    base: normalizePriceSet(source.base) ?? emptyPriceSet(),
    valley: normalizePriceSet(source.valley),
    long: normalizePriceSet(source.long),
    valleyWindow: {
      start: start === null ? DEFAULT_VALLEY_START : formatClock(start),
      end: end === null ? DEFAULT_VALLEY_END : formatClock(end),
      weekends: window.weekends === true,
      holidays: window.holidays === true,
    },
    holidays,
    longContextThreshold: Math.round(threshold),
  };
}

/** Normalize a whole persisted state document, dropping unknown fields. */
export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const models = {};
  if (source.models && typeof source.models === 'object' && !Array.isArray(source.models)) {
    for (const [key, value] of Object.entries(source.models)) {
      if (typeof key !== 'string' || key.length === 0) continue;
      models[key] = normalizeModelRule(value);
    }
  }
  const balances = {};
  if (source.balances && typeof source.balances === 'object' && !Array.isArray(source.balances)) {
    for (const [provider, value] of Object.entries(source.balances)) {
      if (typeof provider !== 'string' || provider.length === 0 || !value || typeof value !== 'object') continue;
      const amount = Number(value.amount);
      if (!Number.isFinite(amount)) continue;
      balances[provider] = {
        amount,
        baselineCost: nonNegative(value.baselineCost),
        updatedAt: nonNegative(value.updatedAt),
      };
    }
  }
  return {
    version: 1,
    currency: typeof source.currency === 'string' && source.currency.trim() !== '' ? source.currency.trim() : DEFAULT_CURRENCY,
    models,
    balances,
  };
}

/** The model key used by the configuration and by every usage aggregation. */
export function modelKey(provider, model) {
  return `${provider}/${model}`;
}

/** Resolve the rule for one model route. */
export function ruleFor(config, provider, model) {
  const models = config && config.models ? config.models : {};
  return models[modelKey(provider, model)];
}

/** Whether a price set contains at least one non-zero price. */
export function isPriced(price) {
  return price !== null && price !== undefined
    && (price.input > 0 || price.output > 0 || price.cacheRead > 0 || price.cacheWrite > 0);
}

/** Whether a model has any billed base price (used for the unpriced marker). */
export function isModelPriced(config, provider, model) {
  const rule = ruleFor(config, provider, model);
  return isPriced(rule && rule.base);
}

// ── Local calendar helpers (the Host runs on the user's machine) ───────────

/** Start of the local day containing `ms`. */
export function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local `YYYY-MM-DD` day key of `ms`. */
export function localDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Minutes after local midnight. */
export function localMinuteOfDay(ms) {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

/** Whether `ms` falls on a local Saturday or Sunday. */
export function isWeekend(ms) {
  const day = new Date(ms).getDay();
  return day === 0 || day === 6;
}

/**
 * Whether one call time falls in its model's valley pricing.
 * @param {ReturnType<typeof normalizeModelRule>} rule
 * @param {number} ms
 */
export function isValleyTime(rule, ms) {
  if (!rule || !rule.valley) return false;
  const window = rule.valleyWindow;
  if (window.weekends === true && isWeekend(ms)) return true;
  if (window.holidays === true && rule.holidays.includes(localDayKey(ms))) return true;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null || end === null) return false;
  if (start === end) return true;
  const minute = localMinuteOfDay(ms);
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/**
 * Select the price tier for one call.
 * @returns {{ tier: 'long' | 'valley' | 'base', price: PriceSet }}
 */
export function selectTier(rule, prompt, ms) {
  const base = rule && rule.base ? rule.base : emptyPriceSet();
  if (!rule) return { tier: 'base', price: base };
  const threshold = rule.longContextThreshold;
  if (rule.long && threshold > 0 && prompt > threshold) return { tier: 'long', price: rule.long };
  if (rule.valley && isValleyTime(rule, ms)) return { tier: 'valley', price: rule.valley };
  return { tier: 'base', price: base };
}

/**
 * Price one usage entry against the current configuration.
 * @param {UsageEntry} entry
 * @param {ReturnType<typeof normalizeState>} config
 */
export function costOf(entry, config) {
  const rule = ruleFor(config, entry.provider, entry.model);
  const prompt = promptTokens(entry);
  const picked = selectTier(rule, prompt, entry.t);
  const price = picked.price;
  const cost = (
    entry.input * price.input
    + entry.output * price.output
    + entry.reasoning * price.output
    + entry.cacheRead * price.cacheRead
    + entry.cacheWrite * price.cacheWrite
  ) / 1_000_000;
  return { cost, tier: picked.tier, priced: isPriced(price) };
}

// ── Folding a Session log ──────────────────────────────────────────────────

/**
 * Fold one session's events into per-call usage entries.
 *
 * Only final assistant messages carry trustworthy usage; streaming attempts are
 * skipped so one call is never counted twice.
 * @param {ReadonlyArray<{ type: string, time: number, data: any }>} events
 * @returns {UsageEntry[]}
 */
export function foldSessionEvents(events) {
  const entries = [];
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue;
    const usage = event.data && event.data.usage;
    const message = event.data && event.data.message;
    const source = message && message.source;
    if (!usage || !source || source.kind !== 'model') continue;
    const provider = typeof source.provider === 'string' ? source.provider : '';
    const model = typeof source.model === 'string' ? source.model : '';
    if (provider === '' || model === '') continue;
    const input = nonNegative(usage.inputTokens);
    const output = nonNegative(usage.outputTokens);
    const cacheRead = nonNegative(usage.cacheReadTokens);
    const cacheWrite = nonNegative(usage.cacheWriteTokens);
    const reasoning = nonNegative(usage.reasoningTokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    entries.push({
      t: typeof event.time === 'number' ? event.time : 0,
      provider,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
    });
  }
  return entries;
}

// ── Aggregation ────────────────────────────────────────────────────────────

/** Local day boundaries for the five periods, relative to `now`. */
export function periodBounds(now) {
  const today = startOfLocalDay(now);
  // Local days are not always 24h across DST changes: walk calendar days.
  const dayBack = (count) => {
    const date = new Date(today);
    date.setDate(date.getDate() - count);
    return date.getTime();
  };
  return {
    session: { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
    today: { from: today, to: Number.POSITIVE_INFINITY },
    week: { from: dayBack(6), to: Number.POSITIVE_INFINITY },
    month: { from: dayBack(29), to: Number.POSITIVE_INFINITY },
    all: { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
  };
}

/**
 * Aggregate one entry list over the five periods.
 * @param {UsageEntry[]} sessionEntries entries of the session scope only
 * @param {UsageEntry[]} allEntries every entry in the corpus
 * @param {ReturnType<typeof normalizeState>} config
 * @param {number} now
 */
export function aggregate(sessionEntries, allEntries, config, now) {
  const bounds = periodBounds(now);
  const periods = {};
  for (const period of STAT_PERIODS) {
    const source = period === 'session' ? sessionEntries : allEntries;
    periods[period] = aggregatePeriod(source, config, period === 'session' ? null : bounds[period]);
  }
  return periods;
}

/** Aggregate one period, including its per-model breakdown. */
export function aggregatePeriod(entries, config, range) {
  const models = new Map();
  const tokens = emptyUsage();
  let cost = 0;
  let calls = 0;
  const unpriced = new Set();
  for (const entry of entries) {
    if (range && (entry.t < range.from || entry.t >= range.to)) continue;
    calls += 1;
    tokens.input += entry.input;
    tokens.output += entry.output;
    tokens.cacheRead += entry.cacheRead;
    tokens.cacheWrite += entry.cacheWrite;
    tokens.reasoning += entry.reasoning;
    const result = costOf(entry, config);
    if (!result.priced) {
      unpriced.add(modelKey(entry.provider, entry.model));
    }
    cost += result.cost;
    const key = modelKey(entry.provider, entry.model);
    let row = models.get(key);
    if (!row) {
      row = {
        id: key,
        provider: entry.provider,
        model: entry.model,
        calls: 0,
        cost: 0,
        tokens: emptyUsage(),
      };
      models.set(key, row);
    }
    row.calls += 1;
    row.cost += result.cost;
    row.tokens.input += entry.input;
    row.tokens.output += entry.output;
    row.tokens.cacheRead += entry.cacheRead;
    row.tokens.cacheWrite += entry.cacheWrite;
    row.tokens.reasoning += entry.reasoning;
  }
  const rows = [...models.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls || a.id.localeCompare(b.id));
  return { calls, cost, tokens, models: rows, unpriced: [...unpriced] };
}

/**
 * Daily series for the last {@link DAILY_SPAN_DAYS} local days, including today.
 * @param {UsageEntry[]} allEntries
 * @param {ReturnType<typeof normalizeState>} config
 * @param {number} now
 */
export function dailySeries(allEntries, config, now) {
  const today = startOfLocalDay(now);
  const days = [];
  for (let back = DAILY_SPAN_DAYS - 1; back >= 0; back -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - back);
    const from = date.getTime();
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    days.push({ day: localDayKey(from), from, to: next.getTime(), tokens: emptyUsage(), cost: 0 });
  }
  for (const entry of allEntries) {
    for (const day of days) {
      if (entry.t < day.from || entry.t >= day.to) continue;
      day.tokens.input += entry.input;
      day.tokens.output += entry.output;
      day.tokens.cacheRead += entry.cacheRead;
      day.tokens.cacheWrite += entry.cacheWrite;
      day.tokens.reasoning += entry.reasoning;
      day.cost += costOf(entry, config).cost;
      break;
    }
  }
  return days.map(({ day, tokens, cost }) => ({ day, tokens, cost }));
}

/**
 * All providers and models that appear in a corpus.
 * @param {UsageEntry[]} allEntries
 */
export function observedModels(allEntries) {
  const seen = new Map();
  for (const entry of allEntries) {
    const key = modelKey(entry.provider, entry.model);
    seen.set(key, { id: key, provider: entry.provider, model: entry.model });
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Providers that appear in one entry list (current session first).
 * @param {UsageEntry[]} entries
 */
export function observedProviders(entries) {
  const seen = new Set();
  for (const entry of entries) seen.add(entry.provider);
  return [...seen].sort();
}

/** Fill every observed model into the configuration with default rules. */
export function ensureModelRules(config, models) {
  const next = { ...config, models: { ...config.models } };
  for (const model of models) {
    if (!next.models[model.id]) next.models[model.id] = normalizeModelRule({});
  }
  return next;
}
