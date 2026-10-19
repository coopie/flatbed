<script lang="ts">
  import Picker from './pages/Picker.svelte';
  import ProjectPage from './pages/ProjectPage.svelte';
  import { route } from './lib/route.svelte.ts';
  import { templates } from './lib/templates.ts';

  // Whether the day's budget is spent, asked once before any page draws. Unknown counts as open;
  // a refused model call then says why.
  const status = fetch('/api/status')
    .then((r) => r.json() as Promise<{ readOnly?: boolean }>)
    .then((s) => s.readOnly === true)
    .catch(() => false);

  const template = $derived.by(() => {
    const current = route.current;
    return current.page === 'picker' ? undefined : templates.find((t) => t.id === current.template);
  });

  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', root.dataset.theme);
    } catch {}
  }
</script>

<svelte:head>
  {#each templates as t (t.id)}
    {#if t.fonts.length > 0}
      <link rel="stylesheet" href={`https://fonts.googleapis.com/css2?${t.fonts.map((f) => `family=${f.replaceAll(' ', '+')}:ital,wght@0,400;0,600;1,400`).join('&')}&display=swap`} />
    {/if}
  {/each}
  {@html `<style>${templates.map((t) => t.look).join('\n')}</style>`}
</svelte:head>

<div class="rainbow"></div>
<header class="wrap">
  <a class="name display" href="#/">flatbed playground</a>
  <div class="row end">
    <a class="bracket" href="https://github.com/coopie/flatbed">the code</a>
    <button class="bracket" onclick={toggleTheme}>theme</button>
  </div>
</header>
<main>
  {#await status then readOnly}
  {#if route.current.page === 'picker'}
    <Picker {readOnly} />
  {:else if template}
    {#key `${template.id}/${route.current.example}`}
      <ProjectPage {template} route={route.current} {readOnly} />
    {/key}
  {:else}
    <div class="wrap"><h1 class="display">No such template</h1><p><a class="bracket" href="#/">all templates</a></p></div>
  {/if}
  {/await}
</main>
<footer class="wrap label">
  Everything you make here stays in this browser. Model calls go through a small proxy to Claude Haiku 4.5. Built on flatbed.
</footer>
<div class="rainbow"></div>

<style>
  header { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; padding-block: 16px; border-bottom: 1px solid var(--line); }
  .name { font-size: 1.5rem; text-decoration: none; }
  .end { margin-left: auto; gap: 12px; }
  main { flex: 1; }
  footer { padding-block: 16px; border-top: 1px solid var(--line); }
</style>
