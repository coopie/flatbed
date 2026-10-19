<script lang="ts">
  import type { Project } from '../lib/project.svelte.ts';
  import { folderOf } from '../lib/template.ts';

  let { project, name, base }: { project: Project; name: string; base: string } = $props();
  const folder = $derived(folderOf(project.template.folders, name));
  const hidden = $derived(folder?.mode === 'sealed' && !project.unsealed.includes(folder.path));
  // Read again whenever the document list changes, so a write shows at once.
  const versions = $derived(project.docs && project.history(name));
</script>

{#if hidden}
  <p class="box">This document is in a sealed folder. <a href={base}>Reveal the folder</a> from the project page to read it.</p>
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
        <pre class="body">{doc.body}</pre>
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
  .body { font-family: var(--t-body); line-height: 1.6; border-top: 1px solid var(--t-line); border-bottom: 1px solid var(--t-line); padding-block: 16px; }
  .versions { grid-template-columns: 1fr; font-size: 0.85rem; }
  .versions pre { margin-top: 8px; }
</style>
