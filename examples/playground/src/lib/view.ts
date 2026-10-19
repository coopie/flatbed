/**
 * What the project page shows, read from the sessions: the chat, with each tool call as a short
 * line, and the supervisor's rulings. Plain functions of the sessions, so the live project and a
 * recorded example render the same way.
 */
import type { Session, ToolCall } from '@flatbed/core';
import type { GuardRecord } from '@flatbed/supervisor';

export type Ruling = { session: string; at: string; call?: ToolCall; record: GuardRecord };

export type ChatItem =
  | { kind: 'visitor'; text: string }
  | { kind: 'agent'; text: string; narration?: boolean }
  | { kind: 'tool'; name: string; target: string; isError: boolean; result: string }
  | { kind: 'ruling'; ruling: Ruling }
  | { kind: 'notice'; text: string }
  | { kind: 'reset'; session: string; reason?: string };

/** What a tool call was about, in a few words, such as `board/hours` or a web address. */
function targetOf(call: ToolCall): string {
  const input = call.input as Record<string, unknown>;
  for (const key of ['name', 'url', 'prefix', 'line']) if (typeof input[key] === 'string') return input[key] as string;
  return '';
}

export function chatItems(sessions: Session[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const session of sessions) {
    const calls = new Map<string, ToolCall>();
    for (const entry of session.entries) {
      if (entry.type === 'event' && entry.kind === 'message') items.push({ kind: 'visitor', text: entry.text });
      else if (entry.type === 'event' && entry.kind === 'notice') items.push({ kind: 'notice', text: entry.text });
      else if (entry.type === 'event' && entry.kind === 'reveal') items.push({ kind: 'notice', text: `You revealed ${entry.attrs?.folder ?? 'a sealed folder'}, and the agent was given its documents.` });
      else if (entry.type === 'message' && entry.message.role === 'assistant') {
        // Text in a reply that also calls tools is the agent narrating its work, such as "Now let me
        // read the pricing page"; only a reply with no calls is the agent answering the visitor.
        const narration = entry.message.content.some((block) => block.type === 'toolCall');
        for (const block of entry.message.content) {
          if (block.type === 'text' && block.text.trim() !== '') items.push({ kind: 'agent', text: block.text.trim(), ...(narration ? { narration } : {}) });
          if (block.type === 'toolCall') calls.set(block.id, block);
        }
      } else if (entry.type === 'message' && entry.message.role === 'tool') {
        const call = calls.get(entry.message.callId);
        const result = entry.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        items.push({ kind: 'tool', name: entry.message.name, target: call ? targetOf(call) : '', isError: entry.message.isError, result });
      } else if (entry.type === 'custom' && entry.plugin === 'supervisor') {
        const record = entry.data as GuardRecord;
        const call = record.verdict.callId === undefined ? undefined : calls.get(record.verdict.callId);
        items.push({ kind: 'ruling', ruling: { session: session.header.id, at: entry.at, record, ...(call ? { call } : {}) } });
      } else if (entry.type === 'reset') items.push({ kind: 'reset', session: session.header.id, ...(entry.reason ? { reason: entry.reason } : {}) });
    }
  }
  return items;
}

/** A stretch of quiet lines between two messages, folded to one. */
export type Activity = { kind: 'activity'; items: Extract<ChatItem, { kind: 'tool' } | { kind: 'ruling' } | { kind: 'agent' }>[] };
export type ChatLine = ChatItem | Activity;

/**
 * Folds every run of three or more quiet lines, the tool calls, the agent's narration between them and
 * the rulings that passed, into
 * one line, "did six things", as Otherworldly's chat does, so the conversation stays short. A
 * ruling that refused or failed anything ends a run and stays in view, since the supervisor catching something is what a
 * visitor should not miss. Two lines read shorter as two, so they stay as they are.
 */
export function foldActivity(items: ChatItem[]): ChatLine[] {
  const lines: ChatLine[] = [];
  let run: Activity['items'] = [];
  const flush = () => {
    if (run.length >= 3) lines.push({ kind: 'activity', items: run });
    else lines.push(...run);
    run = [];
  };
  for (const item of items) {
    const quiet = item.kind === 'tool' || (item.kind === 'agent' && item.narration === true) || (item.kind === 'ruling' && passed(item.ruling));
    if (quiet) run.push(item as Activity['items'][number]);
    else {
      flush();
      lines.push(item);
    }
  }
  flush();
  return lines;
}

/** A ruling where every check passed: one with any failed item, or none at all, stays in view. */
const passed = (ruling: Ruling): boolean =>
  !ruling.record.refused && ruling.record.verdict.status === 'given' && Object.values(ruling.record.verdict.items).every((item) => item.ok);

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** The one line a run folds to. */
export const summaryOf = (activity: Activity): string => {
  const things = activity.items.filter((item) => item.kind !== 'agent').length;
  return `did ${WORDS[things] ?? things} things`;
};

export function rulings(sessions: Session[]): Ruling[] {
  return chatItems(sessions).flatMap((item) => (item.kind === 'ruling' ? [item.ruling] : []));
}

/** The visitor's text, without the attribute wrapper the event renders with. */
export const visitorEvent = (text: string) => ({ kind: 'message', attrs: { from: 'visitor' }, text });

/** Where one of the three steps stands: not reached, under way, or behind the agent. */
export type StepState = 'waiting' | 'now' | 'done';
export type Steps = { reading: StepState; organising: StepState; writing: StepState };

/**
 * How far the agent has got through reading, organising and writing, from its tool calls: a
 * `fetch_page` call starts reading, a write to `notes/` organising, and a write to `outbox/` writing.
 * The step reached last is under way while the agent runs.
 */
export function steps(sessions: Session[], running: boolean): Steps {
  let reached = 0;
  for (const session of sessions) {
    for (const entry of session.entries) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      for (const block of entry.message.content) {
        if (block.type !== 'toolCall') continue;
        const name = typeof block.input.name === 'string' ? block.input.name : '';
        const writes = block.name === 'write_doc' || block.name === 'edit_doc';
        if (block.name === 'fetch_page') reached = Math.max(reached, 1);
        else if (writes && name.startsWith('notes/')) reached = Math.max(reached, 2);
        else if (writes && name.startsWith('outbox/')) reached = 3;
      }
    }
  }
  const state = (n: number): StepState => (reached < n ? 'waiting' : reached > n || !running ? 'done' : 'now');
  return { reading: state(1), organising: state(2), writing: state(3) };
}

/** The fact sheet's lines, each with the `sources/` page it names, if any, for showing a fact beside its page. */
export function facts(body: string): { text: string; source?: string }[] {
  return body.split('\n').flatMap((line) => {
    const fact = line.match(/^\s*[-*]\s+(.*)$/)?.[1];
    if (fact === undefined) return [];
    const source = fact.match(/\(?(sources\/[a-z0-9-]+)\)?\s*$/)?.[1];
    const text = source ? fact.slice(0, fact.lastIndexOf(source)).replace(/[\s(]+$/, '') : fact;
    return [source ? { text, source } : { text }];
  });
}

/** The latest ruling on writes to a document. */
export function rulingFor(all: Ruling[], name: string): Ruling | undefined {
  return all.findLast((r) => r.call?.input.name === name);
}
