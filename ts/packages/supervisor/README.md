# @flatbed/supervisor

A supervisor is a second model that reads an agent's session and answers a checklist about it. Use one to check a risky tool call before it runs, such as an email the agent wants to send, or to audit a session after it ends. The agent's own model is the wrong judge of its work: it wrote the draft, and it reads its own transcript as the agent. A supervisor gets a request of its own, with a system prompt that says what it is checking and why, and the session as evidence.

You give the library a spec, a session's entries and, when you are checking a call, the call. It gives you back a verdict: for each checklist item, an analysis and then `ok`, plus a summary. When the model fails to answer, the verdict is `unavailable` with the reason. A verdict nobody gave is never a pass, so decide in your host what an unavailable verdict means, such as holding the call for a person.

The ideas come from Otherworldly's agent host, where a supervisor checks every email draft an agent writes, and from perso.

## Write a spec

A spec is JSON, described by [spec.schema.json](spec.schema.json). Read the invented [examples/send-email.json](examples/send-email.json) before you write one. It has an `id`, the `task` the supervisor is checking in a few words, a `preamble` that says what the agent is doing and what a wrong verdict costs, and a `checklist` of items in the order the supervisor should think about them.

Write every sentence the supervisor reads to "you", and invent every example, because a supervisor copies a realistic one into its analysis. For each item:

- Write `lookFor` as one judgement the supervisor can make from the session, and say which cases pass, or the supervisor fails them. "Offering times the person said were free is not a new promise" saves a run of false failures.
- Put the facts before the register: a fact with no source matters more than tone.
- Set `severity` to `block` for an item that should stop the call, or `warn` for one that is only recorded.
- Write `guidance` to the agent: what to read or do when the item fails. A refusal shows it after the analysis.
- Set `answeredBy: "host"` for a check that needs no judgement, such as whether an email has a body. Your host answers it in code.

Keep ids stable once you have stored a verdict under them, since verdicts are keyed by id. Reword titles and `lookFor` freely.

## Run a spec

```ts
import { parseSpec, singlePass, blocked } from '@flatbed/supervisor';

const spec = parseSpec(JSON.parse(await readFile('send-email.json', 'utf8')));
const supervise = singlePass({ complete: (request) => provider.complete(request), model: 'claude-sonnet-5-5' });

const verdict = await supervise({
  spec,
  entries,                                          // the session's entries, header excluded
  call: { id: 'call_02', name: 'send_email', input }, // leave out to audit the whole session
  answers: { written: { ok: true, analysis: 'The email has an address, a subject and a body.' } }
});

if (blocked(spec, verdict)) sendBack(verdict);
```

Decide with `blocked(spec, verdict)`, which is true when the verdict is unavailable or a `block` item failed. `failures(spec, verdict)` lists the failed items to show or send back. An unavailable verdict has none, so never read an empty list as a pass.

`answers` holds one answer for each `answeredBy: "host"` item and no others. Anything else throws, since it is a bug in the host.

The supervisor reads the session's path as XML: `<context>` with the agent's sections and tools, `<session>` with its events, turns, calls and results, then `<call>` with each input field in a `<field name="...">`. Everything inside is escaped as the core escapes it, so an email in a tool result cannot close `<session>` and forge a `<call>`. `singlePass` sends the verdict schema as `outputSchema`, so the provider must support structured output, as Anthropic's does. It asks again once when the answer is off the schema.

## One call, or an agent

`singlePass` and `agentPass` both return a `Supervise`, a function from `{ spec, entries, agent?, session?, call?, answers?, signal? }` to a verdict, so a host or the guard takes either. `signal` stops the check, and the verdict is then unavailable.

Use one call when everything the supervisor needs is in the session, as it is for most checks of a draft. It is one request, quick and cheap.

Use an agent when the supervisor has to look something up, such as a document the agent cites but did not read this session. `agentPass` runs a fresh flatbed agent for each check, with the spec and then the material as its context sections, a request event asking for the verdict, and the tools you pass. It finishes by calling `report_verdict`, whose input schema is the verdict schema. When it stops without reporting, the verdict is unavailable.

Each check is its own agent, with an id of `supervisor`, or the `id` you set, then a dash and four hex characters, such as `supervisor-9b2e`. The verdict's `supervisor` field holds that id, so you can find the check's one session. Its header's `parent` links to the session checked, with `reason: "supervise"`, `agent` set to the checked agent and `entry` to that session's head. Checks never share a session, so any number can run at once on one store.

```ts
const supervise = agentPass({
  store,                                  // where the supervisor's sessions go
  providers: { anthropic },
  model: 'anthropic/claude-sonnet-5-5',
  tools: [readDocTool]                    // read-only tools; it should look, not act
});
```

## Guard a tool

`supervisorGuard` is a plugin that checks each call to a supervised tool before it runs. Give it a spec for each tool, a mode and a supervisor:

```ts
const guard = supervisorGuard({
  specs: { send_email: sendEmailSpec },
  mode: 'enforce',
  supervise,
  answers: (call) => ({ written: { ok: hasBody(call.input), analysis: 'Checked in code.' } })
});
const agent = createAgent({ id: 'assistant', model, plugins: [docs, email, guard] }, { store, providers });
```

- `off` checks nothing.
- `shadow` records each verdict and lets every call run. Start here with a new spec, and read what it would have refused.
- `enforce` replaces a blocked call with an error result that lists each failed item with its analysis and guidance, so the agent can redraft and call again. A failed `warn` item never blocks.

When the supervisor gives no verdict, `enforce` refuses the call, unless you set `whenUnavailable: 'allow'`. Allow only calls that cost little when they go wrong. The guard never throws: when your `answers` function or the supervisor fails, the verdict is unavailable with the reason, and this setting decides. The guard passes the run's stop signal to the supervisor, so stopping the agent stops its check.

Every verdict, unavailable ones included, is appended to the session as a `custom` entry with `plugin: "supervisor"` and `data: { mode, refused, verdict }`, so a host can show it beside the call. The guard's `beforeTool` runs in plugin order, so list it after the plugin that supplies the tool and before any plugin that might answer the call itself.

## Tests

From `ts/`:

```sh
pnpm exec tsc --noEmit -p tsconfig.json
(cd packages/supervisor && node --test "*.test.ts")                       # fast, no network
(cd packages/supervisor && FLATBED_LIVE=1 node --test live.test.ts)       # one real call to claude-sonnet-5-5
```

The live check reads `ANTHROPIC_API_KEY` from `.env` at the repo root.
