# Brief: opening calls, and startup.json in the docs plugin

Parker, the agent Sam talks to on Telegram (github.com/coopie/parker), is moving from pinned documents and a read-only `rules/` folder to a `startup.json` document that decides what each session opens with. It is a pattern Sam has used in his contracting work. Two parts of flatbed need to change for it, and both are general enough to belong here rather than in Parker. Read `AGENTS.md` and the docs it lists, then this brief. The decision as Parker records it is "startup.json decides what a session opens with", in Parker's `docs/decisions.md`; read it at `~/Documents/Programming/parker/docs/decisions.md`.

## The piece

**1. Opening calls, in the core.** A plugin's `context` hook may return tool calls as well as sections and tools. When a session opens, after the context entry and the start notice, the loop appends one assistant message holding every plugin's opening calls in plugin order, runs them as it runs any turn's calls, through `beforeTool` and `afterTool`, and appends their results. The model then sees, as its first exchange, calls it seems to have made and their real results. That is the point: what a read returns arrives as material in the conversation, not as instructions in the system prompt. Decide how the spec marks that assistant message as the harness's own, with no model call behind it, and how its usage counts towards the budget. Change the spec, all three cores and the conformance suite together, with scenarios for the behaviour a reader would notice.

The risk is the provider. On 20 October a change to how requests were built passed every scenario and broke every Opus call that followed. Before you build the three cores, check with one live call on `claude-opus-5-5` with thinking on that Anthropic accepts a conversation whose first assistant turn is tool calls with no thinking block, followed by their results and an event. If it does not, find the nearest shape that works, such as results delivered in a user message as material, and say what you chose in your write-up.

**2. startup.json, in the docs plugin.** A host may give the docs plugin a `startup` option holding the fixed entries, kept in code. The `startup.json` document is a list of entries, each a tool call with `system` and `fixed` flags:

- `system` entries come first, and each reads one document. Together they become sections, in order, and the last carries the cache mark. Once the `system` entries end, no later entry may be `system`.
- Every other entry becomes an opening call.
- A write to `startup.json`, through `write_doc` or `edit_doc`, is checked as a whole as it lands, in the spirit of "edit a document, then commit" in Parker's `docs/ways-of-working/agent-tools.md`. It is refused with every problem at once if it does not parse, breaks the `system` order, names a tool the agent does not have, or drops, changes or reorders a fixed entry from the host's list.
- A document read by a fixed entry is read-only to the agent, with a refusal that says why.
- With `startup` given, the plugin offers no `pin_doc`, and pinning plays no part. Without it, the plugin behaves as it does today, so the example app keeps working.

The guide text, the folders section and the timeline stay where they are. Update the plugin's README so a host can set it up from that alone.

## Done when

`scripts/check.sh` passes, the new scenarios pass in all three cores, the docs plugin's tests cover the commit check and fixed entries, and one live run on `claude-opus-5-5` with thinking on goes through a session that opens with a read as an opening call and then answers a message. Add a decision entry and bring `docs/overview.md` up to date.

## Time and setting

Work for at most 150 minutes, and write up what you have when you reach it, at the bottom of this brief. If the three cores do not all fit, finish TypeScript and the docs plugin first, since Parker needs those, and say what is left. Questions go to the lead, in a `## Question for the lead` section here, carrying on with your best guess. Work on the branch `opening-calls` in the worktree `~/Documents/Programming/flatbed-wt/opening-calls`, commit as you go, and leave merging to the lead. For live runs, symlink `.env` from `~/Documents/Programming/flatbed/.env` into the worktree; never print or log a value from it. Never use em dashes in anything you write.
