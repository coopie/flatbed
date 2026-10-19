<script lang="ts">
  // The main view: the agent's three steps, filled in as its documents arrive. Reading lists the
  // pages in sources/, organising shows the fact sheet's facts beside their pages and the other
  // notes, and writing shows each draft in outbox/ beside the supervisor's latest ruling on it.
  import type { Project } from '../lib/project.svelte.ts';
  import { linkDocs, markdown } from '../lib/markdown.ts';
  import { href } from '../lib/route.svelte.ts';
  import { facts, rulingFor, rulings, steps, type StepState } from '../lib/view.ts';
  import Ruling from './Ruling.svelte';

  let { project }: { project: Project } = $props();
  const docHref = (name: string) => href(project.example, `/doc/${name}`);
  const state = $derived(steps(project.sessions, project.running));
  const inside = (folder: string) => project.docs.filter((d) => d.name.startsWith(`${folder}/`));
  const sources = $derived(inside('sources'));
  const notes = $derived(inside('notes'));
  const drafts = $derived(inside('outbox'));
  const factSheet = $derived(notes.find((d) => d.name === 'notes/fact-sheet'));
  const factList = $derived(factSheet ? facts(factSheet.body) : []);
  const all = $derived(rulings(project.sessions));
  const said: Record<StepState, string> = { waiting: 'next', now: 'under way', done: 'done' };
  // A draft as Markdown, with the document names in it linked.
  const draftHtml = (body: string) => linkDocs(markdown(body), docHref);
</script>

<ol class="plain steps">
  <li class="step" data-state={state.reading}>
    <p class="head"><span class="num">1</span> <span class="t-display name">Reading</span> <span class="label">{said[state.reading]}</span></p>
    <p class="muted small">The agent fetches the company's public pages, about six, and saves each one in <code>sources/</code>, where it can read but not write.</p>
    <ul class="plain list">
      {#each sources as d (d.name)}
        <li><a href={docHref(d.name)}>{d.summary.split(' | ')[0] || d.name}</a> <span class="muted small">{d.name.slice('sources/'.length)}</span></li>
      {:else}
        <li class="muted small">No pages yet.</li>
      {/each}
    </ul>
  </li>

  <li class="step" data-state={state.organising}>
    <p class="head"><span class="num">2</span> <span class="t-display name">Organising</span> <span class="label">{said[state.organising]}</span></p>
    <p class="muted small">It writes what the pages say into its own notes: a fact sheet with the page behind each fact, a voice guide, and the people and products.</p>
    {#if factList.length > 0}
      <ul class="plain facts">
        {#each factList.slice(0, 8) as fact}
          <li>{fact.text}{#if fact.source} <a class="src" href={docHref(fact.source)}>{fact.source.slice('sources/'.length)}</a>{/if}</li>
        {/each}
      </ul>
      {#if factList.length > 8}<p class="small"><a href={docHref('notes/fact-sheet')}>all {factList.length} facts</a></p>{/if}
    {/if}
    <ul class="plain list">
      {#each notes as d (d.name)}
        <li><a href={docHref(d.name)}>{d.name}</a> <span class="muted small">{d.summary}</span></li>
      {:else}
        <li class="muted small">No notes yet.</li>
      {/each}
    </ul>
  </li>

  <li class="step" data-state={state.writing}>
    <p class="head"><span class="num">3</span> <span class="t-display name">Writing</span> <span class="label">{said[state.writing]}</span></p>
    <p class="muted small">It writes from its notes into <code>outbox/</code>. A supervisor checks each draft against the pages before it lands, and refuses any claim they do not back.</p>
    {#each [...drafts].reverse() as d (d.name)}
      {@const ruling = rulingFor(all, d.name)}
      <article class="draft">
        <p class="small"><a class="strong" href={docHref(d.name)}>{d.name}</a> <span class="muted">version {d.version}</span></p>
        <div class="md body">{@html draftHtml(d.body)}</div>
        {#if ruling}<Ruling {ruling} example={project.example} />{/if}
      </article>
    {:else}
      {#if all.length > 0}
        <Ruling ruling={all.at(-1)!} example={project.example} />
      {:else}
        <p class="muted small">No drafts yet.</p>
      {/if}
    {/each}
  </li>
</ol>

<style>
  .steps { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr); gap: 16px; align-items: start; margin-bottom: 32px; }
  @media (max-width: 960px) { .steps { grid-template-columns: 1fr; } }
  .step { border: 1px solid var(--t-line); border-top: 4px solid var(--t-line); padding: 14px 16px; display: grid; gap: 10px; min-width: 0; }
  .step[data-state='now'] { border-top-color: var(--t-accent); }
  .step[data-state='now'] .label { color: var(--t-accent); animation: pulse 1.2s ease-in-out infinite; }
  .step[data-state='done'] { border-top-color: var(--t-fg); }
  .step[data-state='waiting'] .name { color: var(--t-muted); }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .head { display: flex; align-items: baseline; gap: 10px; }
  .head .label { margin-left: auto; }
  .num { font: 600 0.85rem var(--mono); }
  .name { font-size: 1.5rem; }
  .small { font-size: 0.8rem; }
  .list { display: grid; gap: 4px; font-size: 0.85rem; }
  .list li { overflow-wrap: anywhere; }
  .facts { display: grid; gap: 6px; font: 0.85rem/1.45 var(--t-body); }
  .src { font: 0.75rem var(--mono); color: var(--t-accent); margin-left: 6px; overflow-wrap: anywhere; }
  .draft { display: grid; gap: 8px; border-top: 1px solid var(--t-line); padding-top: 10px; }
  .body { font: 0.9rem/1.55 var(--t-body); overflow-wrap: anywhere; max-height: 24em; overflow: auto; }
  .body :global(:is(p, ul, ol, h4, h5, h6) + :is(p, ul, ol, h4, h5, h6)) { margin-top: 0.6em; }
  .body :global(:is(ul, ol)) { padding-left: 1.3em; list-style: disc; }
  .body :global(:is(h4, h5, h6)) { font-size: 1em; font-weight: 600; }
  code { font: 0.9em var(--mono); }
</style>
