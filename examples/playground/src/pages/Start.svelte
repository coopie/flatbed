<script lang="ts">
  // The page before the first run: one box for the company's website, and what will happen.
  import type { Project } from '../lib/project.svelte.ts';
  import { href } from '../lib/route.svelte.ts';
  import { hasRecording } from '../lib/templates.ts';

  let { project }: { project: Project } = $props();
  let address = $state('');
  const ask = $derived(project.template.ask);
</script>

<div class="start">
  <h1 class="t-display title">Paste your company's website, and watch an agent run its press office</h1>
  <p class="lede">
    In two to five minutes, an agent reads the site's public pages, organises what they say into a fact sheet, a voice
    guide and its people and products, and writes a first post in the company's voice. A supervisor checks the post
    against the pages and refuses any claim they do not back. Then you can ask for more, and see how it was all done.
  </p>

  {#if project.readOnly}
    <p class="box notice">Today's budget for the playground is spent, so the agent cannot start until midnight UTC.
      {#if hasRecording}The <a href={href(true)}>recorded example</a> shows a full run.{/if}</p>
  {:else}
    <form class="ask" onsubmit={(e) => { e.preventDefault(); if (address.trim() !== '') project.start(address); }}>
      <label class="label" for="ask">{ask?.label ?? 'Company website'}</label>
      <div class="field">
        <input id="ask" type="text" inputmode="url" autocomplete="url" bind:value={address} placeholder={ask?.placeholder ?? 'https://example.com'} />
        <button class="btn" disabled={address.trim() === ''}>start</button>
      </div>
    </form>
  {/if}

  <ol class="plain three">
    <li><span class="num">1</span> <span class="strong">Reading.</span> About six of the site's pages, saved where the agent can read but not write.</li>
    <li><span class="num">2</span> <span class="strong">Organising.</span> Notes with the page behind every fact, so nothing rests on memory.</li>
    <li><span class="num">3</span> <span class="strong">Writing.</span> A first post, checked line by line against the pages before it lands.</li>
  </ol>

  <p class="row small">
    {#if hasRecording}<a class="bracket" href={href(true)}>see a recorded example</a>{/if}
    <a class="bracket" href={href(project.example, '/how')}>how this works</a>
  </p>
</div>

<style>
  .start { display: grid; gap: 20px; max-width: 760px; padding-block: 24px 48px; }
  .title { font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.08; color: var(--t-accent); }
  .lede { font: 1.05rem/1.6 var(--t-body); }
  .ask { display: grid; gap: 8px; }
  .field { display: flex; gap: 8px; }
  .field input { flex: 1; min-width: 0; font: 1.1rem var(--t-body); padding: 12px 14px; background: var(--t-bg); border-color: var(--t-fg); }
  .field .btn { background: var(--t-accent); border-color: var(--t-accent); color: var(--t-bg); font-family: var(--mono); padding-inline: 20px; }
  .field .btn:hover:not(:disabled) { background: transparent; color: var(--t-accent); }
  .three { display: grid; gap: 8px; font: 0.95rem/1.5 var(--t-body); }
  .num { font: 600 0.8rem var(--mono); color: var(--t-accent); margin-right: 4px; }
  .notice { border: 1px solid currentColor; }
  .small { font-size: 0.85rem; }
</style>
