# @flatbed/codemode

Use this plugin to let an agent do several tool calls in one turn by writing a short Python script, such as reading ten documents to find the two that mention a name. Without it, the model makes one call per turn or a batch of calls whose full results all land in its session. With it, the script calls the tools, keeps what it needs and prints or returns only that, so the session holds one call and a short result.

The plugin adds one tool, `run_script`. Its description lists the tools a script may call, as Python `async def` signatures made from their schemas, with each tool's description as the docstring. You choose those tools by name. A script awaits each call, and can run calls at the same time with `asyncio.gather`. A tool's result comes back as text, and a failed call raises `RuntimeError` with the tool's message. The model gets back what the script printed and the value of its last line, or the script's error.

## Why it is safe to run the model's code

The script runs in [Monty](https://github.com/pydantic/monty), a sandboxed Python interpreter, inside a separate worker process. Inside Monty there are no files, no environment and no network, and a tool is a stub with nothing behind it to inspect. The worker starts with an empty environment, so no key reaches it even by accident. [docs/codemode.md](../../../docs/codemode.md) gives the guarantees and how the spike tested them.

Each nested call goes through the agent's plugins exactly as a direct call does: `beforeTool`, the tool, then `afterTool`, so a supervisor or a guard sees every call a script makes. A tool that is not on your list does not exist inside the script. Each nested call is recorded in the session as a `custom` entry from `codemode`, with the call and its result.

The plugin ends the worker when:

- the script makes more tool calls than `maxCalls`, 25 unless set
- the script runs longer than `timeoutMs`, 60 seconds unless set, counting time spent in tools
- the run is stopped
- the script uses more heap than `maxMemory`, 64 MB unless set, which Monty itself refuses

## Set it up

You need [uv](https://docs.astral.sh/uv/) on the `PATH`. The first script installs the worker's one dependency into `codemode/.venv` at the repo root.

```ts
import { createAgent } from '@flatbed/core';
import { withCodemode } from '@flatbed/codemode';

const agent = createAgent(
  {
    id: 'assistant',
    model: 'anthropic/claude-opus-5-5',
    // Your plugins, then codemode, allowed to call two of their tools.
    plugins: withCodemode([docs, supervisor], { tools: ['list_docs', 'read_doc'] }),
  },
  { store, providers },
);
```

`withCodemode` returns your plugins followed by the codemode plugin. It wraps their `context` hooks to see the tools they add, since codemode needs the allowed tools' descriptions and schemas to describe them to the model, and a `context` hook sees nothing of other plugins' tools.

`run_script` runs each nested call with the core's `ctx.runTool`. Nested calls share the turn's limit of `maxConcurrentTools` with the model's own calls, and `run_script` gives up its own place while it waits for them, so a script works with a limit of 1 or with `toolExecution: serial`, where its calls run one at a time.

Which tools to allow is open: [docs/codemode.md](../../../docs/codemode.md) asks whether tools that send or change something should be callable from a script at all. Until that is settled, list only tools you would be content to see called many times in one turn.

For replay tests, `startTime` fixes the script's clock.

## The worker

The worker, `codemode/worker.py` at the repo root, is shared by the TypeScript, Python and Rust plugins. Each starts it and speaks JSON lines to it, as the protocol section of [docs/codemode.md](../../../docs/codemode.md) describes. The Python plugin is `flatbed.plugins.codemode` and the Rust one is the `flatbed-codemode` crate in `rust/codemode`.

## Tests

From this folder, `node --test "*.test.ts"`. The tests use the faux provider and the real worker, and are skipped when `uv` is missing. `FLATBED_LIVE=1` also runs one conversation with a real model.
