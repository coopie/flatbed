# flatbed

flatbed is a very small agent harness. The core runs a model in a loop, keeps every session as an append-only log in its own provider-neutral format, and lets plugins add context and tools. Everything else, such as pinned documents, supervision and sub-agents, is a plugin or a library on top. The core is specified in Markdown and has reference implementations in TypeScript, Python and Rust that pass one shared conformance suite.

Before you change anything, read:

- [docs/ways-of-working/README.md](docs/ways-of-working/README.md): how we work, and what done means
- [docs/ways-of-working/writing.md](docs/ways-of-working/writing.md): how we write docs, prompts and comments
- [docs/overview.md](docs/overview.md): what we are building, why, and where we are
- [docs/decisions.md](docs/decisions.md): choices already made, with their reasons
- [docs/spec/README.md](docs/spec/README.md): the core spec, which every implementation follows, when you touch any implementation or the conformance suite

If you are working from a brief, it is in `docs/kickoffs/`. Read it last, since it builds on the pages above.
