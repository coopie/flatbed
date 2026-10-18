# Design

How the example app looks, and why. It follows the aiding.agency site, which Sam chose on 6 October 2026, so flatbed reads as the agency's work. These are the rules for anything visual in the app.

## The look

- **Black and white.** The only colour is the stepped pixel rainbow, as a 6-pixel strip at the top and bottom of every page. State, such as a proposal waiting or a check failed, is shown with words and weight.
- **Square corners everywhere.** No border radius and no shadows.
- **A monospace grid.** Body text, labels, buttons and links are in Geist Mono. Lists of things, such as sessions, documents and proposals, sit in a grid of boxes that share one-pixel borders.
- **Times New Roman for headlines**, with tight letter spacing (`-0.02em`), and Tinos as the fallback.
- **Light and dark.** Both follow the system setting, and the header has a toggle that remembers the choice. Every colour is a token.
- **Links in square brackets**, like `[sessions]`, and the pixel pointing hand as the cursor on links.

## Tokens

The tokens come from `../aiding.agency/src/styles/global.css`, in the Programming folder on Sam's machine. Copying them from there keeps the two sites matching, since retyped values tend to drift: `--bg`, `--fg`, `--muted`, `--line`, `--soft`, `--display`, `--mono`, `--track`, `--gutter`, `--max`, `--hand`, and the classes `.label`, `.display`, `.rainbow`, `.btn`, `.bracket` and `.grid`. Fonts come from `@fontsource/geist-mono` and `@fontsource/tinos`.

## Voice

Plain and short, as in [writing.md](ways-of-working/writing.md). The app explains what the agent is doing and why, in the tone of a colleague describing their work.
