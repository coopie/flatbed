# Start here

Every session starts from this file. Before you change anything, read:

1. [docs/ways-of-working/README.md](docs/ways-of-working/README.md): how a piece of work runs, from brief to write-up
2. [docs/ways-of-working/writing.md](docs/ways-of-working/writing.md): how we write docs, prompts and comments

If you are leading the work, also read [docs/ways-of-working/leading.md](docs/ways-of-working/leading.md). If you are working from a brief, it is in `docs/kickoffs/`; read it after these and the project docs below, since it builds on them.

## This project

flatbed is a very small agent harness. The core runs a model in a loop, keeps every session as an append-only log in its own provider-neutral format, and lets plugins add context and tools. Everything else, such as pinned documents, supervision and sub-agents, is a plugin or a library on top. The core is specified in Markdown and has reference implementations in TypeScript, Python and Rust that pass one shared conformance suite. An example app, a personal assistant, shows a product built on it.

The docs, and when to read them:

- [docs/overview.md](docs/overview.md): what we are building, why, and where we are. Read it every session.
- [docs/decisions.md](docs/decisions.md): choices already made, with their reasons. Skim it before you make a choice of your own.
- [docs/stack.md](docs/stack.md): the languages, how to check your work, how to see a session, and live tests. Read it before you run or change code.
- [docs/spec/README.md](docs/spec/README.md): the core spec, which every implementation follows. Read it when you touch an implementation or the conformance suite.
- [docs/design.md](docs/design.md): how the example app looks. Read it before you change anything visual.
- [docs/codemode.md](docs/codemode.md): the design of codemode, where the model writes a script that calls tools.
- [docs/walkthrough.html](docs/walkthrough.html): an interactive tour of the layers, a session step by step and the example app, written for Sam after the first overnight build on 6 October. It is a snapshot from then, so the overview has where things stand now.
- Each plugin and library has a README beside its code, in `ts/packages/<name>/` and `examples/assistant/`.

The commands worth knowing:

- `scripts/check.sh` runs every check and the conformance suite for all three implementations, and `scripts/check.sh ts` runs one section. It is the gate before a merge.
- `node ts/packages/core/cli.ts view <session-file>` prints a session as the model saw it. [docs/stack.md](docs/stack.md) has the Python and Rust equivalents.
