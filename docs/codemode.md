# Codemode: a design for review

Nothing here is built. Sam wants to look at the security question first. This page sets out the design so that the decision is quick.

## What codemode is

Instead of calling one tool per turn, the model writes a short script that calls several tools, loops over their results and returns only what it needs. A task that took ten turns, each re-reading the whole context, takes one. pi shipped this on 1 October 2026 ([docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md)); Cloudflare's Code Mode is the same idea.

## The worry, and the answer

Sam's question: could a script leak the source code, or anything else the host can reach?

A script can only reach what it is given. The design rests on three rules:

1. **The script runs in an interpreter with no access to the host.** QuickJS compiled to WebAssembly has no file system, network, environment, timers or `require`. It cannot read the source code, `.env` or anything else unless a tool returns it.
2. **Every tool call leaves the interpreter as a message.** Inside, `tools.read_doc({name})` is a stub that posts `{callId, name, input}` to the host and waits. The host runs the call exactly as if the model had made it directly: through `beforeTool`, so the supervisor and approvals see it, then the tool, then `afterTool`, so redaction applies. The result goes back in as a message.
3. **The host logs every nested call** on the codemode tool's result, so the session shows each call the script made.

So codemode can do no more than the model could do with direct calls; it does it in fewer turns. The risk worth naming is different: a script can chain calls faster than a person can watch, so a tool that sends or deletes should keep waiting for a person through its own guard, as it does today.

This is the "almost sandbox, track the calls coming out, send responses back in" shape Sam described, and it is also how pi's codemode works: the interpreter is closed, and its only door is the tool bridge. Because the bridge is message passing, calls are naturally asynchronous: a script can start several and await them together, and the host can run them concurrently or queue one for a person.

## How it would fit flatbed

A plugin, `codemode`, with no change to the core:

- its `context` hook adds one tool, `codemode`, whose description lists the other tools as TypeScript declarations generated from their schemas, and hides them from direct use if the agent prefers
- the tool's `run` starts a QuickJS worker, bridges calls through the loop's own tool runner, enforces a time limit and an output cap, and returns the script's output

The TypeScript implementation can use pi's `@earendil-works/pi-codemode` package, which has no pi dependencies, or `quickjs-emscripten` directly.

## Python and Rust

- **Python:** Monty, from the Pydantic team, is a Python interpreter written in Rust for exactly this, running model-written Python with no host access and external functions as the bridge. It is young; check its state before relying on it.
- **Rust:** embed QuickJS through `rquickjs`, or call Monty natively.

## Decisions for Sam

- Build it as a TypeScript plugin first, on pi's package?
- Should tools that change the outside world be callable from a script at all, or only read-only tools?
