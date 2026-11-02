/**
 * JSON Patch, RFC 6902, on plain JSON values. It never changes the value it is given: it works on
 * a copy and returns the result, or the first operation that failed and why.
 *
 * It is written here, rather than taken from a package, for its refusals: the agent reads them, so
 * each names the operation, the path and what is there instead, such as the members an object has.
 */

export type PatchOperation = { op: string; path: string; value?: unknown; from?: string };

type Json = unknown;
type Container = Record<string, Json> | Json[];

const OPS = ['add', 'remove', 'replace', 'move', 'copy', 'test'];
const INDEX = /^(0|[1-9][0-9]*)$/;
const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Equal as JSON values, ignoring key order. */
export function sameJson(a: Json, b: Json): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return a === b;
}

/** The tokens of a JSON Pointer, or throws when it is not one. */
function tokens(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`"${pointer}" is not a JSON Pointer. A path starts with /, such as /ola-card/prompt, or is "" for the whole value.`);
  return pointer.slice(1).split('/').map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));
}

const pointerOf = (parts: string[]) => (parts.length === 0 ? 'the whole value' : `/${parts.map((t) => t.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`);

/** What a container holds, for a refusal that says what is there instead. */
function describe(container: Container): string {
  if (Array.isArray(container)) return container.length === 0 ? 'it is an empty list' : `it is a list of ${container.length}, indexed 0 to ${container.length - 1}`;
  const keys = Object.keys(container);
  return keys.length === 0 ? 'it is an empty object' : `its members are ${keys.map((k) => JSON.stringify(k)).join(', ')}`;
}

/** The container a path's last token is in, which must exist. Throws with what is missing. */
function parentOf(root: { value: Json }, parts: string[]): Container {
  let at: Json = root.value;
  for (const [i, token] of parts.slice(0, -1).entries()) {
    const here = pointerOf(parts.slice(0, i));
    if (Array.isArray(at)) {
      if (!INDEX.test(token) || Number(token) >= at.length) throw new Error(`${here} has no item ${token}: ${describe(at)}.`);
      at = at[Number(token)];
    } else if (isObject(at)) {
      if (!Object.hasOwn(at, token)) throw new Error(`${here} has no member ${JSON.stringify(token)}: ${describe(at)}.`);
      at = at[token];
    } else {
      throw new Error(`${here} is ${JSON.stringify(at)}, which holds nothing, so it has no ${JSON.stringify(token)}.`);
    }
  }
  if (!Array.isArray(at) && !isObject(at)) throw new Error(`${pointerOf(parts.slice(0, -1))} is ${JSON.stringify(at)}, which holds nothing.`);
  return at;
}

function get(root: { value: Json }, parts: string[]): Json {
  if (parts.length === 0) return root.value;
  const parent = parentOf(root, parts);
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (!INDEX.test(last) || Number(last) >= parent.length) throw new Error(`There is nothing at ${pointerOf(parts)}: ${pointerOf(parts.slice(0, -1))} has no item ${last}, and ${describe(parent)}.`);
    return parent[Number(last)];
  }
  if (!Object.hasOwn(parent, last)) throw new Error(`There is nothing at ${pointerOf(parts)}: ${pointerOf(parts.slice(0, -1))} has no member ${JSON.stringify(last)}, and ${describe(parent)}.`);
  return parent[last];
}

function add(root: { value: Json }, parts: string[], value: Json): void {
  if (parts.length === 0) {
    root.value = value;
    return;
  }
  const parent = parentOf(root, parts);
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (last === '-') parent.push(value);
    else if (INDEX.test(last) && Number(last) <= parent.length) parent.splice(Number(last), 0, value);
    else throw new Error(`${pointerOf(parts)} is not a place in the list: use an index from 0 to ${parent.length}, or - to add at the end.`);
  } else {
    parent[last] = value;
  }
}

function remove(root: { value: Json }, parts: string[]): Json {
  if (parts.length === 0) throw new Error('The whole value cannot be removed. Replace it instead.');
  const removed = get(root, parts);
  const parent = parentOf(root, parts);
  if (Array.isArray(parent)) parent.splice(Number(parts.at(-1)), 1);
  else delete parent[parts.at(-1)!];
  return removed;
}

/** One operation, applied in place to `root.value`. Throws with what is wrong. */
function apply(root: { value: Json }, operation: PatchOperation): void {
  const path = tokens(operation.path);
  const needs = (key: 'value' | 'from') => {
    if (!Object.hasOwn(operation, key)) throw new Error(`A ${operation.op} operation needs a "${key}".`);
  };
  switch (operation.op) {
    case 'add':
      needs('value');
      return add(root, path, structuredClone(operation.value));
    case 'remove':
      remove(root, path);
      return;
    case 'replace':
      needs('value');
      get(root, path);
      if (path.length === 0) root.value = structuredClone(operation.value);
      else {
        remove(root, path);
        add(root, path, structuredClone(operation.value));
      }
      return;
    case 'move': {
      needs('from');
      const from = tokens(operation.from!);
      if (path.length > from.length && from.every((t, i) => t === path[i])) throw new Error(`${operation.path} is inside ${operation.from}, so it cannot move there.`);
      return add(root, path, remove(root, from));
    }
    case 'copy':
      needs('from');
      return add(root, path, structuredClone(get(root, tokens(operation.from!))));
    case 'test': {
      needs('value');
      const found = get(root, path);
      if (!sameJson(found, operation.value)) throw new Error(`The test failed: ${pointerOf(path)} is ${JSON.stringify(found)}.`);
      return;
    }
  }
}

/** Why a list is not a patch, or undefined when every operation is well formed. */
function malformed(patch: unknown): string | undefined {
  if (!Array.isArray(patch)) return 'The patch must be a JSON list of operations, such as [{"op": "replace", "path": "/ola-card/prompt", "value": "..."}].';
  for (const [i, operation] of patch.entries()) {
    const at = `Operation ${i + 1}`;
    if (!isObject(operation)) return `${at} is not an object.`;
    if (typeof operation.op !== 'string' || !OPS.includes(operation.op)) return `${at} has op ${JSON.stringify(operation.op)}. The ops are ${OPS.join(', ')}.`;
    if (typeof operation.path !== 'string') return `${at} needs a "path", a JSON Pointer such as /ola-card/prompt.`;
    const unknown = Object.keys(operation).filter((k) => !['op', 'path', 'value', 'from'].includes(k));
    if (unknown.length > 0) return `${at} has ${unknown.map((k) => JSON.stringify(k)).join(', ')}, which an operation does not take. It takes op, path, and value or from.`;
  }
  return undefined;
}

/** The value after the patch, or the first problem, which leaves nothing applied. */
export function applyPatch(value: Json, patch: unknown): { value: Json } | { problem: string } {
  const bad = malformed(patch);
  if (bad !== undefined) return { problem: bad };
  const root = { value: structuredClone(value) };
  for (const [i, operation] of (patch as PatchOperation[]).entries()) {
    try {
      apply(root, operation);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const message = text.charAt(0).toUpperCase() + text.slice(1);
      return { problem: `Operation ${i + 1} (${operation.op} ${operation.path || '""'}) failed, so none of the patch was applied. ${message}` };
    }
  }
  return root;
}
