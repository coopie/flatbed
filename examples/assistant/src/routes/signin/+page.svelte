<script lang="ts">
  let { data } = $props();
</script>

<svelte:head><title>Sign in · Assistant</title></svelte:head>

<h1 class="display">A personal assistant, on flatbed</h1>
<p class="lede">
  Each person has an agent that keeps its own notes, reads their mail and calendar, and proposes what to send. Nothing goes
  out until the person accepts it.
</p>

{#if data.people.length > 0}
  <p class="label">Demo mode. Choose who to be.</p>
  <form method="POST" class="grid people">
    {#each data.people as person}
      <button name="person" value={person.id} class="box choice">
        <span class="display big">{person.name}</span>
        <span class="muted">{person.about}</span>
      </button>
    {/each}
  </form>
{:else}
  {#if data.refused}<p class="strong">That Google account is not on the list for this app.</p>{/if}
  <p><a class="btn" href="/auth/google">Sign in with Google</a></p>
  <p class="label">Signing in also lets your assistant read your mail and calendar, and send what you accept.</p>
{/if}

<style>
  .people { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 8px; }
  .choice { display: flex; flex-direction: column; gap: 8px; text-align: left; background: var(--bg); color: var(--fg); border: 0; font: inherit; }
  .choice:hover { background: var(--soft); }
  .big { font-size: 1.6rem; }
</style>
