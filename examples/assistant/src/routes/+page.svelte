<script lang="ts">
  import { enhance } from '$app/forms';
  let { data } = $props();
  let text = $state('');
</script>

<svelte:head><title>Chat · Assistant</title></svelte:head>

<h1 class="display">Chat</h1>
<p class="lede">Ask your assistant for anything to do with your mail and calendar. When it wants to send something, it proposes it on the proposals page.</p>

<ol class="plain chat">
  {#each data.lines as line (line.id + line.text)}
    <li class={line.who}>
      {#if line.who === 'note'}<span class="label">{line.text}</span>{:else}<pre>{line.text}</pre>{/if}
    </li>
  {:else}
    <li class="note"><span class="label">Nothing yet in this session.</span></li>
  {/each}
</ol>

<form method="POST" use:enhance={() => async ({ update }) => { text = ''; await update(); }} class="send">
  <textarea name="text" rows="3" bind:value={text} placeholder="Write to your assistant" aria-label="Message"></textarea>
  <div class="row">
    <button class="btn">Send</button>
    {#if data.suggestion}
      <button type="button" class="bracket label" onclick={() => (text = data.suggestion ?? '')}>use the demo message</button>
    {/if}
  </div>
</form>

<style>
  .chat { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; max-width: 72ch; }
  .person { align-self: flex-end; background: var(--soft); padding: 10px 14px; border: 1px solid var(--line); max-width: 90%; }
  .agent { padding: 10px 14px; border-left: 2px solid var(--fg); max-width: 90%; }
  .note { padding-left: 16px; }
  .send { max-width: 72ch; display: grid; gap: 8px; }
</style>
