/**
 * Demo mode's mail and calendar: one invented person's fixtures, read-only, and an outbox table in
 * place of Gmail and Calendar. Searching is loose, good enough for fixtures: Gmail operators such
 * as `in:inbox` are skipped, and a message matches when any other word of the query is in its
 * sender, subject or body.
 */
import type { Sql } from '../db.ts';
import type { DemoPerson } from '../fixtures.ts';
import type { Google } from './google.ts';

const overlaps = (event: { start: string; end: string }, from: string, to: string) => event.end > from && event.start < to;

export function demoGoogle(sql: Sql, person: DemoPerson): Google {
  return {
    async searchMail(query, max) {
      const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2 && !word.includes(':'));
      const hits = person.mail.filter((mail) => {
        const text = `${mail.from} ${mail.subject} ${mail.body}`.toLowerCase();
        return words.length === 0 || words.some((word) => text.includes(word));
      });
      return hits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, max);
    },
    async readThread(threadId) {
      return person.mail.filter((mail) => mail.threadId === threadId);
    },
    async listEvents(from, to) {
      return person.events.filter((event) => overlaps(event, from, to)).sort((a, b) => a.start.localeCompare(b.start));
    },
    async sendEmail(email) {
      await sql`insert into outbox (agent, kind, input) values (${person.id}, 'email', ${JSON.stringify(email)}::text::json)`;
      return `Put the email to ${email.to} in the demo outbox.`;
    },
    async createEvent(event) {
      await sql`insert into outbox (agent, kind, input) values (${person.id}, 'event', ${JSON.stringify(event)}::text::json)`;
      return `Put the event "${event.title}" in the demo outbox.`;
    },
  };
}
