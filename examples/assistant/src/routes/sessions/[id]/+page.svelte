<script lang="ts">
  let { data } = $props();
  const json = (value: unknown) => JSON.stringify(value, null, 2);
</script>

<svelte:head><title>Session {data.header.id} · Assistant</title></svelte:head>

<p class="crumbs"><a class="bracket" href="/sessions">sessions</a></p>
<h1 class="display">Session {data.header.id}</h1>
<p class="lede">
  Opened {new Date(data.header.createdAt).toLocaleString('en-GB')}{data.header.parent ? `, after ${data.header.parent.reason} of ${data.header.parent.session}` : ''}.
  Everything below is the session's log, in order. Entries off the path, after a rewind, are marked; the model never saw them.
</p>

<ol class="plain grid log">
  {#each data.entries as { entry, onPath, rendered } (entry.id)}
    <li class="box" class:off={!onPath}>
      <p class="label">{entry.type}{entry.type === 'message' ? `, ${entry.message.role}` : ''}{entry.type === 'event' ? `, ${entry.kind}` : ''}{entry.type === 'custom' ? `, ${entry.plugin} (the model does not see this)` : ''} · {new Date(entry.at).toLocaleTimeString('en-GB')}{onPath ? '' : ' · off the path'}</p>
      {#if entry.type === 'context'}
        {#each entry.sections as section}
          <details><summary>Section: {section.name}{section.cache ? ' (cache mark)' : ''}</summary><pre>{section.text}</pre></details>
        {/each}
        <details><summary>Tools: {entry.tools.map((t) => t.name).join(', ')}</summary><pre>{json(entry.tools)}</pre></details>
      {:else if entry.type === 'event'}
        <pre>{rendered}</pre>
      {:else if entry.type === 'message'}
        {#if entry.message.role === 'tool'}
          <p class="strong">Result of {entry.message.name}{entry.message.isError ? ', an error' : ''}</p>
          {#each entry.message.content as block}{#if block.type === 'text'}<pre>{block.text}</pre>{/if}{/each}
        {:else}
          {#each entry.message.content as block}
            {#if block.type === 'text'}<pre>{block.text}</pre>
            {:else if block.type === 'toolCall'}<p class="strong">Called {block.name}</p><pre class="muted">{json(block.input)}</pre>
            {:else if block.type === 'thinking'}<details><summary>Thinking</summary><pre>{block.text}</pre></details>{/if}
          {/each}
          {#if entry.message.role === 'assistant'}
            <p class="label">{entry.message.model} · stop {entry.message.stop} · {entry.message.usage.input} in, {entry.message.usage.output} out</p>
          {/if}
        {/if}
      {:else if entry.type === 'reset'}
        <p class="strong">Reset by {entry.by}{entry.reason ? `: ${entry.reason}` : ''}. The next session starts fresh from the documents.</p>
      {:else if entry.type === 'custom'}
        <details><summary>Data</summary><pre>{json(entry.data)}</pre></details>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .crumbs { margin-top: 24px; }
  .log { grid-template-columns: 1fr; }
  .log li > * + * { margin-top: 6px; }
  .off { opacity: 0.55; }
  pre { font-size: 0.85rem; }
</style>
