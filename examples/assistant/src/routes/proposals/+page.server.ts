import { fail } from '@sveltejs/kit';
import type { GuardRecord } from '@flatbed/supervisor';
import { getHost } from '$lib/server/app.ts';
import { FIELDS } from '$lib/server/plugins.ts';
import { emailSpec } from '$lib/server/supervision.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const host = await getHost();
  const person = locals.person!;
  const proposals = await host.proposals(person);

  // The supervisor's verdict lives in the session, beside the call it judged.
  const records = new Map<string, GuardRecord>();
  for (const session of new Set(proposals.map((p) => p.session))) {
    for (const entry of (await host.sessions.read(person.id, session)).entries) {
      if (entry.type !== 'custom' || entry.plugin !== 'supervisor') continue;
      const record = entry.data as GuardRecord;
      if (record.verdict.callId) records.set(record.verdict.callId, record);
    }
  }
  const titles = Object.fromEntries(emailSpec.checklist.map((item) => [item.id, { title: item.title, severity: item.severity }]));

  return {
    proposals: proposals.map((p) => {
      const record = records.get(p.callId);
      const verdict = record?.verdict;
      return {
        ...p,
        fields: FIELDS[p.kind],
        check: verdict && {
          mode: record.mode,
          status: verdict.status,
          summary: verdict.status === 'given' ? verdict.summary : verdict.reason,
          items: verdict.status === 'given' ? Object.entries(verdict.items).map(([id, item]) => ({ id, ...titles[id], ...item })) : [],
        },
      };
    }),
    outbox: host.mode === 'demo' ? (await host.outbox(person)).map((o) => ({ ...o, sent_at: o.sent_at.toISOString() })) : [],
  };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const form = await request.formData();
    const host = await getHost();
    const id = String(form.get('id'));
    const outcome = form.get('outcome') === 'accepted' ? 'accepted' : 'denied';
    const proposal = (await host.proposals(locals.person!)).find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') return fail(409, { message: 'That proposal has already been decided.' });
    // host.decide claims the proposal again, so a second decision racing this one still sends nothing.
    const input = Object.fromEntries(
      FIELDS[proposal.kind].map((field) => {
        const value = String(form.get(field) ?? '');
        // Attendees are edited as one comma-separated line.
        return [field, field === 'attendees' ? value.split(',').map((a) => a.trim()).filter(Boolean) : value.replaceAll('\r\n', '\n')];
      }),
    );
    const note = String(form.get('note') ?? '').trim();
    // Sending happens before this answers; the agent's run goes on after it.
    try {
      await host.decide(locals.person!, id, { outcome, input, ...(note ? { note } : {}) });
    } catch (error) {
      // The messages say what went wrong, such as a line break in the subject or Google's answer, and carry no secret.
      return fail(409, { message: `That did not go through: ${(error as Error).message}` });
    }
    return { decided: id };
  },
};
