# Decisions

Choices already made, with their reasons, so that nobody has to make them again. Add an entry when you make a choice another builder could reasonably have made differently, in about 120 words: a heading that names the choice, the date, then **Chose**, **Because** and **Rules out**, with a link to the evidence. Newest at the bottom. When a later choice replaces an entry, move the old one to `docs/decisions-archive.md`.

Entries marked *for review* were made overnight on 6 October 2026 while Sam was asleep. Sam reviews them and removes the mark.

## Our own session format, shaped after pi's

6 October 2026.

**Chose:** sessions are JSONL with a header line, then entries carrying `id` and `parentId`, holding messages in flatbed's own small union of roles and content blocks.

**Because:** Sam wants sessions that do not depend on Anthropic's format. pi's format ([session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)) proves the shape across many providers, and its parent links make forking and rewinding cheap.

**Rules out:** storing provider payloads. A provider's own fields, such as a thinking signature, ride on the block that needs them.

## TypeScript first, then Python and Rust

6 October 2026.

**Chose:** build the TypeScript core alongside the spec, then Python and Rust against the conformance suite.

**Because:** the example app and pi's codemode are TypeScript, and writing the spec with one real implementation keeps it honest.

**Rules out:** the spec running ahead of every implementation.

## Plain HTTP to providers *(for review)*

6 October 2026.

**Chose:** each implementation calls provider APIs with its own HTTP client, not the vendor SDK.

**Because:** an adapter is one small file of translation either way, and without SDKs the three implementations look alike and the core has no dependencies.

**Rules out:** SDK conveniences such as built-in retries; the adapter retries 429 and 5xx itself.

## Codemode waits for Sam *(for review)*

6 October 2026.

**Chose:** write the design for codemode, with tool calls bridged out of the interpreter to the host, and build nothing yet.

**Because:** Sam wanted to look at the security question himself first. See [codemode.md](codemode.md).

**Rules out:** nothing; the plugin hooks already allow it.

## Messaging waits for Sam *(for review)*

6 October 2026.

**Chose:** no WhatsApp or iMessage channel yet.

**Because:** Sam has no business number for WhatsApp, and iMessage needs a Mac relay. He wants to decide on 7 October.

**Rules out:** nothing.

## Local repo only, no deploy *(for review)*

6 October 2026.

**Chose:** keep flatbed in a local git repo, and write the Cloud Run deploy script without running it.

**Because:** making a GitHub repo public or private, and spending on Cloud Run, are Sam's calls.

**Rules out:** nothing; `examples/assistant/deploy.sh` is ready to run.

## Supervisor specs are JSON, with host answers passed as values *(for review)*

6 October 2026.

**Chose:** a supervisor spec is a JSON document checked against `ts/packages/supervisor/spec.schema.json`, with the checklist as an ordered array. An item the host answers in code is marked `answeredBy: "host"`, and the host passes its answers to the runner as values with each request.

**Because:** the brief asks for specs any language can write, and an array keeps its order in every language, where object key order does not. Otherworldly kept the host's check as a function on the brief, which cannot live in JSON.

**Rules out:** functions or gathered material on the spec itself. A host that wants extra material adds it to the session before it asks.

## The agent supervisor writes its own session start *(for review)*

6 October 2026.

**Chose:** `agentPass` creates each check's session itself, with a header whose `parent` points at the checked session (`reason: "dispatch"`, `entry` at its head), a context entry, and the material as a user message. It then delivers a short event and lets the loop run. The guard takes a `Supervise`, not a `complete` function.

**Because:** the core escapes an event's text, and the material is already escaped XML, so delivering it as an event would escape it twice. The spec's parent reasons have no `supervise`, and a supervisor is a child session that reports back, which is what `dispatch` means. Taking a `Supervise` lets the guard use either runner.

**Rules out:** two checks at once on one supervisor agent id, since the loop resumes the newest session; the runner queues them.

## A harness notice alone does not start a run *(for review)*

7 October 2026.

**Chose:** a session needs a run only when its last entry, ignoring `custom` and `context` entries, is a tool result or an event not from the harness. The soft-budget notice is the exception: the loop runs one more turn after it.

**Because:** otherwise a bare run after a stop resumes the work a person stopped, a failed call is retried silently, and every new session pays a call to answer "Session started". The review of wave 1 found this (the core-fixes brief, in git at `e38873b`).

**Rules out:** hosts relying on a notice to wake an agent; they deliver a real event instead, as dispatch now does.

## A plugin hook that throws gives its call an error result *(for review)*

7 October 2026.

**Chose:** when `beforeTool` or `afterTool` throws, that call's result is `The <plugin> plugin failed: <message>`, and the run carries on.

**Because:** failing the run left the session to be repaired later with a misleading "harness stopped" result, and a supervisor that fails should not take an agent down with it.

**Rules out:** treating a plugin bug as fatal. The error is visible in the session for a person to find.

## The timeline uses the day the session opened *(for review)*

7 October 2026.

**Chose:** the docs plugin takes the day once from the session header, and `add_to_timeline` writes to that day.

**Because:** the same documents then always give the same context bytes, which keeps the cache warm, and a resumed session keeps its day.

**Rules out:** a session running past midnight writing to the new day; it writes to the day it opened until it resets.

## Each agent check is its own agent, opened by the core *(for review)*

7 October 2026. Replaces "The agent supervisor writes its own session start".

**Chose:** `agentPass` makes a fresh agent for each check, with the id `<id>-<hex4>`, as dispatch does for a sub-agent. The core opens its one session, from the agent's `parent` (`reason: "supervise"`, naming the checked agent, session and head entry). The system prompt and the material are context sections, and a short event asks for the verdict. The verdict's `supervisor` field names the agent, so a host can find the session.

**Because:** the core now gives an agent's first session a parent and has a `supervise` reason, and a section is not escaped, so the runner no longer needs to write the store itself. An agent per check means two checks can never share a session, even from two guards on one store.

**Rules out:** listing every check under one agent id. A host finds a check's session from its verdict.

## Async Python, with httpx *(for review)*

7 October 2026.

**Chose:** the Python core is `asyncio` throughout: the loop, providers, hooks and tools are coroutines, and a turn's tool calls run with `asyncio.gather` under a semaphore of `max_concurrent_tools`. Hooks and tools may still be plain functions; the loop awaits what is awaitable. The Anthropic provider uses `httpx.AsyncClient`, a new client per call. Stores stay synchronous file I/O.

**Because:** Sam wants idiomatic modern Python that runs tools together, as TypeScript does. The standard library has no async HTTP client, and httpx saves writing one. Appending one line to a local file is fast enough not to need a thread.

**Rules out:** calling `Runner.run` from synchronous code without `asyncio.run`, and a store that blocks for long, such as a remote database, without wrapping it in `asyncio.to_thread`.

## One host API, async throughout, concurrency by setting

18 October 2026.

**Chose:** every implementation is async from end to end (TypeScript promises, Python `asyncio`, Rust `tokio`), offers the same host API with the same names ([spec/host.md](spec/host.md)), and runs a turn's tool calls by the agent's `toolExecution`, `concurrent` or `serial`, with `maxConcurrentTools`.

**Because:** a comparison of the three cores on 18 October found that they had drifted where the suite could not see: Rust ran tools one at a time and could not interrupt a model call, hooks were sync in Rust and the store sync in Python, and names differed. Sam wants them alike, and as concurrent as each language allows.

**Rules out:** an implementation choosing its own concurrency or stop behaviour. The suite now checks both.
