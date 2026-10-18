# Kickoff: close the gaps the alignment review found, in all three cores

The three cores were aligned on 18 October and all pass 37 scenarios, but a read-only review found eight places where they still differ and the suite cannot see it. The lead has settled each in the spec, in commit `7ab4852` (`git show 7ab4852`). You are making the three cores follow it, and giving the suite the scenarios that would have caught each difference. Read `AGENTS.md`, the whole of `docs/spec/`, the three cores, and then this brief. When you are done, add your write-up at the bottom of this file.

## What the review found, and what the spec now says

1. **Appends in the `context` hook.** Rust refuses them with a reason (`Ctx::opening`), as the spec says; TypeScript and Python allow them, which can write a headerless file or a `custom` entry before the `context` entry. A `context` hook that throws now fails the run before anything is written.
2. **Concurrent appends in TypeScript** read the parent before the write finishes, so two tools appending at once both attach to the same entry. Python and Rust hold a lock across the write.
3. **Errors from `onEntry` and `onSessionEnd`** are now ignored. Rust's hooks cannot fail; in TypeScript and Python such an error escapes between a turn's results and leaves them half written.
4. **Concurrent resets** take the reason of the first call in call order, where all three now take the first in time.
5. **A reset and a stop in the same turn:** the reset wins, with no stop notice.
6. **Names:** TypeScript's `run({signal})` with `abort(who)`; `set(who)` and `wait()` on Python's and Rust's `StopSignal` (Rust has `stop` and `stopped`); a stop with no name is by `the host`; provider names and default base URLs as `host.md` lists them.
7. **Providers and stops:** a stop ends a request in flight as well as a backoff wait, with the error `The request was stopped.` Python checks only during the backoff; Rust's racing of each try against the stop is the shape to copy.
8. **Wording:** the three `createAgent` errors read as `host.md` gives them. Python sends an empty `system` list where the others leave it out. Every hook's `ctx` carries `signal`.

## Guidance

- One scenario for each of 1 to 5, extending `docs/spec/conformance.md` as little as you can (a `plugin.context` that appends or throws, an `onEntry` that throws, two `sleep` tools that each append, two concurrent reset calls, a reset with a stop set during its turn). 6 to 8 are unit tests in each language, or a line of reading.
- The review found Python's loop the easiest to read, with comments numbered to match `loop.md`'s steps, and TypeScript's `needsRun` the hardest. Where you touch a loop, those are worth bringing closer together.

## Done when

`scripts/check.sh ts python rust` passes, every scenario prints `ok` in all three, and the spec says exactly what each core does. The `assistant` section needs the Supabase project, which is paused; leave it.

## Time and setting

Work for at most 90 minutes; stop and write up what you have when you reach it. Sam is around today. If a choice would change the shape of the work, add a `## Question for the lead` section with your best guess and carry on. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. The Anthropic key in `.env` works; never print a value from it. Run long commands in the foreground one at a time.

## Write-up

**What changed.** All three cores now follow `7ab4852`. A `context` hook cannot append, and one that throws fails the run, before anything is written, with `The <plugin> plugin failed: ...`. TypeScript appends take turns. In TypeScript and Python, errors from `onEntry` and `onSessionEnd` are ignored. The first reset in call order wins, and a reset wins over a stop set in the same turn. Every hook's `ctx` has `signal`. In Python, `run` takes `signal=` and `set()` with no name means `the host`. Rust's `StopSignal` now has `set`, `wait` and `who`. A provider stop ends a request in flight with `The request was stopped.`, in TypeScript and Python too. The `createAgent` errors match `host.md`. Python leaves out an empty `system`. The TypeScript and Rust loops now carry Python's numbered step comments, and TypeScript's `needsRun` reads like Python's.

**Choices.** Scenarios 38 to 43 add five things to `conformance.md`: `plugin.context` (`append` or `throw`), `onEntry.throw`, and `sleep` and `append` as add-ons to any tool behaviour. Scenario 38 starts from a header-only session, because only a stored header lets the old bug write anything. Scenario 41 appends without sleeping, because with sleeps Node's timers run the two appends one after the other and the race never shows. Before the fix, TypeScript failed all six new scenarios and Python failed five; Python already had the append lock. Rust's hooks cannot fail, so for Rust, `onEntry.throw` does nothing.

**Commands.** `scripts/check.sh ts python rust` passed: `== all checks passed`, and all 43 scenarios print `ok` in each core.

**Left out.** The `assistant` section. Rust has no `set` without a name, so `the host` applies there only as a fallback.

**How it went.** It went smoothly. The spec commit made each point unambiguous. Running new scenarios against the old code (`git show HEAD:...`) was the most useful check, because it found two scenarios that passed without testing anything.
