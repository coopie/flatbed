# Sessions

A session is the one record of what an agent saw and did. Everything else, such as the messages sent to the model, a page that shows the session, or a cost report, is built from it. Write it append-only: never rewrite or delete a line.

## The file

A session is a JSONL file, one JSON object per line, encoded as UTF-8. The file store keeps an agent's sessions at `<root>/<agent-id>/<session-id>.jsonl`. Other stores, such as Postgres, keep the same objects in the same order.

The first line is the **header**:

```json
{"type":"session","version":1,"id":"2026-10-06T21-04-11Z-a3f9","agent":"assistant","createdAt":"2026-10-06T21:04:11.000Z","parent":{"session":"2026-10-06T19-55-02Z-77c1","reason":"reset"}}
```

- `id` is unique for the agent. Implementations make it from the UTC time to the second and four random hex characters, so a directory listing sorts by age. A new id must sort after the agent's previous session id: when the time has not moved on since that id, take its time and add one to its hex part.
- `parent` is optional. It links a session to the one it came from, with `reason` set to `reset`, `fork` or `dispatch`, and an optional `entry` id for a fork or a dispatch.

Every other line is an **entry**:

```json
{"type":"message","id":"5c0e19a2","parentId":"e41b7730","at":"2026-10-06T21:04:13.512Z","message":{...}}
```

- `id` is eight random hex characters, unique within the file.
- `parentId` is the id of the entry this one follows, or `null` for the first entry.
- `at` is the time the entry was written, as an ISO 8601 string in UTC.

## The path

Entries form a tree through `parentId`. The **head** is the last entry in the file. The **path** is the list of entries from the root to the head, found by following `parentId` back from the head. The model only ever sees the path.

Normally every entry's parent is the line before it, so the path is the whole file. To rewind or branch, a host appends a new entry whose parent is an earlier entry; the entries after that point stay in the file but leave the path. A host that never branches can ignore this, but every implementation must compute the path by parent links, not by line order.

## Entry types

### `context`

The frozen context: named text sections and the tool definitions, fixed when the session opens. A provider turns the sections into its system prompt.

```json
{"type":"context","sections":[{"name":"soul","text":"You are...","cache":true},{"name":"timeline","text":"<timeline>...</timeline>"}],"tools":[{"name":"reset","description":"...","inputSchema":{"type":"object","properties":{"reason":{"type":"string"}}}}]}
```

- `sections` are in order, from the most stable to the most volatile. `cache: true` marks the end of a stretch a provider may cache.
- `tools` holds each tool's `name`, `description` and `inputSchema`, a JSON Schema object. The code that runs a tool is not stored.

The first entry of every session is a `context` entry. A later one replaces it whole, which a host may do when a deploy changes the tools.

### `message`

A message to or from the model, in flatbed's own format.

```json
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I'll check."},{"type":"toolCall","id":"call_01","name":"read_doc","input":{"name":"notes"}}],"model":"anthropic/claude-opus-5-5","usage":{"input":5120,"output":88},"stop":"toolUse"}}
```

There are three roles:

- **`user`**: `content` is a list of blocks. Hosts rarely write these directly; events are the usual way in.
- **`assistant`**: `content`, plus `model` as `<provider>/<model-name>`, `usage` with `input` and `output` token counts (and `cacheRead` and `cacheWrite` when the provider reports them), and `stop`, one of `end`, `toolUse`, `maxTokens` or `error`.
- **`tool`**: the result of one tool call: `callId`, `name`, `content` as a list of blocks, and `isError`.

Content blocks:

- `{"type":"text","text":...}`
- `{"type":"image","mimeType":"image/png","data":<base64>}`
- `{"type":"thinking","text":...,"signature":...,"provider":...}`, where `signature` and `provider` are optional. A provider sends a thinking block back only to the provider that made it.
- `{"type":"toolCall","id":...,"name":...,"input":{...}}`, only in assistant messages.

### `event`

Something from outside the agent, for the model to see.

```json
{"type":"event","kind":"message","attrs":{"from":"Sam"},"text":"Can you move my 3pm?"}
```

- `kind` names the event, such as `message`, `reminder` or `notice`. It is a lower-case word or snake_case, safe as an XML element name.
- `attrs` is an optional map of string values.
- `text` is the body, which may be empty.

A notice from the harness to the agent, such as a budget warning, is an event of kind `notice` with `attrs.from` set to `harness`.

### `reset`

The session has ended.

```json
{"type":"reset","by":"agent","reason":"notes are up to date"}
```

`by` is `agent` when the agent called the `reset` tool, or `harness` when the loop ended the session itself. `reason` is left out when the agent gave none. Nothing follows a reset. The next run opens a new session.

### `custom`

State a plugin keeps in the log, such as a supervisor's verdict. The model never sees it.

```json
{"type":"custom","plugin":"supervisor","data":{...}}
```

## Rendering the path for the model

The loop turns the path into the list of messages it sends to a provider. This rendering is part of the contract, because the conformance suite checks the messages the fake model receives.

1. Take the last `context` entry on the path as the context. It is not a message.
2. Copy each `message` entry's message as it is.
3. Render each `event` as a text block in a `user` message: an XML element named by `kind`, with `attrs` as attributes sorted by key and `text` as its content. Escape `&`, `<` and `>` in the text, and `&`, `<`, `>` and `"` in attributes. For example, `<message from="Sam">Can you move my 3pm?</message>`. An event with empty text renders as `<kind></kind>`.
4. Merge neighbouring `user` messages into one, keeping block order.
5. Skip `custom` entries.

Tool results stay as `tool` messages. A provider that wants them inside a user message, as Anthropic does, moves them there itself.
