/**
 * The two invented people of demo mode, their mail and calendar, and the one exchange the scripted
 * demo model knows how to play. Every name, address and business here is made up. Times are set
 * relative to when the app starts, so the calendar always has a week ahead.
 */
import type { CalendarEvent, Mail } from './google/google.ts';

export type DemoPerson = {
  id: string;
  name: string;
  email: string;
  /** The agent's own name. */
  assistant: string;
  /** A line under the name on the sign-in page. */
  about: string;
  /** The profile document seeded for the agent. */
  profile: string;
  mail: Mail[];
  events: CalendarEvent[];
  /** What the scripted model does when the person asks `ask`: reply in `threadId` with `body`. */
  script: { ask: string; threadId: string; body: string; reason: string };
};

const DAY = 24 * 60 * 60 * 1000;

/** A time `days` from today at `hour`:`minute`, local to the server, as an ISO string. */
function at(days: number, hour: number, minute = 0): string {
  const when = new Date(Date.now() + days * DAY);
  when.setHours(hour, minute, 0, 0);
  return when.toISOString();
}

/** A weekday name `days` from today, such as "Thursday". */
const weekday = (days: number) => new Date(Date.now() + days * DAY).toLocaleDateString('en-GB', { weekday: 'long' });

function ada(): DemoPerson {
  const me = 'ada@brennan-ceramics.example';
  return {
    id: 'ada',
    name: 'Ada Brennan',
    email: me,
    assistant: 'Moss',
    about: 'Runs a two-person ceramics studio. Her assistant is Moss.',
    profile: `# Ada Brennan

Ada runs Brennan Ceramics, a studio of two potters making tableware to order. She sells to a few galleries and restaurants, and through a market stall once a month.

## How Ada writes

Ada tends to write short emails, three or four lines, warm but plain, and signs off "Ada". She answers a question in the first line.

## What Ada cares about

- Galleries and restaurants come first, because a missed order loses the account.
- Kiln days are fixed: nothing goes in the calendar on a firing day.
- She does not take orders she cannot finish a week before they are due.`,
    mail: [
      {
        id: 'm1', threadId: 't-harbour', from: 'Priya Shah <priya@harbour-gallery.example>', to: me,
        subject: 'Bowls for the winter show', date: at(-1, 16, 12),
        body: `Hi Ada,\n\nWe'd love twelve of the speckled bowls for the winter show. Could you have them with us by ${weekday(10)} week? And could you come in for half an hour this week to talk about how we display them? Tuesday or Wednesday morning suits me.\n\nThanks,\nPriya`,
      },
      {
        id: 'm2', threadId: 't-clay', from: 'Orders <orders@riverbank-clay.example>', to: me,
        subject: 'Your order has shipped', date: at(-2, 9, 30),
        body: 'Your order of 4 bags of stoneware clay has shipped and should arrive in two working days.',
      },
      {
        id: 'm3', threadId: 't-market', from: 'Tom Ellery <tom@saturday-market.example>', to: me,
        subject: 'Stall for next month', date: at(-3, 11, 5),
        body: "Hi Ada, your stall is booked for the first Saturday next month, same pitch as before. Tom",
      },
    ],
    events: [
      { id: 'e1', title: 'Kiln firing', start: at(1, 8), end: at(1, 17), attendees: [] },
      { id: 'e2', title: 'Glazing with Rosa', start: at(2, 13), end: at(2, 16), attendees: [] },
      { id: 'e3', title: 'Restaurant tasting: plate samples', start: at(4, 15), end: at(4, 16), attendees: ['chef@olive-and-ash.example'] },
    ],
    script: {
      ask: 'Can you reply to Priya? Yes to the twelve bowls, and I can come in on Wednesday at 10.',
      threadId: 't-harbour',
      body: `Hi Priya,\n\nYes, twelve speckled bowls is fine, and you'll have them by ${weekday(10)} week. I can come in on Wednesday at 10 to talk about the display.\n\nAda`,
      reason: 'Ada asked me to say yes to the bowls and offer Wednesday at 10. Her calendar is clear then, and the delivery date is the one Priya gave.',
    },
  };
}

function kofi(): DemoPerson {
  const me = 'kofi@mensah-studio.example';
  return {
    id: 'kofi',
    name: 'Kofi Mensah',
    email: me,
    assistant: 'Fen',
    about: 'A freelance architect working on house extensions. His assistant is Fen.',
    profile: `# Kofi Mensah

Kofi is a freelance architect who designs house extensions and loft conversions. He works alone, with a structural engineer he brings in per job.

## How Kofi writes

Kofi tends to write brief, formal emails and signs off "Kind regards, Kofi". He likes dates written out in full.

## What Kofi cares about

- Site visits happen in the morning, so the afternoon is for drawing.
- He never confirms a fee by email before he has seen the site.`,
    mail: [
      {
        id: 'k1', threadId: 't-loft', from: 'Hana Ito <hana.ito@mailbox.example>', to: me,
        subject: 'Loft conversion: site visit?', date: at(-1, 10, 40),
        body: 'Dear Kofi,\n\nA friend recommended you. We are thinking about a loft conversion and wondered whether you could visit to take a look. Any morning next week works for us.\n\nBest wishes,\nHana',
      },
      {
        id: 'k2', threadId: 't-eng', from: 'Lars Berg <lars@berg-structures.example>', to: me,
        subject: 'Beam calcs for Elm Road', date: at(-2, 15, 0),
        body: 'Kofi, calcs for the Elm Road steel are attached in principle. I will send the stamped version on Friday. Lars',
      },
    ],
    events: [
      { id: 'f1', title: 'Elm Road: site visit', start: at(1, 9), end: at(1, 11), attendees: ['lars@berg-structures.example'] },
      { id: 'f2', title: 'Planning portal deadline', start: at(3, 9), end: at(3, 10), attendees: [] },
    ],
    script: {
      ask: 'Please reply to Hana and offer a site visit next Tuesday at 9:30.',
      threadId: 't-loft',
      body: 'Dear Hana,\n\nThank you for getting in touch. I would be glad to visit. Would next Tuesday at 9:30 suit you?\n\nKind regards,\nKofi',
      reason: 'Kofi asked me to offer next Tuesday at 9:30. Mornings are for site visits, and nothing is booked then.',
    },
  };
}

let people: DemoPerson[] | undefined;

/** The demo people, made once per process so their times stay put while the app runs. */
export function demoPeople(): DemoPerson[] {
  people ??= [ada(), kofi()];
  return people;
}

export function demoPerson(id: string): DemoPerson | undefined {
  return demoPeople().find((person) => person.id === id);
}
