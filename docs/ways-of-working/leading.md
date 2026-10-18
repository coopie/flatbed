# Leading the work

This page is guidance for the lead: the person, or the agent they delegate to, who sets the work, does the final review, and looks out for ways to improve the process, however big or small. The ways-of-working page describes the work from the side of the builders and reviewers.

## Setting the work

The lead usually starts several agents at once, each with a brief. A brief is a short doc that says what the piece is and why it matters, what good looks like, what to leave alone, how long to work, and who is around to answer questions. Briefs that give the concepts and the reasons, as the writing guide describes, have needed fewer questions back. A time limit on every brief has kept a stuck piece from running on, and a partial write-up still shows what to do next.

Not every harness lets an agent started by the lead start agents of its own. When a piece turns out too big for one agent, it has worked well for the builder to say so, and for the lead to split it.

A brief describes one piece of work. When you find yourself writing general taste into a brief, such as how the team likes errors handled, it belongs in a doc, where every later agent will see it.

When a question arrives, in a message or in a brief's Question for the lead section, writing the answer into the doc it belongs to, or into the brief if it only concerns this piece, and pointing the agent there means the next agent does not need to ask. A heads-up that an agent is carrying on with a reading needs no reply unless you disagree.

## Reviewing

For each piece larger than a small change, start a fresh review agent with a short review brief, saying where the change is, such as its branch, and how long to spend, and nothing else. A lead builds up context over a session, such as corrections and preferences from the person it works with, and much of it is written down nowhere. A reviewer that has none of it shows whether the repo alone is enough. If a note to the reviewer seems needed, that note probably belongs in a doc.

Then do the final review. Read both write-ups and check that the work fits the goal and the direction of the project. Changes that are hard to undo, such as ones touching data people own, security or anything sent to the outside world, have been worth reading closely as well, because a mistake there is expensive or permanent.

When your final review catches something the reviewer missed, it usually points to knowledge you have and the repo does not. Fix the doc as well as the code. As reviews keep matching what you would have said, you can read less closely, and that trust is what lets the team run more work at once.

After the merge, delete the brief, since git keeps it, or move it to `docs/research/` if something cites it. Checking first that no other doc links to it avoids leaving a dead link behind. If the overview keeps a plan, update it.

## Improving the process

Any improvement to the process is worth noticing, however big or small: a tool, a script, a fixture, a doc, or a different way of splitting the work. After each piece, ask: in hindsight, what would have made this work faster or better? When the answer is worth having, building it becomes the next piece.

How it went and the reviewer's notes on missing docs are the main signals. When the same trouble shows up in two write-ups, rewrite the page that should have prevented it, as the writing guide describes for changing a doc. Suggested changes to the writing guide and the ways-of-working pages arrive the same way, in write-ups.

Reading back through recent write-ups every so often shows patterns a single one does not. Git keeps them after the briefs are deleted, so the deleted files in the briefs folder's history are a good place to look.

A new lead should be able to pick up from the repo alone. If a handover would need a conversation, what that conversation would say belongs in the docs.
