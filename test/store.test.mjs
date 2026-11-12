import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../store.js';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-usage-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('missing state file starts with defaults', async () => {
  await withTempDir(async (dir) => {
    const store = createStateStore(join(dir, 'state.json'));
    assert.equal((await store.read()).currency, 'CNY');
  });
});

test('invalid existing state rejects reads and cannot be overwritten by update', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{broken', 'utf8');
    const store = createStateStore(file);

    await assert.rejects(store.read(), SyntaxError);
    await assert.rejects(store.update((draft) => { draft.currency = 'USD'; }), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), '{broken');
  });
});

test('a rejected update does not poison later queued updates', async () => {
  await withTempDir(async (dir) => {
    const store = createStateStore(join(dir, 'state.json'));
    await assert.rejects(store.update(() => { throw new Error('mutation failed'); }), /mutation failed/);

    const state = await store.update((draft) => { draft.currency = 'USD'; });
    assert.equal(state.currency, 'USD');
    assert.equal((await store.read()).currency, 'USD');
  });
});
