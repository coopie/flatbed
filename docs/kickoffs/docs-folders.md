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

Done, on `docs-folders`. `scripts/check.sh ts` passes. The assistant app's typecheck passes. Its tests fail here before and after this work, because the Postgres host in `DATABASE_URL` answers "tenant/user not found".

### Folder modes

`docsPlugin` takes `folders`: a list of `{ path, mode, about? }`, or a function from the session to that list. A document belongs to the folder with the longest path that starts its name. A document outside every folder works as before, and with no folders the context is byte for byte the same.

- `read`: `write_doc`, `edit_doc` and `pin_doc` are refused with the reason and the folders the agent can write in. I refused pins too, since a pin is a write the host did not make.
- `sealed`: left out of `list_docs`, refused by `read_doc` and every write, and its pinned documents stay out of the context. The `folders` section still lists sealed folders with their `about`, so the agent knows something is there and does not invent it. The refusal says the folder is sealed rather than "not found", to match.
- `reviewed`: the plugin treats it as `write`. The check belongs to the host.
- A `folders` section follows the guide, explaining only the modes in use.

To unseal, the host's function returns another mode for the folder. The plugin reads folders when it builds a session's tools, so the change shows from the next session. One gap: when a later process resumes a session, such as after a page reload, the tools are rebuilt and see the new modes while the context still shows the old ones. I judged that acceptable for now.

### Reviewed writes

The guard's `specs` can now be a function from the call to a spec or undefined. I chose a function over a list of rules because it is one small change, it composes with anything, and it keeps the packages independent. The docs package exports `writeTarget(call)`, the document a `write_doc` or `edit_doc` would write, so the predicate is one line.

From the lead's message: the supervisor had no place for host material, so I added the smallest one. `SuperviseInput.references` and the guard's `references(call, spec)` give `{ name, text }` pieces, rendered escaped as `<reference name="...">` after the session and before the call, in both `singlePass` and `agentPass`. The system prompt gains one sentence about them. The docs package exports `afterWrite(store, call)`, the whole document as the call would leave it, so the supervisor judges the full proposed body. The host adds the documents to check against, such as `solution/` or `sources/` pages. The docs README shows the whole recipe.

### Browser-safe entries

- `@flatbed/core/node`: `fileStore`, `readEnv`. The main entry no longer exports `fileStore`.
- `@flatbed/docs/node`: `fileDocStore`, `exampleSeeds`. They left the main entry.
- `@flatbed/supervisor` read its schema with `node:fs`, which would also break the playground, so it now imports the JSON with an import attribute. `resolveJsonModule` is on in `ts/tsconfig.json`.

No code in the repo imported the moved names through the main entries, so only READMEs changed. `core/browser.test.ts` imports all three main entries with every Node module refused by a resolve hook, and checks that the hook does catch the node entry. I checked that it fails when a `node:` import is added back.

### Public API added

From `@flatbed/docs`: `Folder`, `FolderMode`, `folderOf`, `writeTarget`, `afterWrite`, and `DocsOptions.folders`. From `@flatbed/supervisor`: `Reference`, `GuardOptions.references`, `SuperviseInput.references`, and the function form of `GuardOptions.specs`.
