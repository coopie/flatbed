# How we write

This is our guidance on writing anything a person or an agent reads to do their work: docs, briefs, code comments, an agent's system prompt and the notes it leaves for its next session. It is what we have agreed works well so far. If you find a better way, or a case where it does not fit, depart from it and say why in your write-up, so the guide can improve.

Whoever reads what you write has your job and none of your memory. Most often it is an agent starting a session, which will act on what you wrote and cannot ask what you meant.

## Context, guidance, instructions, examples

A good doc or prompt tends to run from broad to specific:

```
┌──────────────────────────┐
│         Context          │  how things are, the goal, and why it matters
├──────────────────────────┤
│         Guidance         │  what tends to work, when, and why
├──────────────────────────┤
│      (Instructions)      │  steps to carry out, with their reasons
├──────────────────────────┤
│        (Examples)        │  cases that show what good looks like
└──────────────────────────┘
```

- **Context** is how things are: what the project is, how a system works, what has been decided. Present-tense fact suits it: "The shop's search reads from an index that rebuilds every night."
- **Guidance** is what tends to work well, when, and why: "When a client email asks several things, answering each under its own short heading has made replies easier to check." The reader weighs it against the case in front of them.
- **Instructions** are steps to carry out: "Rebuild the search index after you rename a product, because until then search shows the old name." They are worth writing where the steps are fixed, or where a rule such as a contract, a regulation or how personal data is handled leaves nothing to weigh.
- **Examples** are concrete cases, for when the other three do not show what good looks like.

If you are unsure whether something is guidance or an instruction, ask whether a good reader could reasonably decide not to do it in some case. If they could, writing it as guidance leaves them that judgement.

Most documents mix these. A release doc might open with a paragraph of context, give some guidance on when to release, then list the steps. Wording each part as its own kind lets the reader tell which sentences to weigh and which to carry out.

Advice written as if it were context is the easiest mix-up to miss. "Tests are kept few" reads like a description of the codebase, so the reader cannot tell whether it is a rule or an opinion, and has nothing to weigh. "A few tests at the boundary have caught most of our bugs, and a wall of them makes each change slower" gives the same advice with its evidence.

## Give the reason

Guidance and instructions that come with a reason have been followed far more sensibly than bare instructions. The reason can be motivation, what the thing is for and why it matters, or evidence, what happened when we did it. A reader who knows the reason can tell when it applies. A bare instruction tends to get followed where it was never meant to, or dropped where it mattered.

Writing about people works the same way. "The client tends to prefer short emails, of three or four lines" gives the reader a tendency to work with, and room for the exception. "Always" and "never" are worth keeping for what really is absolute, such as a legal constraint. Where the environment can enforce a rule, through permissions, a sandbox or an automated check, it tends to hold up better than the sentence alone, and the doc can explain why the rule exists.

## Where detail helps

Starting with the concepts, what the thing is, what it is for and what matters most, helps a reader handle cases nobody foresaw. Detail is most useful where the concepts alone would leave them guessing: a trade-off you chose on purpose, a case where a reader went wrong before, or a contract such as a path, a command or a format. When you find yourself writing many step-by-step instructions, the steps may belong in a script or the code, with the doc explaining why.

Examples help where the concepts do not show what good looks like, such as a tone of voice or an output format. Invented ones, with names that belong to nobody, are safer, because an example that looks like real data tends to get copied into output or taken as fact.

## Tone

Write-ups that named what went well, as well as what went wrong, have led to better next briefs. Reviews that opened with what was good have had their fixes taken up more readily. Models pick up the tone of what they read, and docs written as lists of warnings have tended to produce cautious, hedged work. On the whole, work has gone better when it feels like it is moving forward.

## Structure

Readers often stop early, so it helps to put the most important thing first at every level: a folder's top doc, a doc's opening lines, a section's first sentence.

A fact that lives in one doc, the one it is most about, with links from everywhere else, stays true longer. Two copies tend to drift apart.

A doc that mentions only files, commands and docs that exist is one a reader can trust. When you mention one, it is worth checking it is real, because a reader who follows a dead pointer starts doubting the rest of the page.

Models read established syntax more reliably than markers you invent. We use Markdown for docs, and XML tags named for what they hold, such as `<email>` or `<reminder>`, for prompts and rendered context.

## Sentences

The [GOV.UK style guide](https://www.gov.uk/guidance/style-guide/a-to-z) is a good model: short sentences with one idea each, plain words, the active voice, and headings that say what is under them. Models share a few habits that make text harder to act on, which are worth looking for when you reread: words that describe nothing, such as robust and seamless; set-up-and-reveal sentences, such as "it's not X, it's Y"; slogans in place of reasons; throat-clearing and closing morals; one sentence carrying three ideas; and bold and bullets where reasoning belongs.

## Changing a doc

When a doc needs to change, it helps to reread the whole of it and ask how you would write it now, knowing what you know. Merge sections that cover the same ground, take out what is no longer true, and write that. Docs that grow by appended rules tend to become lists of patches that contradict each other.

Before, after five requirements were added one at a time:

```
You are a helpful assistant.
Be polite.
NEVER USE PROFANITY.
Also remember to be concise.
New requirement: validate order numbers.
Another requirement: handle errors gracefully.
```

After, rewritten as a whole:

```
You help customers of a small online bookshop with their orders. Write
politely and briefly, as a good shop assistant would.

When a message includes an order number, check that the order exists
before you act on it. When something fails, tell the customer what
happened and what they can do next.
```
