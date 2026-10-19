// The chat's Markdown renderer: what a reply looks like, and that nothing in a reply becomes markup.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown } from './markdown.ts';

test('a reply renders paragraphs, lists, emphasis, code and links', () => {
  const html = markdown('**Lestrade** is *wrong* about `the door`.\n\n- the attic\n- the stair\n\n1. one\n2. two\n\nSee [the site](https://example.com/a_b_c).');
  assert.equal(
    html,
    '<p><strong>Lestrade</strong> is <em>wrong</em> about <code>the door</code>.</p>\n' +
      '<ul><li>the attic</li><li>the stair</li></ul>\n<ol><li>one</li><li>two</li></ol>\n' +
      '<p>See <a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer">the site</a>.</p>',
  );
});

test('raw HTML and unsafe links stay as text', () => {
  const html = markdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://e.com/"onmouseover="x)');
  assert.doesNotMatch(html, /<img|<script|href="javascript/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /href="[^"]*"onmouseover/);
});
