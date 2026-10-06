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
