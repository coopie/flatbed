/**
 * The resources plugin: a section listing each resource with its guide, and two tools,
 * `read_resource` and `edit_resource`.
 *
 * A resource may bring hooks of its own, as startup does with the context it opens a session with.
 * The plugin runs them as its own: their sections follow the resources section, in the order the
 * resources were defined, and the first `beforeTool` to answer a call answers it.
 */
import { escapeAttr, escapeText, type Plugin, type Section, type Tool, type ToolResult } from '@flatbed/core';
import { handleFor, type Resources } from './resource.ts';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export const RESOURCES_GUIDE = `Some of what you keep is structured state that the system acts on, kept as resources rather than documents. Each resource is one JSON value with a schema, and each change makes a new version.

Read one with read_resource, which shows it as JSON with its version. Change it with edit_resource: give the version you read and a JSON Patch (RFC 6902), a list of operations such as {"op": "replace", "path": "/weekly-plan/prompt", "value": "..."}. Paths are JSON Pointers into the whole value. To add to an object, use add with the new key in the path; to add to the end of a list, use the path of the list followed by /-. An edit is saved whole as the next version, or refused with every problem at once and nothing changed, so what you last read or saved is what is there. Fields the host keeps are yours to read but not to change.`;

/** The section that lists the resources, each with its guide and its views. */
function section(resources: Resources): Section {
  const items = resources.definitions.map((r) => {
    const views = Object.keys(r.views ?? {});
    return `<resource name="${escapeAttr(r.name)}"${views.length > 0 ? ` views="${escapeAttr(views.join(', '))}"` : ''}>\n${escapeText(r.guide.trim())}\n</resource>`;
  });
  return { name: 'resources', text: `<resources>\n${RESOURCES_GUIDE}\n\n${items.join('\n\n')}\n</resources>` };
}

export function resourcesPlugin(resources: Resources): Plugin {
  const names = resources.definitions.map((r) => r.name);
  const unknown = (name: string) => fail(`There is no resource named ${name}. Your resources are ${names.join(', ')}.`);
  const hooks = resources.definitions.flatMap((r) => (r.plugin ? [r.plugin(handleFor(resources, r.name))] : []));

  const tools: Tool[] = [
    {
      name: 'read_resource',
      description: 'Read one of your resources as JSON, with its version. Read it before you edit it, and give edit_resource the version you read.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: names },
          view: { type: 'string', description: 'A view the resource names in your context. Leave it out for the usual one.' },
        },
        required: ['name'],
      },
      async run(input) {
        const name = String(input.name);
        const resource = resources.get(name);
        if (resource === undefined) return unknown(name);
        const views = resource.views ?? {};
        const view = typeof input.view === 'string' ? input.view : undefined;
        if (view !== undefined && !Object.hasOwn(views, view)) {
          const known = Object.keys(views);
          return fail(`${name} has no view named ${view}. ${known.length > 0 ? `Its views are ${known.join(', ')}.` : 'It has none, so leave view out.'}`);
        }
        const { value, version } = await resources.read(name);
        const show = (view ?? (Object.hasOwn(views, 'default') ? 'default' : undefined));
        const shown = show === undefined ? value : views[show]!(value);
        return ok(`${name}${show && show !== 'default' ? `, view ${show}` : ''}, version ${version}:\n${JSON.stringify(shown, null, 2)}`);
      },
    },
    {
      name: 'edit_resource',
      description:
        'Change one of your resources with a JSON Patch (RFC 6902) against the version you read. The operations are add, remove, replace, move, copy and test, each with a "path", a JSON Pointer into the whole value, such as /weekly-plan/prompt, and a "value" or "from" where the operation takes one. The patch is applied to a copy and checked as a whole: it is saved as the next version, or refused with every problem and nothing saved. An edit against an older version is refused, so read again first.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: names },
          version: { type: 'integer', description: 'The version you read.' },
          patch: {
            type: 'array',
            description: 'The operations, applied in order, such as [{"op": "add", "path": "/weekly-plan", "value": {...}}, {"op": "remove", "path": "/old-entry"}].',
            items: { type: 'object' },
          },
        },
        required: ['name', 'version', 'patch'],
      },
      async run(input, ctx) {
        const name = String(input.name);
        if (resources.get(name) === undefined) return unknown(name);
        if (typeof input.version !== 'number') return fail('Give the version you read, as a number.');
        const result = await resources.edit(name, input.version, input.patch, { by: ctx.agent.id, tool: ctx });
        if ('saved' in result) return ok(`Saved ${name} as version ${result.saved.version}.${result.afterSave ? ` ${result.afterSave}` : ''}`);
        const lines = result.problems.map((p) => `- ${p}`).join('\n');
        if (result.stale) return fail(`Nothing was saved. ${result.problems.join(' ')}`);
        return fail(`Nothing was saved, and ${name} is still version ${result.current}, because:\n${lines}\nFix every one and send the whole patch again, against version ${result.current}.`);
      },
    },
  ];

  return {
    name: 'resources',
    async context(ctx) {
      const sections: Section[] = [section(resources)];
      const calls = [];
      const added: Tool[] = [...tools];
      for (const hook of hooks) {
        const more = await hook.context?.(ctx);
        sections.push(...(more?.sections ?? []));
        calls.push(...(more?.calls ?? []));
        added.push(...(more?.tools ?? []));
      }
      return { sections, tools: added, calls };
    },
    async beforeTool(call, ctx) {
      for (const hook of hooks) {
        const answer = await hook.beforeTool?.(call, ctx);
        if (answer !== undefined && answer !== null) return answer;
      }
      return undefined;
    },
    async afterTool(call, result, ctx) {
      for (const hook of hooks) result = (await hook.afterTool?.(call, result, ctx)) ?? result;
      return result;
    },
    async onEntry(entry, ctx) {
      for (const hook of hooks) await hook.onEntry?.(entry, ctx);
    },
    async onSessionEnd(session, ctx) {
      for (const hook of hooks) await hook.onSessionEnd?.(session, ctx);
    },
  };
}
