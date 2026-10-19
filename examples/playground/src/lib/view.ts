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
  | { kind: 'agent'; text: string }
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
        for (const block of entry.message.content) {
          if (block.type === 'text' && block.text.trim() !== '') items.push({ kind: 'agent', text: block.text.trim() });
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

export function rulings(sessions: Session[]): Ruling[] {
  return chatItems(sessions).flatMap((item) => (item.kind === 'ruling' ? [item.ruling] : []));
}

/** The visitor's text, without the attribute wrapper the event renders with. */
export const visitorEvent = (text: string) => ({ kind: 'message', attrs: { from: 'visitor' }, text });
