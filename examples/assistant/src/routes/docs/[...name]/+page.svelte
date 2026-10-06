<script lang="ts">
  import { enhance } from '$app/forms';
  let { data, form } = $props();
  const old = $derived(data.doc.version !== data.latest);
  const timeline = $derived(data.doc.name.startsWith('timeline/'));
</script>

<svelte:head><title>{data.doc.name} · Assistant</title></svelte:head>

<p class="crumbs"><a class="bracket" href={timeline ? '/timeline' : '/docs'}>{timeline ? 'timeline' : 'documents'}</a></p>
<h1 class="display">{data.doc.name}</h1>
<p class="lede">{data.doc.summary}</p>

<div class="layout">
  <section>
    {#if old}
      <p class="strong">You are reading version {data.doc.version} of {data.latest}. <a class="bracket" href="?">newest</a></p>
      <pre class="box read">{data.doc.body}</pre>
    {:else}
      <form method="POST" action="?/save" use:enhance={() => ({ update }) => update({ reset: false })} class="edit">
        <label class="label" for="summary">Summary</label>
        <input id="summary" name="summary" value={data.doc.summary} />
        <label class="label" for="body">Body, in Markdown</label>
        <textarea id="body" name="body" rows="22">{data.doc.body}</textarea>
        {#if form?.message}<p class="strong">{form.message}</p>{/if}
        <div class="row">
          <button class="btn">Save a new version</button>
          {#if !timeline}
            <button class="bracket" formaction="?/pin">{data.doc.pinned ? 'unpin' : 'pin'}</button>
            <span class="label">{data.doc.pinned ? 'Pinned: in context every session.' : 'Not pinned.'}</span>
          {/if}
        </div>
      </form>
    {/if}
  </section>
  <aside>
    <p class="label">History</p>
    <ol class="plain grid">
      {#each data.history as v}
        <li class="box">
          <a class="bracket" href="?v={v.version}" aria-current={v.version === data.doc.version ? 'page' : undefined}>version {v.version}</a>
          <span class="label">{new Date(v.writtenAt).toLocaleString('en-GB')}, by {v.writtenBy}</span>
        </li>
      {/each}
    </ol>
  </aside>
</div>

<style>
  .crumbs { margin-top: 24px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 24px; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
  .edit { display: grid; gap: 8px; }
  .read { border: 1px solid var(--line); }
  aside li { display: flex; flex-direction: column; padding: 8px 12px; }
</style>
