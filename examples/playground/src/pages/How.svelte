<script lang="ts">
  // How this works: the folders and their modes, each document with its history, every
  // supervisor ruling, and each session as the model saw it.
  import type { Project } from '../lib/project.svelte.ts';
  import { href } from '../lib/route.svelte.ts';
  import { folderOf } from '../lib/template.ts';
  import { rulings } from '../lib/view.ts';
  import Ruling from './Ruling.svelte';

  let { project }: { project: Project } = $props();
  const docHref = (name: string) => href(project.example, `/doc/${name}`);
  const folders = $derived(project.template.folders);
  const sealed = (path: string, mode: string) => mode === 'sealed' && !project.unsealed.includes(path);
  const inFolder = (path: string) => project.docs.filter((d) => folderOf(folders, d.name)?.path === path);
  const others = $derived(project.docs.filter((d) => folderOf(folders, d.name) === undefined));
  const all = $derived(rulings(project.sessions));
  const modes: Record<string, string> = {
    read: 'The agent can list and read. Only the host writes here: fetch_page saves each page it reads.',
    write: 'The agent can read and write freely.',
    reviewed: 'The agent can read. A write goes past the supervisor first, and lands only if it passes.',
    sealed: 'Hidden from the agent and the supervisor until it is revealed.',
  };
</script>

<div class="how">
  <h2 class="t-display">How this works</h2>
  <p class="lede">
    The agent is <a href="https://github.com/coopie/flatbed">flatbed</a>'s core loop running in your browser, on Claude Haiku 4.5.
    It keeps its memory as documents in three folders, each with its own permissions, and every document keeps its
    history. A second model call, the supervisor, checks each write to <code>outbox/</code> against the pages. Sessions are
    kept as append-only logs, so you can read each one as the model saw it. Nothing is stored on a server.
  </p>

  <section>
    <h3 class="t-display">Folders and their modes</h3>
    <ul class="plain grid folders">
      {#each folders as f (f.path)}
        <li class="box">
          <p class="row"><span class="strong">{f.path}/</span> <span class="mode label">{sealed(f.path, f.mode) ? 'sealed' : f.mode === 'sealed' ? 'revealed' : f.mode}</span></p>
          <p class="small">{f.about}</p>
          <p class="muted small">{modes[f.mode]}</p>
          {#if sealed(f.path, f.mode)}
            <p class="small">{inFolder(f.path).length} sealed {inFolder(f.path).length === 1 ? 'document' : 'documents'}.
              {#if !project.example}<button class="bracket" onclick={() => project.reveal(f.path)}>reveal</button>{/if}</p>
          {:else}
            <ul class="plain docs">
              {#each inFolder(f.path) as d (d.name)}
                <li><a href={docHref(d.name)}>{d.name.slice(f.path.length + 1)}</a> <span class="muted">{d.version === 1 ? '1 version' : `${d.version} versions`}</span></li>
              {:else}
                <li class="muted small">Nothing here yet.</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
      {#if others.length > 0}
        <li class="box">
          <p class="strong">Other documents</p>
          <p class="muted small">Outside the template's folders, such as the agent's timeline.</p>
          <ul class="plain docs">
            {#each others as d (d.name)}<li><a href={docHref(d.name)}>{d.name}</a> <span class="muted">v{d.version}</span></li>{/each}
          </ul>
        </li>
      {/if}
    </ul>
  </section>

  <section>
    <h3 class="t-display">Supervisor rulings</h3>
    {#if all.length === 0}
      <p class="muted small">None yet. Each write to outbox/ gets one.</p>
    {:else}
      <ol class="plain rulings">
        {#each [...all].reverse() as ruling (ruling.at + (ruling.call?.id ?? ''))}<li><Ruling {ruling} example={project.example} /></li>{/each}
      </ol>
    {/if}
  </section>

  <section>
    <h3 class="t-display">Sessions</h3>
    <p class="muted small">Each session as the model saw it: its context, every message and every tool call. A session ends when its context grows large; the next starts fresh from the pinned notes.</p>
    <ol class="plain docs">
      {#each project.sessions as s (s.header.id)}
        <li><a href={href(project.example, `/session/${s.header.id}`)}>{s.header.id}</a> <span class="muted">{s.entries.length} entries</span></li>
      {:else}
        <li class="muted small">The first message opens one.</li>
      {/each}
    </ol>
  </section>
</div>

<style>
  .how { display: grid; gap: 28px; max-width: 80ch; }
  h2 { font-size: 1.8rem; }
  h3 { font-size: 1.3rem; margin-bottom: 10px; }
  .lede { font-family: var(--t-body); line-height: 1.6; }
  .folders { grid-template-columns: 1fr; }
  .folders li > * + * { margin-top: 4px; }
  .small { font-size: 0.85rem; }
  .docs { font-size: 0.85rem; display: grid; gap: 2px; margin-top: 6px; }
  .rulings { display: grid; gap: 8px; }
  .mode { margin-left: auto; }
  code { font: 0.9em var(--mono); }
</style>
