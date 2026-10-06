<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';

  let { data, children } = $props();
  let working = $state(false);
  $effect(() => {
    working = data.working;
  });

  const links = [
    ['/', 'chat'],
    ['/proposals', 'proposals'],
    ['/docs', 'documents'],
    ['/sessions', 'sessions'],
    ['/timeline', 'timeline'],
  ] as const;
  const current = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));

  // Every new entry, proposal or change in whether the agent is working reloads the page's data.
  onMount(() => {
    if (!data.person) return;
    const stream = new EventSource('/api/stream');
    let pending: ReturnType<typeof setTimeout> | undefined;
    stream.onmessage = (message) => {
      const update = JSON.parse(message.data);
      if (update.type === 'working') working = update.working;
      clearTimeout(pending);
      pending = setTimeout(() => invalidateAll(), 150);
    };
    return () => stream.close();
  });

  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
  }
</script>

<div class="rainbow"></div>
<header class="wrap">
  <a class="name display" href="/">Assistant</a>
  {#if data.person}
    <nav class="row">
      {#each links as [href, label]}
        <a class="bracket" {href} aria-current={current(href) ? 'page' : undefined}>{label}{label === 'proposals' && data.waiting ? ` ${data.waiting}` : ''}</a>
      {/each}
    </nav>
  {/if}
  <div class="row end">
    {#if data.person}
      <span class="label">{data.person.name}{working ? ', agent working' : ''}</span>
      <form method="POST" action="/signout"><button class="bracket">sign out</button></form>
    {/if}
    <button class="bracket" onclick={toggleTheme}>theme</button>
  </div>
</header>
<main class="wrap">
  {@render children()}
</main>
<footer class="wrap label">
  {data.mode === 'demo' ? 'Demo mode: invented people, invented mail, and a fake outbox.' : 'Connected to Google.'}
  Built on flatbed.
</footer>
<div class="rainbow"></div>

<style>
  header { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; padding-block: 16px; border-bottom: 1px solid var(--line); }
  .name { font-size: 1.5rem; text-decoration: none; }
  .end { margin-left: auto; gap: 12px; }
  main { flex: 1; padding-bottom: 48px; }
  footer { padding-block: 16px; border-top: 1px solid var(--line); }
</style>
