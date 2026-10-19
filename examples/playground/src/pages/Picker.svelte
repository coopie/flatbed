<script lang="ts">
  import { href } from '../lib/route.svelte.ts';
  import { hasRecording, templates } from '../lib/templates.ts';

  let { readOnly }: { readOnly: boolean } = $props();
</script>

<div class="wrap">
  <h1 class="display">Watch an agent do knowledge work</h1>
  <p class="lede">
    Pick a template and work with its agent for a few minutes. It keeps its memory as documents in folders, some it can
    write freely, some it can only read, some sealed, and a supervisor checks every write to a reviewed folder before
    it lands. You can read each document's history and every session as the model saw it.
  </p>
  {#if readOnly}
    <p class="notice box strong">Today's budget for the playground is spent, so it is read-only until midnight UTC. Each template's recorded example is still here to browse.</p>
  {/if}
</div>

<ul class="plain cards wrap">
  {#each templates as t (t.id)}
    <li class="card themed" data-template={t.id}>
      <h2 class="t-display">{t.name}</h2>
      <p>{t.pitch}</p>
      <ul class="plain folders">
        {#each t.folders as f (f.path)}
          <li><span class="mode">{f.mode}</span> <span class="strong">{f.path}/</span> <span class="muted">{f.about}</span></li>
        {/each}
      </ul>
      <p class="row actions">
        {#if !readOnly}<a class="btn" href={href(t.id, false)}>start</a>{/if}
        {#if hasRecording(t.id)}<a class="bracket" href={href(t.id, true)}>see a recorded example</a>{/if}
      </p>
    </li>
  {/each}
</ul>

<style>
  .notice { border: 1px solid var(--fg); margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px; padding-bottom: 48px; }
  .card { border: 1px solid var(--t-line); padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .card h2 { font-size: 1.7rem; line-height: 1.15; color: var(--t-accent); }
  .folders { font-size: 0.85rem; display: grid; gap: 4px; }
  .actions { margin-top: auto; padding-top: 8px; }
  .card .btn { background: var(--t-accent); border-color: var(--t-accent); color: var(--t-bg); font-family: var(--mono); }
  .card .btn:hover { background: transparent; color: var(--t-accent); }
</style>
