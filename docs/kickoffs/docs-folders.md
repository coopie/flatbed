# Kickoff: folders with permissions in the docs plugin, and browser-safe packages

The playground (`docs/playground.md`) gives each agent folders with different permissions, and runs flatbed in the browser. Two pieces of that belong in the packages rather than the app, because any agent can use them: folder modes in `@flatbed/docs`, and package entry points that load in a browser. Read `AGENTS.md`, `docs/playground.md`, `docs/kickoffs/_template-format.md`, `ts/packages/docs`, `ts/packages/supervisor` and `ts/packages/core`, and then this brief. When you are done, add your write-up at the bottom of this file.

## Folder modes

The docs plugin takes folders, each with a mode, as `docs/playground.md` describes. `read` refuses writes from the agent's tools, with a result that says why. `write` is today's behaviour. `sealed` folders are absent from the agent's listing and reading, and the host can unseal one, after which the agent sees it from its next session. Documents outside any declared folder behave as today, so existing users are unaffected. The plugin's guide section tells the agent which folders exist, their modes, and what each is for (`about`).

`reviewed` is where the docs plugin meets the supervisor. One way that has kept the packages independent: the supervisor guard learns to pick a spec by a predicate on the call, for example a write whose `name` starts with `casebook/`, so the docs plugin needs no knowledge of the supervisor. In `enforce` mode a failed check refuses the write with the failed items, and the agent can redraft. Choose the shape that reads best, and say why in the write-up.

## Browser-safe entry points

`@flatbed/core` and `@flatbed/docs` import `node:fs` at their top level, through the file stores and `env.ts`, so bundling them for a browser fails. Make each package's main entry free of Node-only imports, with the file stores and env reading on their own subpath, such as `@flatbed/core/node`, and update every importer in the repo. A unit test that imports the main entries with Node modules unavailable, or a bundling check with a browser target, shows it holds.

## Done when

`scripts/check.sh ts` passes, with tests for each mode, unsealing, and a reviewed write that is refused and then accepted after a redraft, and the docs and supervisor READMEs explain folders.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Sam is around today; for a choice that would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Another builder is making the playground app at the same time and will use what you make; keep the public APIs small and say what they are in your write-up. Never print a value from `.env`. Never use em dashes in anything you write.

## Write-up
