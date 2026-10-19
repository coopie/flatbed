<script lang="ts">
  import type { Project } from '../lib/project.svelte.ts';
  import { markdown } from '../lib/markdown.ts';
  import { chatItems } from '../lib/view.ts';
  import Ruling from './Ruling.svelte';

  let { project, base }: { project: Project; base: string } = $props();
  let draft = $state('');
  const items = $derived(chatItems(project.sessions));
  const asking = $derived(project.template.ask !== null && project.sessions.length === 0);
  const canSend = $derived(!project.readOnly && !project.running);

  async function send(text: string) {
    const message = asking && project.template.ask ? `${project.template.ask.label}: ${text}` : text;
    draft = '';
    await project.send(message);
  }
  const verb: Record<string, string> = {
    list_docs: 'listed documents', read_doc: 'read', write_doc: 'wrote', edit_doc: 'edited', pin_doc: 'pinned',
    add_to_timeline: 'added to the timeline:', fetch_page: 'fetched', reset: 'reset the session',
  };
</script>

<div class="chat">
  <ol class="plain log">
    <li class="agent"><p class="label">agent</p><div class="md">{@html markdown(project.template.opening)}</div></li>
    {#each items as item, i (i)}
      {#if item.kind === 'visitor'}
        <li class="visitor"><p class="label">you</p><pre>{item.text}</pre></li>
      {:else if item.kind === 'agent'}
        <!-- markdown() escapes the reply before it adds its own tags, so no HTML from the model reaches the page. -->
        <li class="agent"><p class="label">agent</p><div class="md">{@html markdown(item.text)}</div></li>
      {:else if item.kind === 'tool'}
        <li class="tool" class:failed={item.isError}>
          <details>
            <summary>{verb[item.name] ?? item.name} {item.target}{item.isError ? ' (refused or failed)' : ''}</summary>
            <pre>{item.result}</pre>
          </details>
        </li>
      {:else if item.kind === 'ruling'}
        <li class="ruling"><Ruling ruling={item.ruling} {base} /></li>
      {:else if item.kind === 'notice'}
        <li class="tool"><span class="label">harness</span> {item.text}</li>
      {:else if item.kind === 'reset'}
        <li class="tool"><span class="label">session ended</span> {item.reason ?? ''}. The next message starts a fresh session from the documents.</li>
      {/if}
    {/each}
    {#if project.running}<li class="tool working">The agent is working...</li>{/if}
  </ol>

  {#if project.error}<p class="box error">{project.error}</p>{/if}

  {#if !project.readOnly}
    <form class="compose" onsubmit={(e) => { e.preventDefault(); send(draft); }}>
      {#if asking && project.template.ask}
        <label class="label" for="ask">{project.template.ask.label}</label>
        <input id="ask" bind:value={draft} placeholder={project.template.ask.placeholder} disabled={!canSend} />
      {:else}
        <label class="label" for="draft">Your message</label>
        <textarea id="draft" bind:value={draft} disabled={!canSend}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); } }}></textarea>
      {/if}
      <p class="row">
        <button class="btn" disabled={!canSend || draft.trim() === ''}>send</button>
      </p>
      {#if !asking}
        <ul class="plain prompts">
          {#each project.template.prompts as prompt}
            <li><button type="button" class="prompt" disabled={!canSend} onclick={() => send(prompt)}>{prompt}</button></li>
          {/each}
        </ul>
      {/if}
    </form>
  {/if}
</div>

<style>
  .log { display: grid; gap: 12px; margin-bottom: 20px; }
  .log > li { min-width: 0; }
  .agent, .visitor { padding: 12px 14px; border: 1px solid var(--t-line); }
  .visitor { margin-left: 12%; background: color-mix(in srgb, var(--t-accent) 7%, transparent); }
  .agent { margin-right: 12%; }
  .agent .md, .visitor pre { font-family: var(--t-body); line-height: 1.55; }
  .md { overflow-wrap: anywhere; }
  .md :global(:is(p, ul, ol, blockquote, h4, h5, h6) + :is(p, ul, ol, blockquote, h4, h5, h6)) { margin-top: 0.7em; }
  .md :global(:is(ul, ol)) { padding-left: 1.3em; }
  .md :global(ul) { list-style: disc; }
  .md :global(ol) { list-style: decimal; }
  .md :global(blockquote) { border-left: 2px solid var(--t-line); padding-left: 10px; color: var(--t-muted); }
  .md :global(:is(h4, h5, h6)) { font-size: 1em; font-weight: 600; }
  .md :global(code) { font: 0.9em var(--mono); }
  .md :global(a) { color: var(--t-accent); }
  .tool { font-size: 0.8rem; color: var(--t-muted); font-family: var(--mono); padding-inline: 14px; }
  .tool pre { margin-top: 6px; max-height: 18em; overflow: auto; border-left: 2px solid var(--t-line); padding-left: 10px; }
  .failed summary { color: var(--t-accent); }
  .working { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .compose { display: grid; gap: 8px; }
  .compose :is(input, textarea) { background: var(--t-bg); border-color: var(--t-line); font-family: var(--t-body); }
  .compose .btn { background: var(--t-accent); border-color: var(--t-accent); color: var(--t-bg); }
  .compose .btn:hover:not(:disabled) { background: transparent; color: var(--t-accent); }
  .prompts { display: grid; gap: 6px; margin-top: 4px; }
  .prompt { font: 0.85rem var(--mono); text-align: left; background: none; color: inherit; border: 1px solid var(--t-line); padding: 6px 10px; width: 100%; cursor: var(--hand); }
  .prompt:hover:not(:disabled) { border-color: var(--t-accent); }
  .error { border: 1px solid var(--t-accent); color: var(--t-accent); }
</style>
