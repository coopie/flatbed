# Kickoff: the Holmes template, a lost case half told

You are writing the playground's first template: an original Sherlock Holmes case in Doyle's manner, about half finished, which a visitor helps Holmes complete. It is content, not code. Read `AGENTS.md`, `docs/playground.md` (its Holmes section sets the folders and what each is for), `docs/kickoffs/_template-format.md` (the format to write in), `ts/packages/supervisor/README.md` and `spec.schema.json`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Context

The template shows three things to someone trying an agent for the first time: an agent keeping documents as its memory, folders with different permissions, and a supervisor that checks work before it lands. The Holmes case makes those vivid. Holmes's notebook is his to scribble in; Watson's casebook is public and reviewed, so a suspicion that is not yet proven, a spoiler, or a clue the reader has not been shown gets refused there; the solution is sealed until the visitor asks for the reveal. Lestrade's file is official, confident and partly wrong, which gives the visitor something to catch.

## Guidance

- **Original, not Doyle's text.** Holmes and Watson are in the public domain; the case, its people and its prose are yours. Echo Doyle's voice without quoting him.
- **A fair puzzle.** A sealed solution that the evidence supports, with a few true clues already found, two or three still to find through questions the visitor might ask, one red herring, and at least one place where Lestrade's file contradicts the evidence. Write down for yourself, in the solution, which clue proves what.
- **Half told.** The casebook holds the opening chapters up to the point where Holmes says he has a suspicion he will not yet name. The notebook holds his working so far. The visitor should be able to make real progress in ten minutes and reach the reveal in fifteen.
- **The casebook's supervisor spec** checks what a reader would need: no accusation the casebook has not earned, nothing from the sealed solution, every clue mentioned already shown to the reader, and the period voice kept. Write its preamble so the supervisor understands what is at stake for a reader of a detective story.
- **`role.md`** describes the situation to the agent, who plays Holmes with Watson's pen, and what has worked: thinking in the notebook, writing up for readers in the casebook, asking the visitor what they would like to investigate.
- **The look:** a Baker Street casebook, in the token format given.
- Keep the seed within the token budget in the format doc.

## Done when

The template folder is complete in `examples/playground/templates/holmes/`, valid against the format and the supervisor schema (`node -e` with the supervisor's `parseSpec` is enough to check the spec), and you have read it through once as a visitor would and fixed what did not hold up.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Never use em dashes in anything you write, including the story.

## Write-up

**What changed.** `examples/playground/templates/holmes/` holds the whole template: `template.json`, `role.md`, `look.css`, `specs/casebook.json` and eleven seed documents. The case is the murder of Silas Garrow, a Rotherhithe moneylender, in November 1895. Lestrade has arrested the clerk, Peter Hale. The chandler downstairs, Jonas Pell, did it. Two casebook chapters run up to Holmes's unnamed suspicion. The clues already found are the torn ledger with the money left lying, tallow by the body, a carried light at 10.20 and the street door bell. Three are still to find: what the attic lodger heard, the oiled back stair with tallow on the step, and Garrow's day book showing Pell's £200 debt. Captain Lisle is the red herring. Lestrade's file is wrong in five places, and two of them (Hale's debt is on the H leaf, which is whole; the drops are tallow, not wax) can be caught on the first turn. `solution/what-happened.md` says which clue proves what.

**Choices.** The agent cannot read sealed documents, so the clues still to find live in `evidence/` as documents whose summary begins "Not yet found", and `role.md` asks the agent to bring each one out only when the visitor's questions lead there. A visitor who opens `evidence/` can spoil the case for themselves, which is how printed puzzle books work too. This stretches `docs/playground.md`'s "physical facts" a little. The notebook does not name Pell, because visitors can read it. The spec's spoiler item works whether or not the supervisor can see `solution/`. I added a fifth item, `true_to_the_facts`, as a block, because a story that contradicts itself breaks the puzzle as surely as a spoiler does.

**How I know it works.** `parseSpec` accepts the spec (5 items). `grep` finds no em dashes. Every seed's second line is an italic summary. The seeds come to 21,209 characters, about 5,300 tokens, or about 4,400 without the sealed solution. I read the template through once as a visitor, checking that each suspect is ruled in or out by a found clue, and tightened how the solution describes the blow.

**What is left.** Nothing has run with a real model yet. The first recorded example project will show whether Haiku keeps to "Not yet found" and whether the spec refuses too often.

**How it went.** The format doc and playground design were enough to work from. The one gap was where the clues still to find should live when the agent cannot read sealed folders. It may be worth a line in `docs/playground.md`.
