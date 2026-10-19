<script lang="ts">
  import type { Project } from '../lib/project.svelte.ts';
  import { linkDocs, markdown } from '../lib/markdown.ts';
  import { href } from '../lib/route.svelte.ts';
  import { folderOf } from '../lib/template.ts';

  let { project, name }: { project: Project; name: string } = $props();
  const base = $derived(href(project.example, '/how'));
  // The body as Markdown, with the document names in it linked, so a fact links to its page.
  const rendered = (body: string) => linkDocs(markdown(body), (n) => href(project.example, `/doc/${n}`));
  const folder = $derived(folderOf(project.template.folders, name));
  const hidden = $derived(folder?.mode === 'sealed' && !project.unsealed.includes(folder.path));
  // Read again whenever the document list changes, so a write shows at once.
  const versions = $derived(project.docs && project.history(name));
</script>

{#if hidden}
  <p class="box">This document is in a sealed folder. <a href={base}>Reveal the folder</a> to read it.</p>
{:else}
  {#await versions then list}
    {@const doc = list.at(-1)}
    {#if doc === undefined}
      <p class="box">There is no document named {name}.</p>
    {:else}
      <article class="doc">
        <p class="label">{folder ? `${folder.path}/, ${folder.mode === 'sealed' ? 'revealed' : folder.mode}` : 'outside the folders'}{doc.pinned ? ', pinned' : ''}</p>
        <h2 class="t-display">{doc.name}</h2>
        <p class="muted">{doc.summary}</p>
        <!-- markdown() escapes the body before it adds its own tags, so no HTML from a page or the model reaches this one. -->
        <div class="body md">{@html rendered(doc.body)}</div>
        <h3 class="label">History</h3>
        <ol class="plain grid versions">
          {#each [...list].reverse() as v (v.version)}
            <li class="box">
              <details open={v.version === doc.version && list.length === 1}>
                <summary>Version {v.version}, by {v.writtenBy}, {new Date(v.writtenAt).toLocaleString('en-GB')}</summary>
                <pre>{v.body}</pre>
              </details>
            </li>
          {/each}
        </ol>
      </article>
    {/if}
  {/await}
{/if}

<style>
  .doc { display: grid; gap: 10px; max-width: 80ch; }
  h2 { font-size: 1.8rem; }
  .body { font-family: var(--t-body); line-height: 1.6; border-top: 1px solid var(--t-line); border-bottom: 1px solid var(--t-line); padding-block: 16px; overflow-wrap: anywhere; }
  .body :global(:is(p, ul, ol, blockquote, h4, h5, h6) + :is(p, ul, ol, blockquote, h4, h5, h6)) { margin-top: 0.7em; }
  .body :global(:is(ul, ol)) { padding-left: 1.3em; }
  .body :global(ul) { list-style: disc; }
  .body :global(ol) { list-style: decimal; }
  .body :global(:is(h4, h5, h6)) { font-weight: 600; }
  .body :global(a) { color: var(--t-accent); }
  .versions { grid-template-columns: 1fr; font-size: 0.85rem; }
  .versions pre { margin-top: 8px; }
</style>
