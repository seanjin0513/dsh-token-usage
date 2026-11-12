import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, readModelContext } from '../engine.js';
import { normalizeState } from '../stats.js';

test('failed persisted-session listing marks overview incomplete', async () => {
  const services = {
    sessionPersistence: { list: async () => { throw new Error('storage unavailable'); } },
    sessions: { list: () => [] },
  };
  const engine = createEngine({ get: (name) => services[name] });

  const overview = await engine.overview({
    sessionId: null,
    config: normalizeState({}),
    store: {},
    now: 1_800_000_000_000,
  });

  assert.equal(overview.incomplete, true);
  assert.equal(overview.periods.all.calls, 0);
});

test('readModelContext keeps the latest provider and model', () => {
  const events = [
    { type: 'request/context', data: { provider: 'anthropic', model: 'claude-sonnet-4' } },
    { type: 'request/header', data: { header: { config: { provider: 'openai', model: 'gpt-5' } } } },
    { type: 'request/context', data: { provider: 'cnit', model: 'deepseek-flash' } },
    { type: 'assistant/message', data: {} },
  ];
  assert.deepEqual(readModelContext(events), { provider: 'cnit', model: 'deepseek-flash' });
  assert.equal(readModelContext([]), null);
  assert.equal(readModelContext([{ type: 'request/context', data: {} }]), null);
});

test('overview sessionProvider follows the Session request context', async () => {
  const events = [
    { type: 'request/context', seq: 1, time: 1000, data: { provider: 'anthropic', model: 'claude-sonnet-4' } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1001,
      data: {
        message: { role: 'assistant', source: { kind: 'model', provider: 'anthropic', model: 'claude-sonnet-4' } },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 },
      },
    },
    { type: 'request/context', seq: 3, time: 1002, data: { provider: 'cnit', model: 'deepseek-flash' } },
  ];
  const services = {
    sessionPersistence: {
      list: async () => [{ header: { id: 'root', createdAt: 900 }, revision: 7 }],
      open: async () => ({
        read: async () => ({ events }),
        close: async () => undefined,
      }),
    },
    sessions: { list: () => [] },
  };
  const engine = createEngine({ get: (name) => services[name] });
  const overview = await engine.overview({
    sessionId: 'root',
    config: normalizeState({}),
    store: {},
    now: 2_000_000_000_000,
  });
  assert.equal(overview.sessionProvider, 'cnit');
  // sessionProviders lists providers with real usage; the current one comes from the request context.
  assert.deepEqual(overview.sessionProviders, ['anthropic']);
});
