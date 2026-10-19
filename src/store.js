// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the end of a 429 pause, so a restart never reads a station that
// asked to slow down before its time (bounded when read back: never more
// than the longest pause, 6 h, away), and the ID last given at each address.
// No secret: the local API has none. The
// file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/trydan-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/**
 * The persisted state, repaired and bounded:
 * `{ pause: { until } | null, ids: { [address]: ID } }` — `ids`: the ID last
 * given at each address, so a read without ID keeps its device (16 at most,
 * own keys only, strict patterns).
 */
export function normalizeMemory(raw, now) {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const until = object.pause?.until;
  const ids = Object.create(null);
  const saved = Object.hasOwn(object, 'ids') ? object.ids : undefined;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [key, id] of Object.entries(saved).slice(0, 16)) {
      if (
        /^[0-9a-z.:-]{1,260}$/.test(key) &&
        typeof id === 'string' &&
        /^[0-9a-z]{1,64}$/.test(id)
      ) {
        ids[key] = id;
      }
    }
  }
  return {
    pause:
      Number.isFinite(until) && until > now
        ? { until: Math.min(until, now + TIMINGS.rateLimitMax) }
        : null,
    ids,
  };
}
