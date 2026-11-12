/**
 * Durable plugin-owned state for the token-usage panel.
 *
 * The state lives in a JSON file under the Harness home instead of the plugin's
 * composition config: prices and balances are user data edited frequently from
 * the panel, and a config edit would restart the plugin on every save.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeState } from './stats.js';

/** Resolve the Harness home (`DSH_HOME`, else `~/.dsh`). */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return join(homedir(), '.dsh');
}

/** Absolute path of the persisted state document. */
export function stateFilePath() {
  return join(resolveDshHome(), 'token-usage', 'state.json');
}

/**
 * Read/write one normalized state document with serialized writers.
 * @param {string} [file]
 */
export function createStateStore(file = stateFilePath()) {
  /** @type {ReturnType<typeof normalizeState> | undefined} */
  let cached;
  let queue = Promise.resolve();

  async function read() {
    if (cached) return cached;
    let raw = {};
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    cached = normalizeState(raw);
    return cached;
  }

  async function save(next) {
    const state = normalizeState(next);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, file);
    cached = state;
    return state;
  }

  /**
   * Read-modify-write with the in-memory copy, serialized against other writers.
   * @param {(draft: ReturnType<typeof normalizeState>) => unknown} mutate
   */
  function update(mutate) {
    const operation = queue.then(async () => {
      const current = await read();
      const draft = JSON.parse(JSON.stringify(current));
      const result = mutate(draft);
      return save(result === undefined ? draft : result);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { file, read, save, update };
}
