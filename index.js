/**
 * Host half of the token-usage panel.
 *
 * It owns the durable price/balance state and exposes it to the panel over one
 * fenced POST route. The Client half (client.js) renders the sidebar entry and
 * the main panel; everything numeric is computed here from the Session log.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createEngine } from './engine.js';
import { normalizeState } from './stats.js';
import { createStateStore, resolveDshHome } from './store.js';

export const name = 'dsh-token-usage';
export const inject = [];

/** Route prefix shared with the Client half. */
const ROUTE_PATH = '/token-usage/api';
/** Upper bound for one request body; config payloads are small. */
const BODY_LIMIT = 1024 * 1024;

/** Write one JSON response. */
function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Success envelope. */
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

/** Failure envelope. */
function writeError(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } });
}

/** Read a request body as UTF-8 text, enforcing {@link BODY_LIMIT}. */
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT) {
      const error = new Error('request body too large');
      error.code = 'too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Diagnostic directory under the Harness home. */
function diagnosticDir() {
  return join(resolveDshHome(), 'token-usage');
}

/** Best-effort JSON write for diagnostics; never fails the plugin. */
async function writeDiagnostic(file, value) {
  try {
    const target = join(diagnosticDir(), file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // Diagnostics are optional.
  }
}

/** Round money to sub-cent precision. */
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function apply(ctx) {
  const store = createStateStore();
  const engine = createEngine(ctx);
  const logger = ctx.logger ?? ctx.get('logger');

  // Diagnostics are written through one queue so concurrent requests cannot
  // interleave their files.
  let diagnosticQueue = Promise.resolve();
  const recordDiagnostic = (file, value) => {
    diagnosticQueue = diagnosticQueue.then(() => writeDiagnostic(file, value)).catch(() => {});
    return diagnosticQueue;
  };

  /** Authorization fence: the same rule the Harness web routes use. */
  const allowed = (req) => {
    const connection = ctx.get('connection');
    if (!connection || typeof connection.requestRejection !== 'function') return true;
    return connection.requestRejection(req) === undefined;
  };

  /**
   * Compute the overview for one optional Session id.
   * @param {string | null} sessionId
   */
  async function buildOverview(sessionId) {
    const config = await store.read();
    return engine.overview({ sessionId, config, store, now: Date.now() });
  }

  /** `overview`: everything the panel renders. */
  async function handleOverview(payload) {
    const raw = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    return buildOverview(raw === '' ? null : raw);
  }

  /** `saveConfig`: replace prices/currency; balances stay untouched. */
  async function handleSaveConfig(payload) {
    const incoming = payload && typeof payload.config === 'object' && payload.config !== null ? payload.config : {};
    const saved = await store.update((draft) => {
      const merged = normalizeState({ ...draft, ...incoming, balances: draft.balances });
      return merged;
    });
    return { config: saved };
  }

  /** `saveBalance`: anchor a manual balance to the provider's current total cost. */
  async function handleSaveBalance(payload) {
    const provider = payload && typeof payload.provider === 'string' ? payload.provider : '';
    if (provider === '') {
      const error = new Error('provider is required');
      error.code = 'bad-request';
      throw error;
    }
    const rawAmount = payload.amount;
    let amount = null;
    if (rawAmount !== null && rawAmount !== undefined) {
      const numeric = Number(rawAmount);
      if (!Number.isFinite(numeric)) {
        const error = new Error('amount must be a finite number or null');
        error.code = 'bad-request';
        throw error;
      }
      amount = numeric;
    }
    const before = await buildOverview(null);
    let providerCost = 0;
    for (const row of before.periods.all.models) {
      if (row.provider === provider) providerCost += row.cost;
    }
    const updatedAt = Date.now();
    await store.update((draft) => {
      if (amount === null) {
        delete draft.balances[provider];
        return;
      }
      draft.balances[provider] = {
        amount,
        baselineCost: roundCost(providerCost),
        updatedAt,
      };
    });
    const after = await buildOverview(null);
    return { balances: after.balances };
  }

  const actions = new Map([
    ['overview', handleOverview],
    ['saveConfig', handleSaveConfig],
    ['saveBalance', handleSaveBalance],
  ]);

  async function handler(req, res) {
    let record = { at: new Date().toISOString(), action: null, ok: false };
    try {
      if (!allowed(req)) {
        writeError(res, 403, 'forbidden', 'forbidden');
        return;
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-error', 'method not allowed');
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const suffix = pathname.startsWith(ROUTE_PATH) ? pathname.slice(ROUTE_PATH.length) : pathname;
      if (suffix !== '' && suffix !== '/') {
        writeError(res, 404, 'not-found', 'unknown endpoint');
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '');
      if (contentType !== '' && !contentType.toLowerCase().includes('application/json')) {
        writeError(res, 415, 'unsupported-media-type', 'content-type must be application/json');
        return;
      }
      let text;
      try {
        text = await readBody(req);
      } catch (error) {
        writeError(res, 413, 'too-large', error instanceof Error ? error.message : 'request body too large');
        return;
      }
      let message;
      try {
        message = JSON.parse(text === '' ? '{}' : text);
      } catch {
        writeError(res, 400, 'bad-json', 'request body must be JSON');
        return;
      }
      const action = message && typeof message.action === 'string' ? message.action : '';
      record.action = action === '' ? null : action;
      const run = actions.get(action);
      if (!run) {
        writeError(res, 404, 'not-found', `unknown action "${action}"`);
        record.error = 'unknown action';
        return;
      }
      const value = await run(message.payload);
      record.ok = true;
      record.sessionId = value && typeof value.sessionId === 'string' ? value.sessionId : undefined;
      writeOk(res, value);
    } catch (error) {
      const known = error && typeof error.code === 'string';
      const status = known && error.code === 'bad-request' ? 400 : 500;
      record.error = error instanceof Error ? error.message : String(error);
      if (logger && typeof logger.warn === 'function') logger.warn('dsh-token-usage: request failed: %s', record.error);
      writeError(res, status, known ? error.code : 'internal', record.error);
    } finally {
      void recordDiagnostic('last-request.json', record);
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
      'dsh-token-usage: api route',
    );
  });

  // Self-check on mount: fold the real Session log once and record it, so the
  // installation can be verified without browser access to the panel.
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        const overview = await buildOverview(null);
        await writeDiagnostic('self-check.json', {
          at: new Date().toISOString(),
          stateFile: store.file,
          route: ROUTE_PATH,
          sessionId: overview.sessionId,
          providers: overview.providers,
          models: overview.models,
          periods: Object.fromEntries(
            Object.entries(overview.periods).map(([period, value]) => [
              period,
              { calls: value.calls, cost: value.cost, total: value.tokens.total },
            ]),
          ),
          balances: overview.balances,
          incomplete: overview.incomplete,
        });
      } catch (error) {
        await writeDiagnostic('self-check.json', {
          at: new Date().toISOString(),
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }, 2500);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, 'dsh-token-usage: self check');
}
