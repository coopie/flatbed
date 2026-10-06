<script lang="ts">
  let { data } = $props();
  const long = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
</script>

<svelte:head><title>Timeline · Assistant</title></svelte:head>

<h1 class="display">Timeline</h1>
<p class="lede">One document a day, which your assistant keeps. It sees today in full and one line for each of the six days before.</p>

<div class="grid days">
  {#each data.days as day (day.name)}
    <article class="box">
      <h2 class="display">{long(day.day)}</h2>
      <p class="muted">{day.summary}</p>
      <pre>{day.body}</pre>
      <a class="bracket label" href="/docs/{day.name}">history</a>
    </article>
  {:else}
    <p class="box muted">Nothing on the timeline yet.</p>
  {/each}
</div>

<style>
  .days { grid-template-columns: 1fr; }
</style>
