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
