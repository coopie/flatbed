/**
 * One person's mail and calendar, behind five calls. The live version talks to Gmail and Calendar
 * over plain HTTP (live.ts); the demo version reads invented fixtures and sends to the outbox
 * table (demo.ts). Mail and events pass through as plain data.
 */

export type Mail = { id: string; threadId: string; from: string; to: string; subject: string; date: string; body: string };
export type CalendarEvent = { id: string; title: string; start: string; end: string; attendees: string[] };
export type Email = { to: string; subject: string; body: string; threadId?: string };
export type NewEvent = { title: string; start: string; end: string; attendees: string[] };

export type Google = {
  /** The newest messages matching a Gmail search, newest first, with their bodies cut short. */
  searchMail(query: string, max: number): Promise<Mail[]>;
  readThread(threadId: string): Promise<Mail[]>;
  listEvents(from: string, to: string): Promise<CalendarEvent[]>;
  /** Sends an email and says in a line what it did. */
  sendEmail(email: Email): Promise<string>;
  /** Creates an event and says in a line what it did. */
  createEvent(event: NewEvent): Promise<string>;
};
