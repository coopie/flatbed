/**
 * Resources: structured state an agent reads as plain JSON and changes with JSON Patch, and the
 * host acts on, such as a schedule or what a session opens with.
 *
 * A resource is defined in code. Its schema says what a value may be, and fields marked
 * `readOnly: true` belong to the host. Its `check` says what a schema cannot, such as a rule that
 * spans entries. A change is applied to a copy and checked as a whole: either it is saved as the
 * next version, or every problem comes back at once and nothing changes. There is no draft, so what
 * the agent last read or saved is what is there.
 */
import { Validator, type OutputUnit } from '@cfworker/json-schema';
import type { Plugin, ToolContext } from '@flatbed/core';
import { applyPatch, sameJson } from './patch.ts';
import type { ResourceStore, Stored } from './store.ts';

/** Who is changing a resource. The host may change `readOnly` fields; the agent may not. */
export type Writer = {
  /** The agent's id, or the host's name for itself. Saved with the version. */
  by: string;
  host?: boolean;
  /** The tool call's context, when the agent is the writer, such as for a check that reads the session. */
  tool?: ToolContext;
};

export type Resource<T = any> = {
  /** Lower-case words joined by hyphens, such as `cron`. */
  name: string;
  /** What it is for and how to change it, to the agent, in a few sentences. Shown in the context. */
  guide: string;
  /** A JSON Schema, draft 2020-12. Fields marked `readOnly: true` are the host's. */
  schema: Record<string, unknown>;
  /** The value before anything is written, as version 0. */
  initial: T;
  /** Every problem with a value that passed the schema, or none. May be async, such as a supervisor. */
  check?(next: T, previous: T, writer: Writer): string[] | Promise<string[]>;
  /**
   * What a read shows, by name. The view named `default` is what a read with no view shows; without
   * one, a read shows the whole value. A patch always addresses the whole value, so views that keep
   * the value's shape, such as a slice of a keyed collection, keep paths the agent can patch.
   */
  views?: Record<string, (value: T) => unknown>;
  /** Called after each saved change, by the agent or the host, such as to reschedule a timer. */
  onChange?(change: { value: T; previous: T; version: number; writtenBy: string }): void | Promise<void>;
  /** Hooks for the agent's sessions, such as context made from this resource's value. */
  plugin?(self: ResourceHandle<T>): Omit<Plugin, 'name'>;
};

/** One resource, as its own plugin hooks see it. */
export type ResourceHandle<T> = {
  read(): Promise<Stored<T>>;
  /** Every problem `value` has, by the schema and the check, with the host as the writer. */
  problems(value: T): Promise<string[]>;
};

export type EditResult =
  | { saved: Stored; previous: Stored; afterSave?: string }
  | { problems: string[]; current: number; stale?: true };

export type Resources = {
  definitions: Resource[];
  get(name: string): Resource | undefined;
  /** The newest version, or the initial value as version 0. */
  read(name: string): Promise<Stored>;
  /** Applies a JSON Patch to `version` and saves the result, or says every problem with it. */
  edit(name: string, version: number, patch: unknown, writer: Writer): Promise<EditResult>;
  /** Saves a whole new value based on `version`, checked as an edit is. */
  write(name: string, version: number, value: unknown, writer: Writer): Promise<EditResult>;
  /** Every problem `value` has by the schema and the check, as the host's own value, so readOnly fields are not compared. */
  problems(name: string, value: unknown): Promise<string[]>;
};

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const pointer = (path: string[]) => (path.length === 0 ? 'the whole value' : `/${path.map((t) => t.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`);

/** The schema that applies to a member of an object, from properties, then patternProperties, then additionalProperties. */
function memberSchema(schema: Record<string, unknown>, key: string): unknown {
  if (isObject(schema.properties) && Object.hasOwn(schema.properties, key)) return schema.properties[key];
  if (isObject(schema.patternProperties)) {
    for (const [pattern, sub] of Object.entries(schema.patternProperties)) if (new RegExp(pattern, 'u').test(key)) return sub;
  }
  return schema.additionalProperties;
}

/**
 * The `readOnly` fields the agent's change would set, change or remove. A field is compared only
 * where the object that holds it is still there, so the agent can remove a whole entry; in a list
 * it is compared by position, which is why keyed collections suit resources with host fields. It
 * follows properties, patternProperties, additionalProperties, prefixItems and items, not $ref.
 */
export function readOnlyProblems(schema: unknown, before: unknown, after: unknown, path: string[] = []): string[] {
  if (!isObject(schema) || after === undefined) return [];
  const problems: string[] = [];
  const visit = (sub: unknown, b: unknown, a: unknown, at: string[]) => {
    if (isObject(sub) && sub.readOnly === true) {
      if (sameJson(b, a)) return;
      const how = a === undefined ? 'removes it' : b === undefined ? 'sets it' : 'changes it';
      const hint = a === undefined ? ' Replacing the object that holds it removes it too, so change that object field by field.' : '';
      problems.push(`${pointer(at)} belongs to the host, and this edit ${how}. Leave it as it is.${hint}`);
    } else {
      problems.push(...readOnlyProblems(sub, b, a, at));
    }
  };
  if (isObject(after)) {
    const old = isObject(before) ? before : {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(after)])) visit(memberSchema(schema, key), old[key], after[key], [...path, key]);
  } else if (Array.isArray(after)) {
    const old = Array.isArray(before) ? before : [];
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (let i = 0; i < Math.max(old.length, after.length); i++) visit(i < prefix.length ? prefix[i] : schema.items, old[i], after[i], [...path, String(i)]);
  }
  return problems;
}

/**
 * The schema's errors as lines the agent can act on: each at the deepest place it applies, with
 * its path as a JSON Pointer, as a patch would write it.
 */
function schemaProblems(validator: Validator, value: unknown): string[] {
  const { errors } = validator.validate(value);
  const where = (unit: OutputUnit) => unit.instanceLocation.replace(/^#/, '');
  // The member an additionalProperties error is about; it is a member the schema does not allow
  // when nothing failed inside it, only the `false` schema it met.
  const member = (e: OutputUnit) => (e.keyword === 'additionalProperties' ? /^Property "(.*)" does not match/.exec(e.error)?.[1] : undefined);
  const target = (e: OutputUnit) => {
    const key = member(e);
    return key === undefined ? where(e) : `${where(e)}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  };
  // A failed child also fails each object or list above it, so an error that another one inside
  // what it is about explains is left out, and the deepest are kept.
  const inside = (o: OutputUnit, e: OutputUnit) => where(o).startsWith(`${target(e)}/`) || (member(e) !== undefined && where(o) === target(e));
  const deepest = errors.filter((e) => e.keyword !== 'false' && !errors.some((o) => o !== e && o.keyword !== 'false' && inside(o, e)));
  const lines = deepest.map((e) => {
    const at = where(e) === '' ? 'The whole value' : where(e);
    const key = member(e);
    if (key !== undefined) return `${at} has a member "${key}", which the schema does not allow there.`;
    return `${at}: ${e.error}`;
  });
  return [...new Set(lines)];
}

export function createResources(store: ResourceStore, definitions: Resource[]): Resources {
  const byName = new Map<string, { resource: Resource; validator: Validator }>();
  for (const resource of definitions) {
    if (!NAME.test(resource.name)) throw new Error(`"${resource.name}" is not a resource name. Use lower-case words joined by hyphens.`);
    if (byName.has(resource.name)) throw new Error(`Two resources are named ${resource.name}.`);
    const validator = new Validator(resource.schema as never, '2020-12', false);
    const initial = schemaProblems(validator, resource.initial);
    if (initial.length > 0) throw new Error(`The initial value of ${resource.name} does not fit its schema: ${initial.join(' ')}`);
    byName.set(resource.name, { resource, validator });
  }
  const find = (name: string) => {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`There is no resource named ${name}.`);
    return found;
  };

  async function read(name: string): Promise<Stored> {
    const { resource } = find(name);
    return (await store.get(name)) ?? { value: structuredClone(resource.initial), version: 0, writtenAt: '', writtenBy: 'initial' };
  }

  async function problemsOf(name: string, next: unknown, previous: unknown, writer: Writer): Promise<string[]> {
    const { resource, validator } = find(name);
    const problems = [...schemaProblems(validator, next), ...(writer.host ? [] : readOnlyProblems(resource.schema, previous, next))];
    // A check may assume the schema holds, so it runs only on a value that fits it.
    if (problems.length === 0 && resource.check) problems.push(...(await resource.check(next, previous, writer)));
    return problems;
  }

  async function save(name: string, version: number, change: (value: unknown) => { value: unknown } | { problem: string }, writer: Writer): Promise<EditResult> {
    const { resource } = find(name);
    const current = await read(name);
    if (version !== current.version) {
      return { stale: true, current: current.version, problems: [`${name} is at version ${current.version}, and this change was made against version ${version}. Read it again, and make your change against what is there now.`] };
    }
    const changed = change(current.value);
    if ('problem' in changed) return { problems: [changed.problem], current: current.version };
    const problems = await problemsOf(name, changed.value, current.value, writer);
    if (problems.length > 0) return { problems, current: current.version };
    const saved = await store.put(name, changed.value, current.version, writer.by);
    if (saved === undefined) {
      const now = (await read(name)).version;
      return { stale: true, current: now, problems: [`${name} changed to version ${now} while this change was being checked. Read it again, and make your change against what is there now.`] };
    }
    try {
      await resource.onChange?.({ value: saved.value, previous: current.value, version: saved.version, writtenBy: writer.by });
    } catch (error) {
      return { saved, previous: current, afterSave: `The host failed to act on the change: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { saved, previous: current };
  }

  return {
    definitions,
    get: (name) => byName.get(name)?.resource,
    read,
    edit: (name, version, patch, writer) => save(name, version, (value) => applyPatch(value, patch), writer),
    write: (name, version, value, writer) => save(name, version, () => ({ value: structuredClone(value) }), writer),
    problems: (name, value) => problemsOf(name, value, value, { by: 'host', host: true }),
  };
}

/** The handle a resource's own plugin hooks get. */
export function handleFor<T>(resources: Resources, name: string): ResourceHandle<T> {
  return { read: () => resources.read(name) as Promise<Stored<T>>, problems: (value) => resources.problems(name, value) };
}
