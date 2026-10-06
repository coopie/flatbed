/**
 * A small JSON Schema checker, for the two schemas this package uses: spec.schema.json and the
 * verdict schema derived from a spec. It knows `type` (object, array, string, boolean),
 * `properties`, `required`, `additionalProperties: false`, `items`, `minItems`, `minLength`,
 * `enum` and `pattern`, and ignores every other keyword. Extend it when a schema here needs more.
 */

type Schema = {
  type?: 'object' | 'array' | 'string' | 'boolean';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  minLength?: number;
  enum?: unknown[];
  pattern?: string;
};

const typeOf = (value: unknown): string =>
  Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

/** Every way `value` breaks `schema`, as `path: problem`, or an empty list when it matches. */
export function check(schema: object, value: unknown, path = '$'): string[] {
  const rule = schema as Schema;
  if (rule.type !== undefined && typeOf(value) !== rule.type) {
    return [`${path}: expected ${rule.type}, got ${typeOf(value)}`];
  }
  const problems: string[] = [];
  if (rule.enum !== undefined && !rule.enum.includes(value)) {
    problems.push(`${path}: expected one of ${rule.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      problems.push(`${path}: shorter than ${rule.minLength}`);
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${rule.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) {
      problems.push(`${path}: fewer than ${rule.minItems} items`);
    }
    if (rule.items !== undefined) {
      const items = rule.items;
      value.forEach((each, index) => problems.push(...check(items, each, `${path}[${index}]`)));
    }
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = rule.properties ?? {};
    for (const name of rule.required ?? []) {
      if (!(name in record)) problems.push(`${path}.${name}: missing`);
    }
    for (const [name, each] of Object.entries(record)) {
      const property = properties[name];
      if (property !== undefined) problems.push(...check(property, each, `${path}.${name}`));
      else if (rule.additionalProperties === false) problems.push(`${path}.${name}: not allowed`);
    }
  }
  return problems;
}
