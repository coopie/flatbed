import { fail } from '@sveltejs/kit';
import { pathOf, type Entry } from '@flatbed/core';
import { getHost } from '$lib/server/app.ts';
import { demoPerson } from '$lib/server/fixtures.ts';
import type { Actions, PageServerLoad } from './$types';

/** One line of the chat: who spoke and what, with tool calls as short notes. */
type Line = { id: string; who: 'person' | 'agent' | 'note'; text: string; at: string };

const TOOL_NOTES: Record<string, string> = {
  search_mail: 'Searched the mail',
  read_thread: 'Read a thread',
  list_events: 'Checked the calendar',
  propose_email: 'Proposed an email',
  propose_event: 'Proposed an event',
  add_to_timeline: 'Added to the timeline',
  write_doc: 'Wrote a document',
  edit_doc: 'Edited a document',
  read_doc: 'Read a document',
  list_docs: 'Looked through its documents',
  pin_doc: 'Pinned a document',
  reset: 'Wrapped up the session',
};

function lines(entries: Entry[]): Line[] {
  return entries.flatMap((entry): Line[] => {
    const base = { id: entry.id, at: entry.at };
    if (entry.type === 'event' && entry.kind === 'message') return [{ ...base, who: 'person', text: entry.text }];
    if (entry.type === 'event' && entry.kind === 'decision') return [{ ...base, who: 'note', text: `You ${entry.attrs?.outcome} proposal ${entry.attrs?.proposal}.` }];
    if (entry.type === 'event' && entry.kind === 'tick') return [{ ...base, who: 'note', text: 'The scheduler asked it to check the mail.' }];
    if (entry.type === 'event') return [{ ...base, who: 'note', text: entry.text }];
    if (entry.type === 'reset') return [{ ...base, who: 'note', text: 'It wrapped up here and started again.' }];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return [];
    return entry.message.content.flatMap((block): Line[] => {
      if (block.type === 'text' && block.text.trim()) return [{ ...base, who: 'agent', text: block.text }];
      if (block.type === 'toolCall') return [{ ...base, who: 'note', text: TOOL_NOTES[block.name] ?? `Used ${block.name}` }];
      return [];
    });
  });
}

export const load: PageServerLoad = async ({ locals }) => {
  const host = await getHost();
  const person = locals.person!;
  const ids = await host.sessions.list(person.id);
  const newest = ids.at(-1);
  const entries = newest ? pathOf((await host.sessions.read(person.id, newest)).entries) : [];
  return { lines: lines(entries), suggestion: host.mode === 'demo' ? demoPerson(person.id)?.script.ask : undefined };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const text = String((await request.formData()).get('text') ?? '').trim();
    if (!text) return fail(400, { empty: true });
    const host = await getHost();
    // The run goes on after the answer; the page hears its entries over the stream.
    void host.send(locals.person!, text);
    return { sent: true };
  },
};
