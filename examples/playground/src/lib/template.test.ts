// The template parser against the templates in templates/, so a template that breaks the format fails the checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTemplates } from './template-files.ts';
import { scopeLook } from './template.ts';

test('every template parses, with a spec for each reviewed folder', async () => {
  const templates = await readTemplates();
  assert.ok(templates.length >= 1);
  for (const t of templates) {
    for (const folder of t.folders.filter((f) => f.mode === 'reviewed')) assert.ok(t.specs[folder.path], `${t.id}/${folder.path}`);
    for (const seed of t.seeds) assert.ok(seed.summary !== '' && !seed.summary.startsWith('_'), `${t.id}: ${seed.name} has a summary line`);
    assert.equal(t.prompts.length, 3, t.id);
  }
});

test('a look is scoped to its template, keeping the theme switches on the root', () => {
  const css = '/* Google Fonts: X */\n:root { --t-bg: #fff; }\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) { --t-bg: #000; }\n}\n[data-theme="dark"] { --t-bg: #000; }';
  const scoped = scopeLook(css, 'x');
  assert.match(scoped, /^\s*\[data-template="x"\] \{ --t-bg: #fff; \}/);
  assert.match(scoped, /:root:not\(\[data-theme="light"\]\) \[data-template="x"\] \{/);
  assert.match(scoped, /:root\[data-theme="dark"\] \[data-template="x"\] \{/);
});
