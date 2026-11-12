/**
 * Session-corpus reader for the token-usage panel.
 *
 * The durable Session log is the source of truth. Live Sessions are folded from
 * their in-memory events so a running turn appears immediately; every other
 * Session is read through the persistence backend. A fold is cached per Session
 * and invalidated by that Session's revision (persistence revision for stored
 * Sessions, sequence number for live ones), so a refresh only re-reads Sessions
 * that changed.
 */
import {
  aggregate,
  dailySeries,
  ensureModelRules,
  foldSessionEvents,
  isPriced,
  localDayKey,
  observedModels,
  usageTotal,
} from './stats.js';

/** How long a corpus listing may be reused by rapid follow-up requests. */
const CORPUS_TTL_MS = 1200;
/** Persisted Session reads in flight at once. */
const READ_CONCURRENCY = 4;

/** Stable string form of a branded Session id. */
function idOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** Collect the ids of one Session plus its subagent descendants. */
export function subagentScopeIds(headers, rootId) {
  const ids = new Set([rootId]);
  if (rootId === '') return ids;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, header] of headers) {
      if (ids.has(id)) continue;
      const parent = header && header.parentSession !== undefined ? idOf(header.parentSession) : '';
      if (parent === '' || !ids.has(parent)) continue;
      const depth = typeof (header && header.delegationDepth) === 'number' ? header.delegationDepth : 0;
      if ((header && header.origin === 'subagent') || depth > 0) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Provider display names from the LLM registry plus the configured-provider catalog. */
function readProviderNames(ctx) {
  const names = new Map();
  const llm = ctx.get('llm');
  if (llm && typeof llm.listConfigurableProviders === 'function') {
    try {
      for (const entry of llm.listConfigurableProviders()) {
        const id = idOf(entry && entry.provider);
        if (id !== '' && typeof entry.displayName === 'string' && entry.displayName !== '') names.set(id, entry.displayName);
      }
    } catch {
      // The catalog is advisory; missing entries fall back to the raw id.
    }
  }
  if (llm && typeof llm.listProviders === 'function') {
    try {
      for (const entry of llm.listProviders()) {
        const id = idOf(entry && entry.id);
        if (id !== '' && typeof entry.name === 'string' && entry.name !== '') names.set(id, entry.name);
      }
    } catch {
      // Same: provider names are cosmetic.
    }
  }
  return names;
}

/**
 * Provider/model of a Session's latest request context or request header, so
 * the balance chip can follow the model the Session currently runs even before
 * that model produces any usage.
 */
export function readModelContext(events) {
  let latest = null;
  for (const event of events) {
    if (!event) continue;
    const type = event.type;
    let provider = '';
    let model = '';
    if (type === 'request/context') {
      const data = event.data;
      if (data && typeof data.provider === 'string') provider = data.provider;
      if (data && typeof data.model === 'string') model = data.model;
    } else if (type === 'request/header') {
      const config = event.data && event.data.header && event.data.header.config;
      if (config && typeof config.provider === 'string') provider = config.provider;
      if (config && typeof config.model === 'string') model = config.model;
    }
    if (provider !== '' && model !== '') latest = { provider, model };
  }
  return latest;
}

/** Display name of one route/provider, falling back to the raw id. */
export function providerDisplayName(names, provider) {
  return names.get(provider) ?? provider;
}

/**
 * Create one corpus reader bound to the Host context.
 * @param {import('cordis').Context} ctx
 */
export function createEngine(ctx) {
  /** @type {Map<string, { rev: string, entries: any[], maxTime: number, model: { provider: string, model: string } | null }>} */
  const foldCache = new Map();
  /** @type {{ at: number, headers: Map<string, any>, ids: string[], errors: number } | null} */
  let corpusCache = null;
  let listingFailed = false;

  async function readLive(session) {
    try {
      return Array.from(session.snapshotEvents());
    } catch {
      return null;
    }
  }

  async function readPersisted(id) {
    const persistence = ctx.get('sessionPersistence');
    if (!persistence || typeof persistence.open !== 'function') return null;
    let handle;
    try {
      handle = await persistence.open(id, 'read');
      const result = await handle.read();
      return Array.isArray(result && result.events) ? result.events : [];
    } catch {
      return null;
    } finally {
      if (handle && typeof handle.close === 'function') {
        try {
          await handle.close();
        } catch {
          // A closing failure must not hide a successful read.
        }
      }
    }
  }

  /**
   * List the corpus with a fresh revision for every live Session. The persisted
   * listing is reused briefly (it costs a directory scan); live Sessions are
   * refreshed every call so a running turn shows up immediately.
   */
  async function listCorpus(now) {
    if (!corpusCache || now - corpusCache.at >= CORPUS_TTL_MS || listingFailed) {
      const headers = new Map();
      const ids = new Set();
      const revisions = new Map();
      let failed = false;
      const persistence = ctx.get('sessionPersistence');
      if (persistence && typeof persistence.list === 'function') {
        try {
          const snapshots = await persistence.list();
          for (const snapshot of snapshots) {
            const id = idOf(snapshot && snapshot.header && snapshot.header.id);
            if (id === '') continue;
            ids.add(id);
            if (!headers.has(id)) headers.set(id, snapshot.header);
            revisions.set(id, `P${idOf(snapshot.revision)}`);
          }
        } catch {
          failed = true;
        }
      }
      listingFailed = failed;
      if (!failed) corpusCache = { at: now, headers, ids: [...ids], revisions };
      else if (!corpusCache) corpusCache = { at: now, headers, ids: [], revisions };
    }
    const headers = new Map(corpusCache.headers);
    const ids = new Set(corpusCache.ids);
    const revisions = new Map(corpusCache.revisions);
    const liveSessions = new Map();
    const sessions = ctx.get('sessions');
    if (sessions && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        const id = idOf(session.id);
        if (id === '') continue;
        liveSessions.set(id, session);
        headers.set(id, session.header);
        ids.add(id);
        revisions.set(id, `L${idOf(session.seq)}`);
      }
    }
    return { headers, ids: [...ids], revisions, liveSessions, listingFailed };
  }
  /** Read and fold one Session, honoring the revision cache. */
  async function foldOne(id, revision, liveSession) {
    const cached = foldCache.get(id);
    if (cached && cached.rev === revision) return cached;
    const events = liveSession ? await readLive(liveSession) : await readPersisted(id);
    if (events === null) return null;
    const entries = foldSessionEvents(events);
    let maxTime = 0;
    for (const entry of entries) if (entry.t > maxTime) maxTime = entry.t;
    const fold = { rev: revision, entries, maxTime, model: readModelContext(events) };
    foldCache.set(id, fold);
    return fold;
  }

  /**
   * Build the folded corpus for the overview.
   * @param {number} now
   */
  async function corpus(now) {
    const listed = await listCorpus(now);
    const entriesById = new Map();
    const modelById = new Map();
    let incomplete = 0;
    const queue = [...listed.ids];
    const workers = new Array(Math.min(READ_CONCURRENCY, Math.max(1, queue.length))).fill(null).map(async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        const fold = await foldOne(id, listed.revisions.get(id) ?? '', listed.liveSessions.get(id));
        if (fold === null) {
          incomplete += 1;
          continue;
        }
        entriesById.set(id, fold.entries);
        if (fold.model) modelById.set(id, fold.model);
      }
    });
    await Promise.all(workers);
    // Forget Sessions the corpus no longer lists.
    const live = new Set(listed.ids);
    for (const id of foldCache.keys()) if (!live.has(id)) foldCache.delete(id);
    return { headers: listed.headers, entriesById, modelById, incomplete: incomplete > 0 || listed.listingFailed };
  }

  /**
   * Compute the panel overview.
   * @param {{ sessionId: string | null, config: any, store: any, now?: number }} input
   */
  async function overview({ sessionId, config, store, now = Date.now() }) {
    const { headers, entriesById, modelById, incomplete } = await corpus(now);
    const allEntries = [];
    for (const entries of entriesById.values()) for (const entry of entries) allEntries.push(entry);
    const rootId = sessionId === null || sessionId === undefined ? '' : idOf(sessionId);
    const scope = rootId === '' ? new Set() : subagentScopeIds(headers, rootId);
    const sessionEntries = [];
    for (const id of scope) {
      const entries = entriesById.get(id);
      if (entries) for (const entry of entries) sessionEntries.push(entry);
    }
    // The current Session's provider: latest request context first, then the
    // most recent usage, so the balance chip follows the active model.
    const sessionProviders = [];
    for (let i = sessionEntries.length - 1; i >= 0; i -= 1) {
      const provider = sessionEntries[i].provider;
      if (provider !== '' && !sessionProviders.includes(provider)) sessionProviders.push(provider);
    }
    const rootContext = modelById.get(rootId) ?? null;
    const sessionProvider = rootContext !== null
      ? rootContext.provider
      : (sessionProviders.length > 0 ? sessionProviders[0] : null);

    const withRules = ensureModelRules(config, observedModels(allEntries));
    const periods = aggregate(sessionEntries, allEntries, withRules, now);
    const daily = dailySeries(allEntries, withRules, now)
      .map((day) => ({ ...day, tokens: { ...day.tokens, total: usageTotal(day.tokens) } }));
    const names = readProviderNames(ctx);

    // All-time cost per provider feeds the manual-balance deduction.
    const providerCost = new Map();
    for (const row of periods.all.models) {
      providerCost.set(row.provider, (providerCost.get(row.provider) ?? 0) + row.cost);
    }

    const balanceRows = [];
    const scopeProviders = [...new Set(sessionEntries.map((entry) => entry.provider))];
    const editableProviders = scopeProviders.length > 0
      ? scopeProviders
      : [...new Set(allEntries.map((entry) => entry.provider))];
    const balanceProviders = new Set([...scopeProviders, ...Object.keys(withRules.balances), ...editableProviders]);
    for (const provider of balanceProviders) {
      const saved = withRules.balances[provider];
      const cost = providerCost.get(provider) ?? 0;
      balanceRows.push({
        provider,
        name: providerDisplayName(names, provider),
        hasBalance: saved !== undefined,
        amount: saved === undefined ? null : saved.amount,
        remaining: saved === undefined ? null : saved.amount - (cost - saved.baselineCost),
        currency: withRules.currency,
        editable: editableProviders.includes(provider),
      });
    }
    balanceRows.sort((a, b) => Number(b.hasBalance) - Number(a.hasBalance) || a.name.localeCompare(b.name));

    const unpriced = new Set();
    for (const period of Object.values(periods)) for (const id of period.unpriced ?? []) unpriced.add(id);

    const models = observedModels(allEntries).map((model) => ({
      ...model,
      priced: (() => {
        const rule = withRules.models[model.id];
        if (!rule) return false;
        return isPriced(rule.base) || isPriced(rule.valley) || isPriced(rule.long);
      })(),
    }));

    const periodValue = {};
    for (const [period, value] of Object.entries(periods)) {
      periodValue[period] = {
        calls: value.calls,
        cost: value.cost,
        tokens: { ...value.tokens, total: usageTotal(value.tokens) },
        models: value.models.map((row) => ({
          ...row,
          tokens: { ...row.tokens, total: usageTotal(row.tokens) },
        })),
      };
    }

    const providers = [...new Set([...names.keys(), ...models.map((model) => model.provider)])]
      .sort()
      .map((id) => ({ id, name: providerDisplayName(names, id) }));

    return {
      generatedAt: now,
      sessionId: rootId === '' ? null : rootId,
      currency: withRules.currency,
      sessionProvider,
      sessionProviders,
      config: withRules,
      providers,
      models,
      balances: balanceRows,
      periods: periodValue,
      daily,
      unpriced: [...unpriced].sort(),
      incomplete: incomplete > 0,
      today: localDayKey(now),
    };
  }

  return { overview, corpus };
}
