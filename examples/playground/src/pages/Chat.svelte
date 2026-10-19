<script lang="ts">
  import type { Project } from '../lib/project.svelte.ts';
  import { markdown } from '../lib/markdown.ts';
  import { chatItems, foldActivity, summaryOf, type ChatItem } from '../lib/view.ts';
  import Ruling from './Ruling.svelte';

  // The conversation, after the first message: every reply, each tool call as a short line, the
  // supervisor's rulings, and the one-click asks and a box for the visitor's own.
  let { project }: { project: Project } = $props();
  let draft = $state('');
  const lines = $derived(foldActivity(chatItems(project.sessions)));
  const canSend = $derived(!project.readOnly && !project.running);

  async function send(text: string) {
    draft = '';
    await project.send(text);
  }
  const verb: Record<string, string> = {
    list_docs: 'listed documents', read_doc: 'read', write_doc: 'wrote', edit_doc: 'edited', pin_doc: 'pinned',
    add_to_timeline: 'added to the timeline:', fetch_page: 'fetched', reset: 'reset the session',
  };
  // One mark per line in a folded run, so what happened inside shows at a glance.
  const mark: Record<string, string> = {
    fetch_page: '↓', read_doc: '◦', list_docs: '≡', write_doc: '✎', edit_doc: '✎', pin_doc: '▪', add_to_timeline: '·',
  };
  const markOf = (item: ChatItem) =>
    item.kind === 'ruling' ? '✓' : item.kind === 'tool' ? (item.isError ? '✗' : (mark[item.name] ?? '•')) : '•';
</script>

{#snippet quiet(item: ChatItem)}
  {#if item.kind === 'tool'}
    <div class="tool" class:failed={item.isError}>
      <details>
        <summary>{verb[item.name] ?? item.name} {item.target}{item.isError ? ' (refused or failed)' : ''}</summary>
        <pre>{item.result}</pre>
      </details>
    </div>
  {:else if item.kind === 'ruling'}
    <div class="ruling"><Ruling ruling={item.ruling} example={project.example} /></div>
  {:else if item.kind === 'agent'}
    <p class="tool narration">{item.text}</p>
  {/if}
{/snippet}

<div class="chat">
  <ol class="plain log">
    <li class="agent"><p class="label">agent</p><div class="md">{@html markdown(project.template.opening)}</div></li>
    {#each lines as item, i (i)}
      {#if item.kind === 'activity'}
        <li class="tool activity">
          <details>
            <summary>
              <span>{summaryOf(item)}</span>
              <span class="marks" aria-hidden="true">{#each item.items.filter((inner) => inner.kind !== 'agent') as inner}<span class:failed={inner.kind === 'tool' && inner.isError}>{markOf(inner)}</span>{/each}</span>
              <span class="rule"></span>
            </summary>
            <ol class="plain inner">
              {#each item.items as inner, j (j)}
                <li>{@render quiet(inner)}</li>
              {/each}
            </ol>
          </details>
        </li>
      {:else if item.kind === 'visitor'}
        <li class="visitor"><p class="label">you</p><pre>{item.text}</pre></li>
      {:else if item.kind === 'agent' && !item.narration}
        <!-- markdown() escapes the reply before it adds its own tags, so no HTML from the model reaches the page. -->
        <li class="agent"><p class="label">agent</p><div class="md">{@html markdown(item.text)}</div></li>
      {:else if item.kind === 'tool' || item.kind === 'ruling' || item.kind === 'agent'}
        <li>{@render quiet(item)}</li>
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
      <p class="label">Ask for more</p>
      <ul class="plain prompts">
        {#each project.template.prompts as prompt}
          <li><button type="button" class="prompt" disabled={!canSend} onclick={() => send(prompt)}>{prompt}</button></li>
        {/each}
      </ul>
      <label class="label" for="draft">Or write your own</label>
      <textarea id="draft" bind:value={draft} disabled={!canSend}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); } }}></textarea>
      <p class="row">
        <button class="btn" disabled={!canSend || draft.trim() === ''}>send</button>
      </p>
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
  .failed summary, .marks .failed { color: var(--t-accent); }
  .activity summary { display: flex; align-items: center; gap: 10px; cursor: var(--hand); list-style: none; }
  .activity summary::-webkit-details-marker { display: none; }
  .activity details[open] > summary > span:first-child { color: var(--t-fg); }
  .marks { display: flex; gap: 4px; flex-shrink: 0; }
  .rule { flex: 1; border-top: 1px solid var(--t-line); }
  .inner { display: grid; gap: 6px; margin-top: 8px; border-left: 2px solid var(--t-line); padding-left: 10px; }
  .inner .tool { padding-inline: 0; }
  .narration { font-family: var(--t-body); font-style: italic; }
  .working { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .compose { display: grid; gap: 8px; }
  .compose textarea { background: var(--t-bg); border-color: var(--t-line); font-family: var(--t-body); }
  .compose .btn { background: var(--t-accent); border-color: var(--t-accent); color: var(--t-bg); }
  .compose .btn:hover:not(:disabled) { background: transparent; color: var(--t-accent); }
  .prompts { display: grid; gap: 6px; margin-bottom: 8px; }
  .prompt { font: 0.85rem var(--mono); text-align: left; background: none; color: inherit; border: 1px solid var(--t-line); padding: 6px 10px; width: 100%; cursor: var(--hand); }
  .prompt:hover:not(:disabled) { border-color: var(--t-accent); }
  .error { border: 1px solid var(--t-accent); color: var(--t-accent); }
</style>
