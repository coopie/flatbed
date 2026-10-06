/**
 * Turns a session into what the model sees: the path from the root to the head, then the context
 * and messages rendered from it, as docs/spec/sessions.md describes.
 */
import type { ContextEntry, Entry, Event, Message } from './types.ts';

/** The entries from the root to the head (the last entry), found by following `parentId`. */
export function pathOf(entries: Entry[]): Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Entry[] = [];
  for (let entry = entries.at(-1); entry !== undefined; entry = entry.parentId === null ? undefined : byId.get(entry.parentId)) {
    if (path.length > entries.length) throw new Error('The session has a cycle in its parent links.');
    path.push(entry);
    if (entry.parentId !== null && !byId.has(entry.parentId)) throw new Error(`Entry ${entry.id} has a missing parent.`);
  }
  return path.reverse();
}

/** Escapes `&`, `<` and `>`, for text inside an XML element. */
export const escapeText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Escapes `&`, `<`, `>` and `"`, for an XML attribute value. */
export const escapeAttr = (text: string) => escapeText(text).replaceAll('"', '&quot;');

/** An event as an XML element, such as `<message from="Sam">Can you move my 3pm?</message>`. */
export function renderEvent(event: Event): string {
  const attrs = Object.keys(event.attrs ?? {})
    .sort()
    .map((key) => ` ${key}="${escapeAttr(event.attrs?.[key] ?? '')}"`)
    .join('');
  return `<${event.kind}${attrs}>${escapeText(event.text)}</${event.kind}>`;
}

export function render(path: Entry[]): { context: ContextEntry; messages: Message[] } {
  let context: ContextEntry | undefined;
  const messages: Message[] = [];
  const pushUser = (content: Extract<Message, { role: 'user' }>['content']) => {
    const last = messages.at(-1);
    if (last?.role === 'user') last.content.push(...content);
    else messages.push({ role: 'user', content: [...content] });
  };
  for (const entry of path) {
    if (entry.type === 'context') context = entry;
    else if (entry.type === 'event') pushUser([{ type: 'text', text: renderEvent(entry) }]);
    else if (entry.type === 'message' && entry.message.role === 'user') pushUser(entry.message.content);
    else if (entry.type === 'message') messages.push(entry.message);
  }
  if (context === undefined) throw new Error('The session has no context entry on its path.');
  return { context, messages };
}
