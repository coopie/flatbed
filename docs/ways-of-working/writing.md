# How we write

Read this before you write a doc, a prompt, a brief or a code comment. It applies to anything an agent or a person reads to do their work: the docs in a repo, the system prompt of an agent, and the notes an agent keeps for its next session.

Write for a reader who has your job and none of your memory. Most often that reader is an agent starting a session. It reads what you wrote and then acts on it, and it cannot ask you what you meant.

## Write as high level as the reader can act on

The most useful thing you can give a reader is the high-level picture: what this is, what it is for, what matters most and why. A reader who holds that picture can handle cases you did not foresee. A reader given only steps stops at the first case the steps miss. If every step could be listed, we would write code instead.

So write at the highest level the reader can act on, and go lower only when you have a reason to:

- the right move does not follow from the goal, such as a trade-off we chose on purpose
- a reader has shown they need it, because an agent got it wrong with the high-level guidance alone
- the detail is a contract, such as a path, a command or a format that something else depends on

When you are about to add something low level, look for a higher-level sentence that covers it and the next case too. Keep the detail itself in the code, or in the one doc that owns it, and link to it.

## Context, then guidance, then examples

Order a doc or a prompt from broad to specific.

1. **Context**: the system the reader works in, the goal, and why it matters.
2. **Guidance**: what the goal alone does not tell them, such as priorities, trade-offs and the cases worth naming.
3. **Examples**: a few concrete cases that show the guidance at work.

Keep step-by-step instructions to a minimum. An example teaches the shape of good work. A list of steps teaches only those steps.

Invent your examples. An example that resembles real data, such as a real customer or a real email, gets copied into output or mistaken for a fact. Use names that belong to nobody.

## Write guidance to the reader

Write as documentation addressed to the reader, in the second person. Say what to do, then why.

- "Run the full check before you ask for a review" tells the reader what to do. "The full check is the gate before review" states a fact the reader may take as already done.
- "When a customer asks about price, hand over to a person" tells an agent what to do. "I hand pricing questions over" describes a character the agent may or may not play.

Use the imperative for what to do, the present tense for how things are, and "when X, do Y" for conditions. Give the reason after the instruction: a reader who knows why can tell when it no longer applies.

Describe people and their preferences as tendencies, with the evidence: "The client tends to prefer short emails, of three or four lines." Keep "always" and "never" for things that really are absolute.

## Sentences

Follow the [GOV.UK style guide](https://www.gov.uk/guidance/style-guide/a-to-z). In short:

- Lead with what the reader needs to know or do.
- Write short sentences, one idea each, in the active voice. Say who does what.
- Use plain words, and explain a term the first time you use it.
- Write headings that say what is under them, so a reader scanning them finds their section.
- Say what to do rather than what to avoid.
- Show what matters by putting it first, rather than with capitals or bold.

## Structure

Put the most important thing first at every level: a folder's top doc, a doc's opening lines, a section's first sentence, a line's first words. A reader should be able to stop early and still have what they need.

Write each fact once, in the doc it is most about, and link to it from anywhere else that needs it. Two copies drift apart.

Use an established syntax for structure. Use Markdown in docs. In prompts and rendered context, wrap things in XML tags named for what they hold, such as `<email>` or `<reminder>`, rather than inventing a marker. Models read a common form more reliably than a clever one.

## Change a doc by rewriting it

When a doc needs to change, reread the whole of it and ask how you would write it now, knowing everything you know. Merge sections that cover the same ground, take out what is no longer true, and write that. Add a new section only when the content is new and separate. A doc that grows by appended rules turns into a list of patches that contradict each other.

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

## Habits worth trading for better ones

Writers share a few habits, and models share them most of all. Each has a better move.

- **Stating a fact where guidance belongs.** Say what to do.
- **Words that describe nothing**, such as robust, comprehensive, seamless and powerful. Say what the thing does, or which command you ran and what it printed.
- **Throat-clearing and morals**, such as "There are three things worth knowing" or a closing line that sums up. State the thing and stop.
- **One sentence carrying three ideas**, joined by semicolons and dashes. Write three sentences.
- **Bold and bullets everywhere.** Use a list for items that sit side by side, and prose for reasoning.
- **A new rule for each new case.** Rewrite the section so one idea covers them.

Add a habit to this list only once you have seen readers fall into it.
