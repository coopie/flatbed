# Ways of working

Agents working here start with only the repo: the code and its docs. The aim is for that to be enough for any fresh agent to build and review work well, with no extra context from a person or from another agent. When that holds, the team can trust the system, run more work at once and move quickly.

Every agent shares that aim, whatever its role. When you learn something a fresh agent would need, such as a correction, a preference or the reason behind a choice, put it in the right doc before your session ends, because nobody after you can see your conversation.

Most changes here are made by coding agents in three roles. Builders do a piece of work from a brief. Reviewers check a finished piece and fix what they can. The lead, Sam or an agent he delegates to, sets the work, does a final review, and looks for ways to improve the process. [leading.md](leading.md) is the lead's side of it.

This page is our agreed guidance on how a piece of work runs. It is mostly guidance, with a few instructions where other things depend on them. If you find a better way, or a case where it does not fit, depart from it and say why in your write-up, so the lead can improve the page.

## How we build

flatbed is meant to be read as an example of how to build an agent, so its size is the point. A reader who can hold the whole core in their head can see how a product is built on it, and every feature added to the core makes that harder. Features that only some agents need have stayed out of the core as plugins, and the core has never had to know which plugins exist.

The spec in `docs/spec/` is the contract between the three implementations, and they stay in step through the conformance suite, without reading each other's code. When an implementation needs behaviour the spec does not describe, changing the spec and the suite in the same change, and saying so in the write-up, has kept the three alike. Comparisons that found them drifting, such as the one on 18 October, found it where the suite could not see.

Adding an abstraction once a second use appears has kept the code easier to change than adding it up front. An interface with one implementation, a setting nobody asked for, or a module holding one function is something every later change has to work around.

We lean gently towards small, well-scoped functions that compose, working on data that does not change, because they have been the easiest to read, test and reuse. Mutation tends to be worth it where it makes the code much simpler, or where performance needs it. Objects help when some state and the behaviour around it belong together and functions alone get awkward. When two callers need different behaviour, passing the difference in as a value or a function has kept code simpler than adding a flag.

The care worth putting into code grows with how central it is. The core is finished work: named well, handling the errors that can happen, and asserting where a case cannot happen. A one-off script can be rough, and saying so at its top lets the next reader judge it. Types have paid off on what is ours and worth holding, such as entries and messages, while data passing through, such as a tool's input, can stay plain data once it has been checked where it enters.

When a piece grows, rethinking it as a whole tends to keep it coherent, for the same reasons the writing guide gives for docs.

A few tests of the behaviour a person would notice, at the boundary of a component, have caught most of what mattered. Here that boundary is mostly the conformance suite: one scenario showing that a reset carries over correctly tells the next reader more than ten unit tests on helpers. Agents tend to write too many tests, and a wall of them makes the next change expensive.

## Tooling

Three kinds of tooling have been worth setting up early, because every later piece leans on them. flatbed has all three, and `AGENTS.md` lists them.

- **One command that runs every check**, `scripts/check.sh`. Running it before you hand work back catches problems while they are cheap to fix.
- **A way to see the work.** Each CLI's `view` command, and the example app's sessions page, show a session as the model saw it. For work judged by eye or feel, such as a layout or a prompt's output, a quick way to compare the result with the goal has saved many rounds of polishing the wrong thing.
- **Scripts for repeated steps**, in `scripts/`, once the same steps come up a second time.

## Starting a piece of work

Most pieces start from a brief, a short doc that sets out the piece, with a time limit. Briefs live in `docs/kickoffs/`, one file per piece. When the limit comes, stop and write up what you have, because a partial result with a clear write-up is easy to pick up. Each piece has gone most smoothly on its own branch, in its own worktree, merged after the final review. Small asks made directly in a conversation, such as fixing one bug, can skip the brief: do the work, run the checks, and put the write-up in your reply. The write-up still matters there, because How it went is how the docs improve.

Most ambiguity is yours to decide: pick the reading the docs support best, and note it in the write-up. Two kinds are worth raising with the lead once you have looked at the task. If a choice could reasonably go the other way and would be costly to redo, a short heads-up, such as "I'm reading it as X and carrying on", lets the lead step in without needing to reply. If the task looks wrong, or a wrong guess would waste most of the work, ask, and keep working on what the answer does not affect. A lead running several agents has found one message covering everything easier to handle than a stream of them. If the piece turns out too big for one agent, say so, and the lead can split it.

If you can message the lead directly, or a person is in the conversation, ask there. Otherwise, add a `## Question for the lead` section to the brief with the question and your best guess, and carry on with the guess, so the work does not stall. If a wrong guess would waste most of the work, stop and write up what you have, with the question at the top.

Anything you notice outside the brief goes in the write-up as a suggestion, so the lead can decide whether it becomes a piece of its own.

## Docs

Docs are how one session hands its understanding to the next. You can create one whenever the work needs it. Linking each new doc from `AGENTS.md`, with when to read it, is how the next session finds it. Each fact lives in one doc, and everything else links to it. flatbed has these, in the places shown:

- **The overview**, in `docs/overview.md`: what we are building, why, how the parts fit together, and where we are.
- **Decisions**, in `docs/decisions.md`: choices that outlive the piece they came from and constrain later work. A short entry with the date, what was chosen, why, and what it rules out lets the next session skim them before making a choice of its own.
- **The stack**, in `docs/stack.md`: what flatbed is built with, how to check and run it, and tips that would have saved an earlier session time.
- **The spec**, in `docs/spec/`: the rules every implementation follows. It is the one place for low-level detail such as field names, because three implementations must agree on it.
- **Design notes** for a part that needs them, such as `docs/design.md` for the example app's look and `docs/codemode.md` for codemode.
- **A README beside each plugin or library**, saying how it works.

Step-by-step detail tends to live best in the code and its comments, next to what it describes.

Docs that describe how things are now, such as the overview and the stack, are worth rewriting in the part that changed, so the next reader does not act on old facts. Decisions are a history, so new entries go at the bottom. This page and the writing guide are agreements the team shares, so put changes to them in your write-up as suggestions for the lead.

## Finishing a piece of work

Run `scripts/check.sh` and fix what it finds. Then write up the piece at the bottom of its brief, or in your reply if there is no brief, in about 300 words, so the reviewer and the lead can take it in quickly:

- what changed and why
- the choices someone could have made differently
- how you know it works, such as the commands you ran and what they printed
- what is left

End with **How it went**: what went well, what slowed you down, and where the docs or the spec were wrong, missing or misleading. The lead uses it to decide what to improve next, so the more specific it is, the more useful.

## Reviewing a piece of work

Anything larger than a small change, such as a one-file fix with an obvious test, gets a review from a fresh agent before the lead's final look. The reviewer is fresh so that it judges the work only by what the repo holds. When reviewers keep the codebase in good shape from the repo alone, the team can trust them, and the lead can spend less time on each change.

As the reviewer, you have the brief, the change and the repo. Read the change against the brief and the docs, and ask whether it leaves the codebase in a good place. Fix what you are confident about directly, so the work moves on without another round. Flag what you are unsure of.

Add your review below the builder's write-up: what you changed, what you flagged, and where the docs did not give you enough to judge. That last part shows where knowledge has not reached the repo yet, which makes it the most useful part for the lead.
