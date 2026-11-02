/**
 * startup.json: the document that decides what each session opens with, in place of pinning.
 *
 * It is a list of tool calls. The `system` entries come first, and each reads one document, which
 * becomes a section of the context. The rest become the core's opening calls, so their results
 * arrive as material in the conversation rather than as instructions in the system prompt.
 *
 * The host keeps the `fixed` entries in code. The agent edits the rest like any document, and a
 * write is checked as a whole as it lands, so a broken file never reaches the next session. The
 * check reports every problem at once, so the agent can fix them in one more write.
 */

export const STARTUP_DOC = 'startup.json';

/** One entry of startup.json: a tool call, and whether it is a system read and whether the host fixed it. */
export type StartupEntry = { name: string; input: Record<string, unknown>; system?: boolean; fixed?: boolean };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Equal as JSON values, ignoring key order. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    return keys.length === Object.keys(b).filter((k) => b[k] !== undefined).length && keys.every((k) => same(a[k], b[k]));
  }
  return a === b;
}

/** The document a `system` entry reads, or undefined when the entry is not a read of one document. */
export function systemRead(entry: StartupEntry): string | undefined {
  return entry.name === 'read_doc' && typeof entry.input.name === 'string' ? entry.input.name : undefined;
}

/** The documents the fixed entries read, which the agent may read but not change. */
export function fixedReads(fixed: StartupEntry[]): Set<string> {
  return new Set(fixed.flatMap((e) => (e.name === 'read_doc' && typeof e.input.name === 'string' ? [e.input.name] : [])));
}

/**
 * The entries in a startup.json body, or every problem with it. `tools` are the names of the
 * agent's tools; when they are not known, such as before a session's tools are collected, names
 * are not checked.
 */
export function checkStartup(body: string, fixed: StartupEntry[], tools?: string[]): { entries: StartupEntry[] } | { problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { problems: [`It is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`] };
  }
  if (!Array.isArray(parsed)) return { problems: ['It must be a JSON list of entries.'] };

  const problems: string[] = [];
  const entries: StartupEntry[] = [];
  let systemEnded = false;
  for (const [i, raw] of parsed.entries()) {
    const at = `Entry ${i + 1}`;
    if (!isObject(raw) || typeof raw.name !== 'string' || !isObject(raw.input)) {
      problems.push(`${at} must be an object with a tool "name" and an "input" object.`);
      continue;
    }
    if ((raw.system !== undefined && typeof raw.system !== 'boolean') || (raw.fixed !== undefined && typeof raw.fixed !== 'boolean')) {
      problems.push(`${at}: "system" and "fixed" must be true or false.`);
    }
    const entry: StartupEntry = { name: raw.name, input: raw.input, system: raw.system === true, fixed: raw.fixed === true };
    entries.push(entry);
    if (entry.name === 'reset') problems.push(`${at} calls reset, which would end every session as it opened.`);
    else if (tools !== undefined && !tools.includes(entry.name)) problems.push(`${at} calls ${entry.name}, which is not one of your tools.`);
    if (!entry.system) systemEnded = true;
    else if (systemEnded) problems.push(`${at} is a system entry after one that is not. System entries come first.`);
    else if (systemRead(entry) === undefined) problems.push(`${at} is a system entry, so it must read one document with read_doc.`);
  }

  // The fixed entries, in order, must be exactly the host's, flags included.
  const marked = entries.filter((e) => e.fixed);
  const normal = (e: StartupEntry) => ({ name: e.name, input: e.input, system: e.system === true, fixed: true });
  for (const [i, want] of fixed.entries()) {
    const got = marked[i];
    if (got === undefined || !same(normal(got), normal(want))) {
      problems.push(`The host's fixed entries must stay as they are and in their order. Fixed entry ${i + 1} should be ${JSON.stringify({ ...want, fixed: true })}.`);
      break;
    }
  }
  if (marked.length > fixed.length) problems.push('Only the host can mark an entry fixed. Take "fixed" off the entries you added.');
  return problems.length > 0 ? { problems } : { entries };
}

/** What happened to a startup.json that fails the check, and why: by default, the refusal of a write. */
export function startupRefusal(problems: string[], outcome = `${STARTUP_DOC} was not changed`): string {
  return `${outcome}, because:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix every one and write it again.`;
}
