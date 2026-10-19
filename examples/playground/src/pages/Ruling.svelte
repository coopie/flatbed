<script lang="ts">
  import type { Ruling } from '../lib/view.ts';
  let { ruling, base }: { ruling: Ruling; base: string } = $props();
  const { record, call } = $derived(ruling);
  const verdict = $derived(record.verdict);
  const target = $derived(typeof call?.input.name === 'string' ? call.input.name : 'a document');
  const outcome = $derived(
    verdict.status === 'unavailable' ? (record.refused ? 'could not check, so held back' : 'could not check')
      : record.refused ? 'refused' : record.mode === 'shadow' ? 'checked (shadow)' : 'passed',
  );
</script>

<div class="ruling" class:refused={record.refused}>
  <p><span class="label">supervisor</span> <span class="strong">{outcome}</span> the write to <a href={`${base}/doc/${target}`}>{target}</a></p>
  {#if verdict.status === 'given'}
    <p>{verdict.summary}</p>
    <details>
      <summary>each check</summary>
      <ul class="plain checks">
        {#each Object.entries(verdict.items) as [id, item] (id)}
          <li><span class="strong">{item.ok ? 'ok' : 'failed'}</span> {id}: <span class="muted">{item.analysis}</span></li>
        {/each}
      </ul>
    </details>
  {:else}
    <p>{verdict.reason}</p>
  {/if}
</div>

<style>
  .ruling { border: 1px solid var(--t-line); border-left: 4px solid var(--t-line); padding: 10px 14px; font-size: 0.85rem; display: grid; gap: 6px; }
  .refused { border-left-color: var(--t-accent); }
  .refused .strong { color: var(--t-accent); }
  .checks { display: grid; gap: 6px; margin-top: 6px; }
</style>
