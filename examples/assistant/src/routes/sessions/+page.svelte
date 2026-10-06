<script lang="ts">
  let { data } = $props();
</script>

<svelte:head><title>Sessions · Assistant</title></svelte:head>

<h1 class="display">Sessions</h1>
<p class="lede">Each stretch of your assistant's work, from opening to reset, exactly as the model saw it. Open one when its behaviour surprises you.</p>

<div class="grid list">
  {#each data.sessions as s (s.id)}
    <a class="box item" href="/sessions/{s.id}">
      <span class="strong">{new Date(s.createdAt).toLocaleString('en-GB')}</span>
      <span class="label">{s.id} · {s.entries} entries · {s.ended}</span>
      {#if s.opening}<span class="muted">{s.opening}</span>{/if}
    </a>
  {:else}
    <p class="box muted">No sessions yet. Send a message in the chat to start one.</p>
  {/each}
</div>

<style>
  .list { grid-template-columns: 1fr; }
  .item { display: flex; flex-direction: column; gap: 2px; text-decoration: none; }
  .item:hover { background: var(--soft); }
</style>
