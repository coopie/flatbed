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
