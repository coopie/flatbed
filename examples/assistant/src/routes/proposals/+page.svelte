<script lang="ts">
  import { enhance } from '$app/forms';
  let { data, form } = $props();
  const pending = $derived(data.proposals.filter((p) => p.status === 'pending'));
  const decided = $derived(data.proposals.filter((p) => p.status !== 'pending'));
  const show = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));
  // The proposals with a decision in flight, whose buttons are disabled so a second click sends nothing.
  let deciding = $state(new Set<string>());
  const track = (id: string) => () => {
    deciding = new Set([...deciding, id]);
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      deciding = new Set([...deciding].filter((d) => d !== id));
    };
  };
</script>

<svelte:head><title>Proposals · Assistant</title></svelte:head>

<h1 class="display">Proposals</h1>
<p class="lede">What your assistant would like to send, and why. Nothing goes out until you accept it. Edit any field first, and your assistant learns from what you changed.</p>
{#if form?.message}<p class="strong">{form.message}</p>{/if}

{#snippet checklist(check: (typeof data.proposals)[number]['check'])}
  {#if check}
    <details class="check" open>
      <summary class="label">Supervisor, {check.mode === 'shadow' ? 'advising only' : 'enforcing'}: {check.status === 'unavailable' ? 'no verdict' : `${check.items.filter((i) => !i.ok).length} of ${check.items.length} checks failed`}</summary>
      <ul class="plain">
        {#each check.items as item}
          <li><span class="strong">{item.ok ? 'Pass' : item.severity === 'warn' ? 'Worth a look' : 'Fail'}</span> {item.title}. <span class="muted">{item.analysis}</span></li>
        {/each}
      </ul>
      <p class="muted">{check.summary}</p>
    </details>
  {/if}
{/snippet}

<h2 class="display">Waiting for you</h2>
{#if pending.length === 0}<p class="muted">Nothing is waiting.</p>{:else}
<div class="grid cards">
  {#each pending as p (p.id)}
    <form method="POST" use:enhance={track(p.id)} class="box card">
      <input type="hidden" name="id" value={p.id} />
      <p class="label">{p.kind === 'email' ? 'Email' : 'Calendar event'} · {p.id}</p>
      <p><span class="label">Why</span><br />{p.reason}</p>
      {#each p.fields as field}
        <label class="label" for="{p.id}-{field}">{field}</label>
        {#if field === 'body'}
          <textarea id="{p.id}-{field}" name={field} rows="8">{show(p.input[field])}</textarea>
        {:else}
          <input id="{p.id}-{field}" name={field} value={show(p.input[field])} />
        {/if}
      {/each}
      <label class="label" for="{p.id}-note">A note for your assistant, if you like</label>
      <input id="{p.id}-note" name="note" placeholder="Such as: keep it shorter next time" />
      {@render checklist(p.check)}
      <div class="row">
        <button class="btn" name="outcome" value="accepted" disabled={deciding.has(p.id)}>Accept and send</button>
        <button class="bracket" name="outcome" value="denied" disabled={deciding.has(p.id)}>deny</button>
      </div>
    </form>
  {/each}
</div>
{/if}

<h2 class="display">Decided</h2>
{#if decided.length === 0}<p class="muted">Nothing decided yet.</p>{:else}
<div class="grid cards">
  {#each decided as p (p.id)}
    <article class="box">
      <p class="label">{p.kind === 'email' ? 'Email' : 'Calendar event'} · {p.id} · <span class="strong">{p.status}</span></p>
      {#each p.fields as field}
        <p><span class="label">{field}</span><br /><span class="pre">{show((p.decidedInput ?? p.input)[field])}</span></p>
      {/each}
      {#if p.note}<p><span class="label">Your note</span><br />{p.note}</p>{/if}
      {#if p.result}<p class="muted">{p.result}</p>{/if}
      {@render checklist(p.check)}
    </article>
  {/each}
</div>
{/if}

{#if data.outbox.length > 0}
  <h2 class="display">Demo outbox</h2>
  <p class="muted">In demo mode, what you accept lands here instead of in Gmail or Calendar.</p>
  <div class="grid cards">
    {#each data.outbox as item (item.id)}
      <article class="box">
        <p class="label">{item.kind} · {new Date(item.sent_at).toLocaleString('en-GB')}</p>
        {#if item.kind === 'email'}
          <p><span class="label">to</span> {item.input.to}</p>
          <p><span class="label">subject</span> {item.input.subject}</p>
          <pre>{item.input.body}</pre>
        {:else}
          <p>{item.input.title}, {item.input.start} to {item.input.end}</p>
        {/if}
      </article>
    {/each}
  </div>
{/if}

<style>
  h2.display { margin: 32px 0 12px; }
  .cards { grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 560px)); width: fit-content; max-width: 100%; }
  .card { display: flex; flex-direction: column; gap: 6px; }
  .card > * + * { margin-top: 0; }
  .check { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 8px; }
  .check li { margin-top: 6px; }
  .pre { white-space: pre-wrap; }
</style>
