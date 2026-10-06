/**
 * Gmail and Calendar over their REST APIs, for one person, with the token from auth.ts. Borrowed
 * from perso's src/google/google.ts, without its concurrency slots: a showcase for a few people
 * does not reach Gmail's limits.
 */
import type { Sql } from '../db.ts';
import { accessToken } from './auth.ts';
import type { CalendarEvent, Google, Mail } from './google.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
/** How much of a message body the agent sees from a search; read_thread gives it whole. */
const SNIPPET = 400;

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id: string; threadId: string; payload: GmailPart & { headers: { name: string; value: string }[] } };
type RawEvent = { id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; attendees?: { email: string }[] };

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

/** The first part of a type, depth first. */
function partText(part: GmailPart, type: string): string {
  if (part.mimeType === type && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const text = partText(child, type);
    if (text) return text;
  }
  return '';
}

/** HTML as rough text, since most automated mail sends only HTML. */
const htmlToText = (html: string) =>
  html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n\s*\n\s*/g, '\n\n').trim();

function toMail(raw: GmailMessage): Mail {
  const header = (name: string) => raw.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: header('From'),
    to: header('To'),
    subject: header('Subject'),
    date: header('Date'),
    body: partText(raw.payload, 'text/plain') || htmlToText(partText(raw.payload, 'text/html')),
  };
}

const toEvent = (raw: RawEvent): CalendarEvent => ({
  id: raw.id,
  title: raw.summary ?? '(no title)',
  start: raw.start.dateTime ?? raw.start.date ?? '',
  end: raw.end.dateTime ?? raw.end.date ?? '',
  attendees: (raw.attendees ?? []).map((a) => a.email),
});

/**
 * A plain-text email as MIME, with the subject encoded so any characters survive. A line break in
 * a header field would let it add headers, such as a Bcc, so one is refused.
 */
function mime(to: string, subject: string, body: string): string {
  if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) throw new Error('A mail header cannot contain a line break.');
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  return [`To: ${to}`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', body].join('\r\n');
}

export function liveGoogle(sql: Sql, person: string): Google {
  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await accessToken(sql, person)}`, 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error(`Google answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return (await response.json()) as T;
  }

  return {
    async searchMail(query, max) {
      const params = new URLSearchParams({ q: query, maxResults: String(max) });
      const list = await call<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${params}`);
      const mail = await Promise.all((list.messages ?? []).map(async ({ id }) => toMail(await call<GmailMessage>(`${GMAIL}/messages/${id}?format=full`))));
      return mail.map((m) => ({ ...m, body: m.body.slice(0, SNIPPET) }));
    },
    async readThread(threadId) {
      const thread = await call<{ messages: GmailMessage[] }>(`${GMAIL}/threads/${encodeURIComponent(threadId)}?format=full`);
      return thread.messages.map(toMail);
    },
    async listEvents(from, to) {
      const params = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime' });
      const list = await call<{ items: RawEvent[] }>(`${CALENDAR}/calendars/primary/events?${params}`);
      return list.items.map(toEvent);
    },
    async sendEmail(email) {
      const raw = Buffer.from(mime(email.to, email.subject, email.body), 'utf8').toString('base64url');
      const sent = await call<{ id: string }>(`${GMAIL}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({ raw, ...(email.threadId ? { threadId: email.threadId } : {}) }),
      });
      return `Sent, as Gmail message ${sent.id}.`;
    },
    async createEvent(event) {
      const created = await call<{ htmlLink: string }>(`${CALENDAR}/calendars/primary/events?sendUpdates=all`, {
        method: 'POST',
        body: JSON.stringify({
          summary: event.title,
          start: { dateTime: event.start },
          end: { dateTime: event.end },
          attendees: event.attendees.map((email) => ({ email })),
        }),
      });
      return `Created the event: ${created.htmlLink}`;
    },
  };
}
