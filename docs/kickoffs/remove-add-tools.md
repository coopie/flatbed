# Brief: take tools that join a session back out

On 19 October flatbed gained `available` tools and `ctx.addTools`, which add tools to a session part way through it. On 20 October Parker, the first agent to use it, broke on Opus 5.5: Anthropic signs a thinking model's thinking blocks against everything before them, the tools list included, so the first call after tools were added, and every call after, failed with HTTP 400 ("thinking block is bound to a different conversation"). The rule Sam and the lead took from it: a session's tools list is fixed for its whole life, and anything new arrives as appended messages. Progressive tool discovery is parked until Sam revisits it, with the options recorded in a decision. Read `AGENTS.md` and the docs it lists, then this brief.

## The piece

- Remove `available` and `ctx.addTools` (`add_tools` in Python and Rust) from the spec, all three cores, the conformance format and its scenarios 47 to 50, with nothing left half removed. The duplicate-name rule that predates them stays.
- Write the rule into `docs/spec/plugins.md` in a sentence or two, with its reason, so the next design does not repeat the mistake: a session's tools list is fixed when it opens, since providers bind signed content and caches to it.
- Add a decision entry: what happened, why it was removed, and the options for later (Anthropic's `defer_loading` with inline `tool_addition` blocks under the `inline-tools-2026-09-15` beta, a generic `find_tools` and `call_tool` pair for any provider, skills-style documents for knowledge, or tools that arrive at the next session). Move the decision that added tools that join a session to `docs/decisions-archive.md` if that file exists, or mark it replaced.
- Update `docs/overview.md` to match, including the scenario count.
- Add to `docs/ways-of-working/README.md`, as a suggestion in your write-up rather than an edit, that a change to how a session's context or requests are built gets one live run on the default model, with thinking, through the path it changes.

## Done when

`scripts/check.sh ts python rust` passes, every scenario passes in all three cores, and nothing in the repo mentions `addTools`, `add_tools` or `available` tools except the decision that records why they went.

## Time and setting

Work for at most 60 minutes, and write up what you have when you reach it. Sam is around. Work on the branch `remove-add-tools` in the worktree you were given, commit as you go, and leave merging to the lead. Never print a value from `.env`. Never use em dashes in anything you write.
