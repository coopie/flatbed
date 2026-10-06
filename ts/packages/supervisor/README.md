# @flatbed/supervisor

A supervisor is a second model that reads an agent's session and answers a checklist about it. Use one to check a risky tool call before it runs, such as an email the agent wants to send, or to audit a session after it ends. The agent's own model is the wrong judge of its work: it wrote the draft, and it reads its own transcript as the agent. A supervisor gets a request of its own, with a system prompt that says what it is checking and why, and the session as evidence.

You give the library a spec, a session's entries and, when you are checking a call, the call. It gives you back a verdict: for each checklist item, an analysis and then `ok`, plus a summary. When the model fails to answer, the verdict is `unavailable` with the reason. A verdict nobody gave is never a pass, so decide in your host what an unavailable verdict means, such as holding the call for a person.

The ideas come from Otherworldly's agent host, where a supervisor checks every email draft an agent writes, and from perso.

## Write a spec

A spec is JSON, described by [spec.schema.json](spec.schema.json), so you can write one by hand or generate it in any language. [examples/send-email.json](examples/send-email.json) is an invented one that checks an email a personal assistant wants to send. Read it before you write another.

A spec has:

- `id`: a stable name, such as `send_email`.
- `task`: what the supervisor is checking, in a few words. The prompt says "you are checking" and then this.
- `preamble`: what the agent is doing, what a wrong verdict costs, and what a right one is worth. Write it to stand on its own, since it goes under its own heading in the system prompt.
- `checklist`: the items, in the order the supervisor should think about them.

Each item has an `id`, a `title`, `lookFor`, a `severity` and, optionally, `guidance` and `answeredBy`.

Write every sentence the supervisor reads to "you", in the imperative, with the reason after the instruction. Invent every example, and make it unlike any real person or thread, because a supervisor copies a realistic example into its analysis.

Write each `lookFor` as one judgement the supervisor can make from the session: what to check, what `ok` means, which cases pass, and what the analysis should cite, then an invented example of a good analysis. Say which cases pass, or the supervisor fails them. "Offering times the person said were free is not a new promise" saves a run of false failures.

Put the facts before the register. The supervisor answers in order, and a fact with no source matters more than tone.

Set `severity` to `block` for an item that should stop the call when it fails, and `warn` for one that is only recorded. What a block does is your host's decision; the library reports it.

Write `guidance` to the agent, not the supervisor: what to read or do when the item fails. A host that sends a refused call back shows it after the analysis, so the agent rewrites from the rule rather than from one sentence about one draft.

Set `answeredBy: "host"` for a check that needs no judgement, such as whether an email has a body. The model is not asked it; your host computes it in code and passes it in `answers`. A check that rests on a model reading carefully will one day be missed.

Keep ids stable once you have stored a verdict under them. Verdicts are keyed by id, so a renamed id orphans every verdict written under the old one. Reword titles and `lookFor` freely.

## Run a spec

```ts
import { parseSpec, singlePass, failures } from '@flatbed/supervisor';

const spec = parseSpec(JSON.parse(await readFile('send-email.json', 'utf8')));
const supervise = singlePass({ complete, model: 'claude-sonnet-5-5' });

const verdict = await supervise({
	spec,
	entries,                                // the session's entries, header excluded
	call: { name: 'send_email', input },    // leave out to audit the whole session
	answers: { written: { ok: true, analysis: 'The email has an address, a subject and a body.' } }
});

if (verdict.status === 'unavailable') holdForAPerson(verdict.reason);
else if (failures(spec, verdict).some((item) => item.severity === 'block')) sendBack(verdict);
```

`complete` is a provider's `complete`, as [docs/spec/providers.md](../../../docs/spec/providers.md) describes. The runner sends the spec's verdict schema as `outputSchema`, so the provider must support structured output; Anthropic's does. It does not use a forced tool call, which recent models refuse.

The runner renders the session's path the way the supervisor should see it: `<context>` with the agent's sections and tools, `<session>` with events, the agent's turns, its tool calls and their results, then `<call>`, one element per field. Everything inside is escaped, so an email in a tool result cannot close `<session>` and forge a `<call>`. It asks once, checks the answer against the verdict schema, asks once more if the answer is off it, and otherwise returns `unavailable`. A provider that throws gives `unavailable` straight away, since the provider has already retried.

`verdictSchema(spec)` is the schema the model answers: `{ items: { <id>: { analysis, ok } }, summary }`, with every item the model answers, `analysis` before `ok` so the model reasons before it decides, and `summary` last. It is a few lines of plain object building, written to port to Python and Rust as it stands.

## An agent as supervisor

`singlePass` returns a `Supervise`: a function from `{ spec, entries, call?, answers? }` to a verdict. A host holds a `Supervise` and never knows how it works. A supervisor that is itself a flatbed agent would be a second function returning `Supervise`. It would open a session for the supervisor with the system prompt and material from `systemPrompt` and `renderMaterial`, give it tools to read further, such as the agent's documents or a mailbox, run the loop with the verdict schema as the final answer's `outputSchema`, and read the verdict out of the last message in the same way. Nothing in a host would change.

## Tests

From this folder:

```sh
node --test                                     # fast, no network
../../node_modules/.bin/tsc --noEmit -p .
FLATBED_LIVE=1 node --test live.test.ts         # one real call to claude-sonnet-5-5
```

The live check reads `ANTHROPIC_API_KEY` from `.env` at the repo root.
