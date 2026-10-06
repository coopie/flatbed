/**
 * The app's own plugins: tools to read the person's mail and calendar, and proposals.
 *
 * The agent never sends anything itself. `propose_email` and `propose_event` store a proposal with
 * the agent's reasons and return at once, saying the person will decide. The person accepts, edits
 * or denies it on the proposals page; `decide` sends what was accepted, and the decision reaches
 * the agent as a `decision` event, so it learns what the person changed.
 */
import type { Event, Plugin, Session, Tool, ToolResult } from '@flatbed/core';
import type { Sql } from './db.ts';
import type { Google } from './google/google.ts';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function mailAndCalendar(google: Google): Plugin {
  const tools: Tool[] = [
    {
      name: 'search_mail',
      description: 'Search the person\'s mail with a Gmail query, such as "from:priya newer_than:7d" or "in:inbox". Returns the newest matches, with their thread ids and the start of each body. Read a thread before you answer it.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(input) {
        const mail = await google.searchMail(str(input.query), 10);
        if (mail.length === 0) return 'Nothing matches that search.';
        return mail.map((m) => `<mail thread="${m.threadId}" from="${escape(m.from)}" date="${m.date}" subject="${escape(m.subject)}">\n${escape(m.body)}\n</mail>`).join('\n');
      },
    },
    {
      name: 'read_thread',
      description: 'Read every message in one email thread, in full. Use it before you propose a reply in that thread.',
      inputSchema: { type: 'object', properties: { thread: { type: 'string' } }, required: ['thread'] },
      async run(input) {
        const mail = await google.readThread(str(input.thread));
        if (mail.length === 0) return fail('There is no thread with that id. Use search_mail to find it.');
        return mail.map((m) => `<mail from="${escape(m.from)}" to="${escape(m.to)}" date="${m.date}" subject="${escape(m.subject)}">\n${escape(m.body)}\n</mail>`).join('\n');
      },
    },
    {
      name: 'list_events',
      description: 'List the person\'s calendar events between two times, as ISO 8601 strings. Check the calendar before you offer or accept a time.',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      async run(input) {
        const events = await google.listEvents(str(input.from), str(input.to));
        if (events.length === 0) return 'Nothing in the calendar then.';
        return events.map((e) => `- ${e.start} to ${e.end}: ${e.title}${e.attendees.length ? ` (with ${e.attendees.join(', ')})` : ''}`).join('\n');
      },
    },
  ];
  return { name: 'google', context: () => ({ tools }) };
}

export type ProposalKind = 'email' | 'event';

export type Proposal = {
  id: string;
  agent: string;
  kind: ProposalKind;
  input: Record<string, unknown>;
  reason: string;
  session: string;
  callId: string;
  status: 'pending' | 'accepted' | 'denied';
  decidedInput: Record<string, unknown> | null;
  note: string | null;
  result: string | null;
  createdAt: string;
};

type ProposalRow = {
  id: string; agent: string; kind: ProposalKind; input: Record<string, unknown>; reason: string; session: string; call_id: string;
  status: Proposal['status']; decided_input: Record<string, unknown> | null; note: string | null; result: string | null; created_at: Date;
};

const toProposal = (row: ProposalRow): Proposal => ({
  id: row.id, agent: row.agent, kind: row.kind, input: row.input, reason: row.reason, session: row.session, callId: row.call_id,
  status: row.status, decidedInput: row.decided_input, note: row.note, result: row.result, createdAt: row.created_at.toISOString(),
});

export async function listProposals(sql: Sql, agent: string): Promise<Proposal[]> {
  const rows = await sql<ProposalRow[]>`select * from proposals where agent = ${agent} order by created_at desc`;
  return rows.map(toProposal);
}

/** The fields of each kind, in the order the card shows them. The card edits exactly these. */
export const FIELDS: Record<ProposalKind, string[]> = {
  email: ['to', 'subject', 'body'],
  event: ['title', 'start', 'end', 'attendees'],
};

/**
 * The id of the call being run, found as the newest call by that name with that input. A tool's
 * `run` is not given its call id, and a proposal needs it to find the supervisor's verdict beside
 * the call in the session.
 */
function callIdOf(session: Session, name: string, input: Record<string, unknown>): string {
  const wanted = JSON.stringify(input);
  for (const entry of [...session.entries].reverse()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const call = entry.message.content.find((b) => b.type === 'toolCall' && b.name === name && JSON.stringify(b.input) === wanted);
    if (call?.type === 'toolCall') return call.id;
  }
  return '';
}

export function proposals(options: { sql: Sql; onProposed?: (proposal: Proposal) => void }): Plugin {
  const { sql } = options;

  async function propose(kind: ProposalKind, toolName: string, input: Record<string, unknown>, ctx: { agent: { id: string }; session: Session }) {
    // The thread rides along unedited, so an accepted reply lands in the thread it answers.
    const fields = Object.fromEntries([...FIELDS[kind], 'thread'].filter((field) => input[field] !== undefined).map((field) => [field, input[field]]));
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const callId = callIdOf(ctx.session, toolName, input);
    const [row] = await sql<ProposalRow[]>`
      insert into proposals (id, agent, kind, input, reason, session, call_id)
      values (${id}, ${ctx.agent.id}, ${kind}, ${JSON.stringify(fields)}::text::json, ${str(input.reason)}, ${ctx.session.header.id}, ${callId})
      returning *`;
    options.onProposed?.(toProposal(row!));
    return ok(`Proposal ${id} is waiting for the person, who will accept, edit or deny it. Their decision will reach you as a decision event. Tell them in a line what you proposed, and stop.`);
  }

  const reason = { type: 'string', description: 'Why you propose this, in one or two sentences the person reads on the card: what they asked or what you saw, and where.' };
  const tools: Tool[] = [
    {
      name: 'propose_email',
      description: 'Propose an email for the person to accept, edit or deny. Nothing is sent until they accept. Give the reply\'s thread id when you are answering an email.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text, signed as the person' }, thread: { type: 'string' }, reason },
        required: ['to', 'subject', 'body', 'reason'],
      },
      run: (input, ctx) => propose('email', 'propose_email', input, ctx),
    },
    {
      name: 'propose_event',
      description: 'Propose a calendar event for the person to accept, edit or deny. Nothing is created until they accept. Check the calendar with list_events first.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string', description: 'ISO 8601, with the offset' },
          end: { type: 'string', description: 'ISO 8601, with the offset' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses' },
          reason,
        },
        required: ['title', 'start', 'end', 'reason'],
      },
      run: (input, ctx) => propose('event', 'propose_event', { ...input, attendees: input.attendees ?? [] }, ctx),
    },
  ];
  return { name: 'proposals', context: () => ({ tools }) };
}

/** What the person did, as the agent will read it. */
export type Decision = { outcome: 'accepted' | 'denied'; input?: Record<string, unknown>; note?: string };

/**
 * Decides a pending proposal: sends what was accepted, as the person left it, and records the
 * outcome. Returns the event to deliver to the agent, which names every field the person changed.
 */
export async function decide(sql: Sql, google: Google, proposal: Proposal, decision: Decision): Promise<Event> {
  if (proposal.status !== 'pending') throw new Error(`Proposal ${proposal.id} is already ${proposal.status}.`);
  const final = { ...proposal.input, ...(decision.input ?? {}) };
  const changed = FIELDS[proposal.kind].filter((field) => JSON.stringify(proposal.input[field]) !== JSON.stringify(final[field]));
  let result = '';
  if (decision.outcome === 'accepted') {
    result = proposal.kind === 'email'
      ? await google.sendEmail({ to: str(final.to), subject: str(final.subject), body: str(final.body), ...(final.thread ? { threadId: str(final.thread) } : {}) })
      : await google.createEvent({ title: str(final.title), start: str(final.start), end: str(final.end), attendees: (final.attendees as string[]) ?? [] });
  }
  await sql`
    update proposals set status = ${decision.outcome}, decided_input = ${JSON.stringify(final)}::text::json,
      note = ${decision.note ?? null}, result = ${result || null}, decided_at = now()
    where id = ${proposal.id}`;

  const lines = [
    decision.outcome === 'accepted' ? `The person accepted your ${proposal.kind} proposal. ${result}` : `The person denied your ${proposal.kind} proposal. Nothing was sent.`,
    // The core escapes an event's text when it renders it, so plain lines go here rather than markup.
    ...changed.map((field) => `They changed the ${field}.\nYours: ${String(proposal.input[field] ?? '')}\nTheirs: ${String(final[field] ?? '')}`),
    ...(decision.note ? [`Their note: ${decision.note}`] : []),
  ];
  return { kind: 'decision', attrs: { proposal: proposal.id, outcome: decision.outcome, from: 'person' }, text: lines.join('\n') };
}
