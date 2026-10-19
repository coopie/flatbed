<script lang="ts">
  import { untrack } from 'svelte';
  import Chat from './Chat.svelte';
  import DocView from './DocView.svelte';
  import SessionView from './SessionView.svelte';
  import Side from './Side.svelte';
  import { Project } from '../lib/project.svelte.ts';
  import { href, type Route } from '../lib/route.svelte.ts';
  import { hasRecording } from '../lib/templates.ts';
  import type { Template } from '../lib/template.ts';

  let { template, route, readOnly }: { template: Template; route: Extract<Route, { template: string }>; readOnly: boolean } = $props();

  // Opened once per template and mode, since App keys this page on both.
  const opening = untrack(() => (route.example ? Project.example(template) : Project.live(template, readOnly)));
  const base = $derived(href(template.id, route.example));

  async function download(project: Project) {
    const url = URL.createObjectURL(await project.download());
    const a = Object.assign(document.createElement('a'), { href: url, download: `${template.id}-project.zip` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function reset(project: Project) {
    if (confirm('Delete this project from your browser and start again from the template?')) await project.reset();
  }
</script>

<section class="themed project" data-template={template.id}>
  <div class="wrap">
    <p class="crumbs row">
      <a class="bracket" href="#/">all templates</a>
      {#if route.page !== 'project'}<a class="bracket" href={base}>back to the project</a>{/if}
    </p>
    <h1 class="t-display title">{template.name}</h1>
    {#await opening}
      <p class="muted">Opening the project...</p>
    {:then project}
      <p class="row status">
        {#if project.example}
          <span class="muted">A recorded example: a real run of this template, saved with the site. You can read everything; nothing here calls the model.</span>
          {#if !readOnly}<a class="bracket" href={href(template.id, false)}>start your own</a>{/if}
        {:else}
          <span class="muted">Your project, kept in this browser.</span>
          <button class="bracket" onclick={() => download(project)}>download as Markdown</button>
          <button class="bracket" onclick={() => reset(project)} disabled={project.running}>reset</button>
          {#if hasRecording(template.id)}<a class="bracket" href={href(template.id, true)}>recorded example</a>{/if}
        {/if}
      </p>
      {#if !project.example && readOnly}
        <p class="box notice">Today's budget is spent, so the agent cannot answer until midnight UTC. You can still read your project, download it, or open the recorded example.</p>
      {/if}

      {#if route.page === 'doc'}
        <DocView {project} name={route.name ?? ''} {base} />
      {:else if route.page === 'session'}
        <SessionView {project} id={route.name ?? ''} />
      {:else}
        <div class="layout">
          <Chat {project} {base} />
          <Side {project} {base} />
        </div>
      {/if}
    {:catch error}
      <p class="box notice">This project would not open: {error instanceof Error ? error.message : String(error)}</p>
    {/await}
  </div>
</section>

<style>
  .project { min-height: 70vh; padding-bottom: 48px; }
  .crumbs { padding-top: 20px; font-size: 0.85rem; }
  .title { font-size: clamp(2rem, 5vw, 3rem); line-height: 1.1; margin: 16px 0 8px; color: var(--t-accent); }
  .status { font-size: 0.85rem; margin-bottom: 20px; }
  .notice { border: 1px solid currentColor; margin-bottom: 20px; }
  .layout { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 32px; align-items: start; }
  @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
</style>
