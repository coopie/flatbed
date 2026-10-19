# Brief: tools that join a session

Parker, a personal agent built on flatbed (https://github.com/coopie/parker), lets the agent connect a group of tools when it needs them. Sam's idea is that the tools arrive at once, in the current session, and fall away at the next reset; agents reset often, after writing down what matters, so no tool is needed to take them away again. flatbed fixes a session's tools when it opens, so this needs a small addition to the core. The lead has written it into the spec: `git show HEAD -- docs/spec` shows the change, in the section "Tools that join a session" of `docs/spec/plugins.md` and two lines of `docs/spec/conformance.md`.

## The piece

`available` tools from a plugin's `context` hook, and `ctx.addTools(names)` on a tool's context, in all three cores, TypeScript, Python and Rust, so they stay in step, with conformance scenarios that show:

- an added tool can be called on the next turn, and the provider receives it in that request
- a name that is not available, or a tool already present, is left out
- the added tools are gone in the session after a reset
- a session resumed by a new process finds the code of an added tool

Keep each core's change as small as the spec allows, in that core's existing style.

## Time and setting

Work for at most 90 minutes, and write up what you have when you reach it. Sam is around today. Work on the branch `add-tools` in the worktree you were given, commit as you go, and leave merging to the lead. Never print a value from `.env`. Never use em dashes in anything you write.

## Write-up

**What changed.** All three cores take `available` tools from a plugin's `context` hook and give a tool's context `addTools(names)` (`add_tools` in Python and Rust). Added tools queue for the turn; after the turn's results, the loop appends one `context` entry with the same sections and the tools followed by the added ones, and the rest of the run uses it. On resume, the code for any tool in the latest `context` entry is looked up among both `tools` and `available`. Three scenarios cover the brief: 47 (an added tool is called next turn and the provider gets it; a missing name, a present tool and a repeat are left out; a second call adding nothing writes no entry), 48 (gone after a reset) and 49 (works after a restart).

**Spec changes I made**, beyond the lead's: a `{"restart": {}}` step in conformance.md, since no existing step makes a new process; "joined with `, `" for the `addTools` behaviour; a sentence in plugins.md that available tools share one namespace with session tools, so a clash fails with `Two tools are named <name>.`; and two lines in loop.md, so step 4 no longer says the context is frozen for the whole run without exception, and step iv says where the new `context` entry goes.

**Choices someone could make differently.** The new `context` entry goes before the reset and stop checks, so a turn that adds tools and resets still records them. `addTools` is synchronous, since it only queues. A name clash between an available tool and any other fails the run, rather than one quietly winning. Outside a tool's context, Rust's `add_tools` adds nothing, while TypeScript has no such context and Python's default raises, as `run_tool` does in each.

**How I know it works.** `scripts/check.sh ts`, `python`, `rust` and `playground` all pass, with 49 scenarios `ok` in each language. Breaking the resume lookup in TypeScript made 47 and 49 fail. `scripts/check.sh assistant` passes its type check, but its Postgres tests fail with `tenant/user ... not found`, as they would on main while the Supabase project is paused.

**What is left.** Nothing in the brief. Parker can now return `available` from its toolbelt plugin.

**How it went.** The brief and the lead's spec section were clear enough that the design took minutes, and the three cores' similar shapes made porting quick. The one gap was the restart scenario: the suite had no way to make a new process, so I added the step. The overview still said 46 scenarios, which I updated. A suggestion: conformance.md could say which steps a scenario needs to show "a new process", so the next brief that asks for one does not need a spec change.
