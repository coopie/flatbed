# Kickoff: fixes to the assistant example from its review

You are fixing what the review of `examples/assistant/` found. The app is a showcase that Sam may deploy for two to four people, so sending twice or letting the wrong person in matters more than polish. Read `AGENTS.md`, the app's README, `docs/kickoffs/assistant-app.md` with its write-up, and then this brief. When you are done, add your write-up at the bottom of this file.

## The findings to fix

1. **A double accept sends twice.** Claim the proposal before sending: an update from `pending` to `sending` that returns the row, bailing out when none comes back; then send and set the final status. Disable the card's buttons while a decision is in flight.
2. **A wake can be lost** between the run loop ending and `running` being cleared in `host.ts`. Make sure an event delivered in that gap is always run.
3. **The pool can deadlock.** Each run holds a connection for its whole length while the run needs others from the same pool. Fix it so a tick for many people cannot starve the runs, for example by a larger pool plus a cap on runs at once below it, and in Google mode tick only people with a Google token. Say in a comment why a long transaction on the pooler is acceptable here, or move the lock to a session-level advisory lock on a dedicated connection if that is simpler.
4. **One person can become another.** Make the person's id from the whole address, or conflict on email and refuse when the stored email differs.
5. **Removing someone from the allow-list must sign them out**: in Google mode, check the allow-list on every request, and expire logins on the server after 30 days.
6. **Check `email_verified`** in the Google sign-in.
7. **Fail closed.** In production, refuse to start in demo mode without an explicit `DEMO=1`, and refuse `/api/tick` without a secret. Compare the secret with `timingSafeEqual`.
8. **Reject CR and LF** in mail header fields when building a message.
9. **README, Google:** for two to four people, keep the consent screen in Testing and add each address as a test user, since `gmail.readonly` is a restricted scope and publishing means Google's verification; tokens then last seven days, and the app asks people to sign in again. Say that the callback URL exists only after the first deploy, so the order is deploy, add the redirect URI, then sign in.
10. **README, demo mode:** say how to get a database for demo mode, such as a local Postgres in Docker, with the matching `DATABASE_URL`.
11. **A denied proposal** lists no field changes in its decision event.

Add a test for 1 and for 2. Do not run tests or anything else against the database in `.env` except the app's own test schema, as the existing tests do.

## Done when

`scripts/check.sh` passes, with the new tests, and the README is true.

## Time and setting

Work for at most 60 minutes. When you reach it, stop and write up what you have.

Sam is asleep and nobody will answer questions: use the Question for the lead section and carry on with your best guess. Work in the worktree you were given, on its branch, and commit as you go; do not merge into `main`. Leave `ts/packages/` alone. The API key in `.env` is revoked; do not look for another, and never print a value from `.env`. Stop any server you start, and do not leave test runs half-finished: a killed run left two connections idle in a transaction last time.

## Write-up
