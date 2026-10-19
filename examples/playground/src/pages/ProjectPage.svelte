<script lang="ts">
  // The visitor's project or the recorded example: the start box before the first run, then the
  // three steps and the conversation, and the pages for how it works, a document and a session.
  import { untrack } from 'svelte';
  import Chat from './Chat.svelte';
  import DocView from './DocView.svelte';
  import How from './How.svelte';
  import SessionView from './SessionView.svelte';
  import Start from './Start.svelte';
  import Steps from './Steps.svelte';
  import { Project } from '../lib/project.svelte.ts';
  import { href, type Route } from '../lib/route.svelte.ts';
  import { hasRecording } from '../lib/templates.ts';
  import type { Template } from '../lib/template.ts';

  let { template, route, readOnly }: { template: Template; route: Route; readOnly: boolean } = $props();

  // Opened once per mode, since App keys this page on it.
  const opening = untrack(() => (route.example ? Project.example(template) : Project.live(template, readOnly)));
  const home = $derived(href(route.example));

  async function download(project: Project) {
    const url = URL.createObjectURL(await project.download());
    const a = Object.assign(document.createElement('a'), { href: url, download: `${template.id}-project.zip` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function reset(project: Project) {
    if (confirm('Delete this project from your browser and start again?')) await project.reset();
  }
</script>

<section class="themed project" data-template={template.id}>
  <div class="wrap">
    {#await opening}
      <p class="muted top">Opening the project...</p>
    {:then project}
      {#if route.page === 'project' && !project.example && project.sessions.length === 0 && !project.running}
        <Start {project} />
      {:else}
        <p class="row status">
          {#if route.page !== 'project'}<a class="bracket" href={home}>back to the {project.example ? 'example' : 'project'}</a>{/if}
          {#if route.page !== 'how'}<a class="bracket" href={href(route.example, '/how')}>how this works</a>{/if}
          {#if project.example}
            <span class="muted">A recorded example: a real run, saved with the site. Nothing here calls the model.</span>
            {#if !readOnly}<a class="bracket" href={href(false)}>try your own company</a>{/if}
          {:else}
            <button class="bracket" onclick={() => download(project)}>download as Markdown</button>
            <button class="bracket" onclick={() => reset(project)} disabled={project.running}>start again</button>
            {#if hasRecording}<a class="bracket" href={href(true)}>recorded example</a>{/if}
          {/if}
        </p>
        {#if !project.example && readOnly}
          <p class="box notice">Today's budget is spent, so the agent cannot answer until midnight UTC. You can still read your project, download it, or open the recorded example.</p>
        {/if}

        {#if route.page === 'doc'}
          <DocView {project} name={route.name ?? ''} />
        {:else if route.page === 'session'}
          <SessionView {project} id={route.name ?? ''} />
        {:else if route.page === 'how'}
          <How {project} />
        {:else}
          <h1 class="t-display title">{template.name}</h1>
          <Steps {project} />
          <div class="talk"><Chat {project} /></div>
        {/if}
      {/if}
    {:catch error}
      <p class="box notice top">This project would not open: {error instanceof Error ? error.message : String(error)}</p>
    {/await}
  </div>
</section>

<style>
  .project { min-height: 70vh; padding-bottom: 48px; }
  .top { padding-top: 24px; }
  .status { font-size: 0.85rem; padding-top: 20px; margin-bottom: 16px; }
  .title { font-size: clamp(1.8rem, 4vw, 2.6rem); line-height: 1.1; margin-bottom: 16px; color: var(--t-accent); }
  .notice { border: 1px solid currentColor; margin-bottom: 20px; }
  .talk { max-width: 860px; }
</style>
