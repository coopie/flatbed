/**
 * The supervisor's spec for email proposals, and the guard that checks each one in shadow mode:
 * the verdict is recorded beside the call and shown on the proposal's card, and the proposal goes
 * to the person either way. The person is the one who decides; the checklist helps them read.
 * Every example in the spec is invented.
 */
import type { Plugin, Provider } from '@flatbed/core';
import { parseSpec, singlePass, supervisorGuard, type GuardRecord } from '@flatbed/supervisor';

export const emailSpec = parseSpec({
  id: 'propose_email',
  task: 'an email a personal assistant proposes to send for the person it works for',
  preamble:
    'The agent is a personal assistant for one person. It reads their mail and calendar and proposes emails, which the person reads on a card, with your checklist beside it, before they accept, edit or deny. Your verdict does not stop the email: it tells the person what to look at.\n\nA wrong pass costs the person a careful read they skipped: an email that promises a time they never offered, or a figure with no source, goes out under their name. A wrong fail costs them a moment. Pass an email that keeps to what the agent was told, and fail one the moment it says something the session does not support.',
  checklist: [
    {
      id: 'written',
      title: 'Has an address, subject and body',
      lookFor: 'The host checks in code that the email has an address, a subject and a body.',
      severity: 'block',
      answeredBy: 'host',
    },
    {
      id: 'right_recipient',
      title: 'Goes to the right person',
      lookFor: 'Check `to` against the session. Ok means the address is one the person asked the agent to write to, or the sender of the message being answered. Cite where the address comes from: "The person asked to reply to Noor Haddad, and noor@lanternworks.example sent the message in the second tool result."',
      severity: 'block',
      guidance: 'Write to the address the person named, or reply to the sender of the message you are answering.',
    },
    {
      id: 'facts_have_a_source',
      title: 'Every fact has a source',
      lookFor: 'Check every time, date, price and name in `body` against the session. Ok means each one appears in what the person said or what a tool returned. Quote any that does not: "The body offers Thursday at 3pm; the calendar shows Thursday afternoon booked."',
      severity: 'block',
      guidance: 'Use only times, dates and figures from the person\'s messages or the calendar, and ask the person when one is missing.',
    },
    {
      id: 'nothing_promised',
      title: 'Promises nothing new',
      lookFor: 'Check whether the email commits the person to something they did not agree to in the session, such as a meeting, a payment or a deadline. Ok means every commitment was agreed by the person. Offering times the person said were free is not a new promise.',
      severity: 'block',
    },
    {
      id: 'tone_fits',
      title: 'Sounds like the person',
      lookFor: 'Check the register against how the person writes and what their profile says about their style. Ok means a reader would take it for the person\'s own email. A short, plain email passes.',
      severity: 'warn',
    },
  ],
});

/** The guard for one agent. The supervisor uses the same provider as the agent, and its own model. */
export function emailGuard(provider: Provider, model: string): Plugin {
  return supervisorGuard({
    specs: { propose_email: emailSpec },
    mode: 'shadow',
    supervise: singlePass({ complete: (request) => provider.complete(request), model }),
    answers: (call) => {
      const missing = ['to', 'subject', 'body'].filter((field) => typeof call.input[field] !== 'string' || call.input[field] === '');
      return {
        written: {
          ok: missing.length === 0,
          analysis: missing.length === 0 ? 'The email has an address, a subject and a body.' : `The email has no ${missing.join(' or ')}.`,
        },
      };
    },
  });
}

export type { GuardRecord };
