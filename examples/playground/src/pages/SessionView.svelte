<script lang="ts">
  import { pathOf, renderEvent } from '@flatbed/core';
  import type { Project } from '../lib/project.svelte.ts';

  let { project, id }: { project: Project; id: string } = $props();
  const session = $derived(project.sessions.find((s) => s.header.id === id));
  const onPath = $derived(new Set(session ? pathOf(session.entries).map((e) => e.id) : []));
  const json = (value: unknown) => JSON.stringify(value, null, 2);
</script>

{#if session === undefined}
  <p class="box">There is no session {id}.</p>
{:else}
  <h2 class="t-display">Session {session.header.id}</h2>
  <p class="muted lede">
    Opened {new Date(session.header.createdAt).toLocaleString('en-GB')}{session.header.parent ? `, after a ${session.header.parent.reason} of ${session.header.parent.session}` : ''}.
    This is the session's log in order: the context the model was given, then every message, call and result. Entries marked for the host only never reach the model.
  </p>
  <ol class="plain grid log">
    {#each session.entries as entry (entry.id)}
      <li class="box" class:off={!onPath.has(entry.id)}>
        <p class="label">{entry.type}{entry.type === 'message' ? `, ${entry.message.role}` : ''}{entry.type === 'event' ? `, ${entry.kind}` : ''}{entry.type === 'custom' ? `, ${entry.plugin}, for the host only` : ''} · {new Date(entry.at).toLocaleTimeString('en-GB')}</p>
        {#if entry.type === 'context'}
          {#each entry.sections as section}
            <details><summary>Section: {section.name}{section.cache ? ' (cache mark)' : ''}</summary><pre>{section.text}</pre></details>
          {/each}
          <details><summary>Tools: {entry.tools.map((t) => t.name).join(', ')}</summary><pre>{json(entry.tools)}</pre></details>
        {:else if entry.type === 'event'}
          <pre>{renderEvent(entry)}</pre>
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
              <p class="label">{entry.message.model} · stop {entry.message.stop} · {entry.message.usage.input + (entry.message.usage.cacheRead ?? 0) + (entry.message.usage.cacheWrite ?? 0)} in, {entry.message.usage.output} out</p>
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
{/if}

<style>
  h2 { font-size: 1.8rem; margin-bottom: 8px; }
  .log { grid-template-columns: 1fr; font-size: 0.85rem; }
  .log li > * + * { margin-top: 6px; }
  .off { opacity: 0.55; }
  .log pre { max-height: 30em; overflow: auto; }
</style>
