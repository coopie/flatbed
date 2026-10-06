<script lang="ts">
  let { data } = $props();
</script>

<svelte:head><title>Documents · Assistant</title></svelte:head>

<h1 class="display">Documents</h1>
<p class="lede">Your assistant's memory. Pinned documents are in its context at the start of every session; it reads the rest when it needs them. You can read and edit any of them, and every version is kept.</p>

<div class="grid docs">
  {#each data.docs as doc (doc.name)}
    <a class="box doc" href="/docs/{doc.name}">
      <span class="strong">{doc.name}</span>
      <span class="muted">{doc.summary}</span>
      <span class="label">{doc.pinned ? 'Pinned · ' : ''}version {doc.version}, by {doc.writtenBy}</span>
    </a>
  {/each}
</div>

<style>
  .docs { grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
  .doc { display: flex; flex-direction: column; gap: 4px; text-decoration: none; }
  .doc:hover { background: var(--soft); }
</style>
