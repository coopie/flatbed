# Kickoff: bring flatbed's docs in line with Sam's updated starter docs

flatbed's docs (`AGENTS.md`, `docs/ways-of-working/`, `docs/overview.md`, `docs/decisions.md`, `docs/kickoffs/`) were built on 6 October from the first version of Sam's starter docs. Sam has since reworked those docs, and wants this repo to follow the new version. You are working out what should change here and making the change, for Sam to read before it merges. Read `AGENTS.md` and everything it lists, then the new starter docs, then this brief. When you are done, add your write-up at the bottom of this file.

## Context

The new starter docs are the public gist at https://gist.github.com/coopie/c9ca8c4563b2e1e8506a707a508084b8; `gh gist view c9ca8c4563b2e1e8506a707a508084b8 --files` lists them and `gh gist view c9ca8c4563b2e1e8506a707a508084b8 -f <file>` prints one. `../agent-docs-gist/handover.md` explains how they came to be and what Sam agreed along the way; read it for the reasons behind the changes.

What Sam has said about writing for agents since 6 October, which the gist reflects:

- describe and give the evidence for what has worked, and let the reader judge, more than issue instructions; keep imperatives for contracts such as commands, paths and formats
- four kinds of writing, each worded differently: environment (what is true, in the present tense), guidance (addressed to the reader, with reasons, as a default they may depart from if they say why), handbooks (when they are useful, then a mix of the two), and rules (short, with the reason, enforced by the environment where possible)
- no advice dressed as a statement of fact, and no "X, not Y" or "rather than" contrasts: say what a thing is
- explain with high-level concepts first, then fill gaps with lower-level detail
- docs are true the day they are written: no placeholders, and nothing pointing at files or scripts that do not exist

## Guidance

- Change what the new starter docs change, and keep what is flatbed's own: the spec in `docs/spec/` is a contract between three implementations, so its imperative, exact wording stays; the content of decisions and write-ups is history and stays as written.
- Where the gist's structure and this repo's differ, such as which docs exist and where they live, follow the gist unless flatbed has a reason it does not, and say what you kept and why.
- Rewrite sections whole where they need it.

## Done when

The repo's working docs read as the new starter docs would have them, `scripts/check.sh ts` still passes (the docs touch no code), and the write-up lists what changed, what you kept and why, and anything you would like Sam to decide.

## Time and setting

Work for at most 75 minutes; stop and write up what you have when you reach it. Sam will read this branch before it merges. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Other builders are changing code at the same time; touch only docs, and leave `docs/spec/` alone apart from wording outside its contracts.

## Write-up

Written 18 October 2026, after about 35 minutes. Commit `bcdcf9a` holds the change.

**What changed.** `AGENTS.md` now has the gist's start-here shape, with flatbed under *This project*: what it is, each doc with when to read it, and the check and `view` commands. `writing.md` and the new `leading.md` are the gist's files, word for word, so later syncs are a copy. `ways-of-working/README.md` is the gist's page with flatbed's practice folded in as described evidence: the core's size, spec and suite first, care in proportion, and the conformance suite as the test boundary. Its *Stack* and *Testing* detail moved to a new `docs/stack.md`, where the gist puts it. The overview's plan is brought up to 18 October (37 scenarios, OpenAI providers everywhere, alignment, codemode), and its *When you add to it* reads as context. `decisions.md`'s preamble lost a pointer to a `decisions-archive.md` that never existed. `design.md` lost three "not X" contrasts.

**Kept, and why.** The spec, decision entries and write-ups. `codemode.md`, because the codemode builder is writing its protocol section now. `design.md`, `codemode.md` and the walkthrough stay as their own docs; the gist's list is "worth having in most projects", not exhaustive. Plugin READMEs, which sit beside code other builders are changing.

**How I know it works.** `scripts/check.sh ts` ended `== all checks passed`. A small script found no dead links or paths in the edited docs, apart from `leading.md`'s conditional `docs/research/`.

**For Sam to decide.**
- The gist's tone paragraph, still unconfirmed in the handover, is now in flatbed's writing guide too.
- Seventeen finished and merged briefs are still in `docs/kickoffs/` (all but `align-fixes`, `codemode` and this one). `leading.md` says to delete them after merge; `decisions.md` links `core-fixes.md` as "history in git". I left them for the lead.
- The old `flatbed view <session>` command never existed; `stack.md` now gives the three real ones.

**How it went.** Quick, because the gist and handover are clear. Writing the overview's plan meant reading six write-ups to learn what was true; a dated line in the overview after each merge would save that.
