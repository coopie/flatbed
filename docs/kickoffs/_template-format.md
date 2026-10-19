# The playground's template format (shared by the playground briefs)

A template is a folder at `examples/playground/templates/<id>/`:

- `template.json`:
  ```json
  {
    "id": "holmes",
    "name": "A lost Holmes case",
    "pitch": "One line for the picker card.",
    "folders": [
      { "path": "evidence", "mode": "read", "about": "One line the agent sees about this folder." },
      { "path": "casebook", "mode": "reviewed", "about": "...", "spec": "specs/casebook.json" },
      { "path": "solution", "mode": "sealed", "about": "..." }
    ],
    "opening": "The agent's first message to the visitor.",
    "prompts": ["three", "clickable", "prompts"],
    "ask": null,
    "tools": []
  }
  ```
  `mode` is `read`, `write`, `reviewed` or `sealed`. `ask` is null, or `{ "label": "Company web address", "placeholder": "https://example.com" }` when the template needs one input before it starts; the answer reaches the agent as its first message. `tools` names app-provided tools the template uses, such as `"fetch_page"`.
- `role.md`: the agent's role, pinned as its first context section. Written as guidance to "you", describing the situation and what has worked, with reasons.
- `seed/<folder>/<name>.md`: starting documents. The first line is `# <title>`; the second line is the one-line summary in italics, `_like this_`; the body follows.
- `specs/<name>.json`: supervisor specs, in the format of `ts/packages/supervisor/spec.schema.json`, one for each `reviewed` folder.
- `look.css`: custom properties only (`--t-bg`, `--t-fg`, `--t-accent`, `--t-muted`, `--t-line`, `--t-display`, `--t-body`), with dark values under `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`, and any Google Fonts named in a comment on the first line.

Keep a template's seed documents to about 6,000 tokens in all, since they are re-sent on every model call.
