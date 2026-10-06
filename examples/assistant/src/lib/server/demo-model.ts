/**
 * The scripted model for demo mode, `faux/demo`, so the app runs end to end with no API key. It
 * plays one exchange per demo person: asked the line in their fixture's script, it searches the
 * mail, reads the thread, checks the calendar and proposes the scripted reply; told of a decision,
 * it notes it on the timeline. Asked anything else, it says what it can do. As the supervisor, it
 * passes every item. It is a stage prop, not a model: rough on purpose, and only for the demo.
 */
import type { Block, Provider, ProviderRequest } from '@flatbed/core';
import { demoPeople } from './fixtures.ts';

const text = (value: string): Block[] => [{ type: 'text', text: value }];
const call = (name: string, input: Record<string, unknown>): Block[] => [
  { type: 'toolCall', id: `call_${crypto.randomUUID().slice(0, 8)}`, name, input },
];

function verdictFor(request: ProviderRequest): string {
  const schema = request.outputSchema as { properties: { items: { properties: Record<string, { description: string }> } } };
  const items = Object.fromEntries(
    Object.entries(schema.properties.items.properties).map(([id, item]) => [id, { analysis: `Demo supervisor: "${item.description}" holds on what the session shows.`, ok: true }]),
  );
  return JSON.stringify({ items, summary: 'The demo supervisor passes every item; with a real model, each analysis cites the session.' });
}

function next(request: ProviderRequest): Block[] {
  if (request.outputSchema) return text(verdictFor(request));
  const last = request.messages.at(-1);
  const soul = request.sections.map((s) => s.text).join('\n');
  const person = demoPeople().find((p) => soul.includes(p.name));
  const script = person?.script;
  const thread = person?.mail.find((m) => m.threadId === script?.threadId);

  const userText = (m: (typeof request.messages)[number] | undefined) =>
    m?.role === 'user' ? m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : '';
  const trigger = userText(request.messages.findLast((m) => m.role === 'user'));

  if (last?.role === 'tool') {
    switch (last.name) {
      case 'search_mail':
        if (trigger.includes('<tick')) return text('I checked the inbox. Nothing new needs you.');
        return call('read_thread', { thread: script!.threadId });
      case 'read_thread': {
        const from = new Date();
        const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
        return call('list_events', { from: from.toISOString(), to: to.toISOString() });
      }
      case 'list_events':
        return call('propose_email', {
          to: thread!.from,
          subject: `Re: ${thread!.subject}`,
          body: script!.body,
          thread: thread!.threadId,
          reason: script!.reason,
        });
      case 'propose_email':
        return text(`I've proposed a reply to ${thread!.from.split(' <')[0]}. It's on the proposals page for you to accept, edit or deny.`);
      case 'add_to_timeline':
        return text('Done, and noted on the timeline.');
      default:
        return text('Done.');
    }
  }

  const said = userText(last);
  if (said.includes('<decision')) {
    const accepted = said.includes('outcome="accepted"');
    const who = thread?.from.split(' <')[0] ?? 'them';
    return call('add_to_timeline', { line: accepted ? `Sent the reply to ${who}.` : `The reply to ${who} was denied; nothing sent.` });
  }
  if (said.includes('<tick')) return call('search_mail', { query: 'in:inbox newer_than:1d' });
  if (script && said.includes(script.ask)) return call('search_mail', { query: thread!.from.split(' <')[0]! });
  return text(`I'm the scripted demo model, so I can only play one exchange. Try: "${script?.ask ?? 'reply to the newest email'}"`);
}

export function demoModel(): Provider {
  return {
    async complete(request) {
      const content = next(request);
      return {
        role: 'assistant',
        content,
        model: `faux/${request.model}`,
        usage: { input: 0, output: 0 },
        stop: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'end',
      };
    },
  };
}
