/**
 * Where resources live. A store keeps every version of each resource, and a write names the
 * version it was based on, so a write based on an older one is refused rather than overwriting a
 * change it never saw. That check is the store's, so it holds when the agent and the host write at
 * once. The file store is in file-store.ts, apart, since it needs Node and this file must load in a
 * browser or a Worker.
 */

export type Stored<T = unknown> = {
  value: T;
  /** 1 for the first write, then one more for each write after it. 0 for a resource never written, holding its initial value. */
  version: number;
  writtenAt: string;
  /** Who wrote this version: the agent's id, or the host's name for itself. */
  writtenBy: string;
};

export type ResourceStore = {
  /** The newest version, or undefined when the resource has never been written. */
  get(name: string): Promise<Stored | undefined>;
  /**
   * Saves `value` as the next version and returns it, when the newest version is `expected` (0 when
   * there is none). Otherwise saves nothing and returns undefined.
   */
  put(name: string, value: unknown, expected: number, by: string): Promise<Stored | undefined>;
  /** Every version, oldest first. Empty when there is none. */
  history(name: string): Promise<Stored[]>;
};

export function memoryResourceStore(): ResourceStore {
  const resources = new Map<string, Stored[]>();
  return {
    async get(name) {
      return resources.get(name)?.at(-1);
    },
    async put(name, value, expected, by) {
      const versions = resources.get(name) ?? [];
      if ((versions.at(-1)?.version ?? 0) !== expected) return undefined;
      const stored: Stored = { value: structuredClone(value), version: expected + 1, writtenAt: new Date().toISOString(), writtenBy: by };
      resources.set(name, [...versions, stored]);
      return stored;
    },
    async history(name) {
      return [...(resources.get(name) ?? [])];
    },
  };
}
