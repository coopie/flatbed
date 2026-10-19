<script lang="ts">
  import type { Project } from '../lib/project.svelte.ts';
  import { folderOf } from '../lib/template.ts';
  import { rulings } from '../lib/view.ts';
  import Ruling from './Ruling.svelte';

  let { project, base }: { project: Project; base: string } = $props();
  const folders = $derived(project.template.folders);
  const sealed = (path: string, mode: string) => mode === 'sealed' && !project.unsealed.includes(path);
  const inFolder = (path: string) => project.docs.filter((d) => folderOf(folders, d.name)?.path === path);
  const others = $derived(project.docs.filter((d) => folderOf(folders, d.name) === undefined));
  const all = $derived(rulings(project.sessions));
</script>

<aside class="side">
  <section>
    <h2 class="t-display">Folders</h2>
    <ul class="plain grid">
      {#each folders as f (f.path)}
        <li class="box">
          <p class="row"><span class="strong">{f.path}/</span> <span class="mode">{sealed(f.path, f.mode) ? 'sealed' : f.mode === 'sealed' ? 'revealed' : f.mode}</span></p>
          <p class="muted small">{f.about}</p>
          {#if sealed(f.path, f.mode)}
            <p class="small">{inFolder(f.path).length} sealed {inFolder(f.path).length === 1 ? 'document' : 'documents'}.
              {#if !project.example}<button class="bracket" onclick={() => project.reveal(f.path)}>reveal</button>{/if}</p>
          {:else}
            <ul class="plain docs">
              {#each inFolder(f.path) as d (d.name)}
                <li><a href={`${base}/doc/${d.name}`}>{d.name.slice(f.path.length + 1)}</a> <span class="muted">v{d.version}</span></li>
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
            {#each others as d (d.name)}<li><a href={`${base}/doc/${d.name}`}>{d.name}</a> <span class="muted">v{d.version}</span></li>{/each}
          </ul>
        </li>
      {/if}
    </ul>
  </section>

  <section>
    <h2 class="t-display">Supervisor rulings</h2>
    {#if all.length === 0}
      <p class="muted small">None yet. Each write to a reviewed folder gets one, here and in the chat.</p>
    {:else}
      <ol class="plain rulings">
        {#each [...all].reverse() as ruling (ruling.at + (ruling.call?.id ?? ''))}<li><Ruling {ruling} {base} /></li>{/each}
      </ol>
    {/if}
  </section>

  <section>
    <h2 class="t-display">Sessions</h2>
    <p class="muted small">Each session as the model saw it: its context, every message and every tool call.</p>
    <ol class="plain docs">
      {#each project.sessions as s (s.header.id)}
        <li><a href={`${base}/session/${s.header.id}`}>{s.header.id}</a> <span class="muted">{s.entries.length} entries</span></li>
      {:else}
        <li class="muted small">The first message opens one.</li>
      {/each}
    </ol>
  </section>
</aside>

<style>
  .side { display: grid; gap: 28px; }
  h2 { font-size: 1.4rem; margin-bottom: 10px; }
  .small { font-size: 0.8rem; }
  .docs { font-size: 0.85rem; display: grid; gap: 2px; margin-top: 6px; }
  .rulings { display: grid; gap: 8px; }
  .mode { margin-left: auto; }
</style>
