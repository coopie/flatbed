/**
 * The guard: a plugin that checks each call to a supervised tool before it runs.
 *
 * The host maps tool names to specs and chooses a mode. In `shadow` the verdict is only recorded,
 * which is how a host learns what a spec would refuse before it lets the spec refuse anything. In
 * `enforce` a blocked call is replaced by a result that tells the agent what failed and why, so it
 * can redraft and call again. Every verdict is appended to the session as a `custom` entry, beside
 * the call it judged.
 *
 * The guard never throws. A check that cannot be made, because the host's answers or the supervisor
 * failed, gives an unavailable verdict, which the mode and `whenUnavailable` then decide.
 */
import { escapeAttr, escapeText, type Plugin, type ToolCall, type ToolContext, type ToolResult } from '@flatbed/core';
import { firstLine, type Supervise } from './run.ts';
import { blocked, failures, type ItemVerdict, type Spec, type Verdict } from './spec.ts';

export type GuardMode = 'off' | 'shadow' | 'enforce';

export type GuardOptions = {
  /** The spec for each supervised tool, by tool name. Calls to other tools are not checked. */
  specs: Record<string, Spec>;
  mode: GuardMode;
  /** The supervisor, from `singlePass` or `agentPass`. */
  supervise: Supervise;
  /**
   * What `enforce` does when the supervisor gives no verdict: `refuse` the call, the default, or
   * `allow` it. A verdict nobody gave is never a pass, so allow only a call that costs little.
   */
  whenUnavailable?: 'refuse' | 'allow';
  /** The host's answers to a spec's `answeredBy: "host"` items, for one call. */
  answers?: (call: ToolCall, spec: Spec) => Record<string, ItemVerdict> | Promise<Record<string, ItemVerdict>>;
};

/** What the guard appends for each verdict, as the `data` of a `custom` entry with `plugin: "supervisor"`. */
export type GuardRecord = { mode: Exclude<GuardMode, 'off'>; refused: boolean; verdict: Verdict };

export function supervisorGuard(options: GuardOptions): Plugin {
  return {
    name: 'supervisor',
    async beforeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult | undefined> {
      const spec = options.specs[call.name];
      if (options.mode === 'off' || spec === undefined) return undefined;
      const verdict = await judge(spec, call, ctx);
      const refused =
        options.mode === 'enforce' &&
        (verdict.status === 'unavailable' ? options.whenUnavailable !== 'allow' : blocked(spec, verdict));
      const record: GuardRecord = { mode: options.mode, refused, verdict };
      await ctx.append({ type: 'custom', plugin: 'supervisor', data: record });
      return refused ? refusal(spec, call, verdict) : undefined;
    }
  };

  /** The supervisor's verdict on one call. A host answer or a supervisor that fails gives an unavailable verdict, never a throw. */
  async function judge(spec: Spec, call: ToolCall, ctx: ToolContext): Promise<Verdict> {
    try {
      const answers = (await options.answers?.(call, spec)) ?? {};
      return await options.supervise({
        spec,
        entries: [...ctx.session.entries],
        agent: ctx.agent.id,
        session: ctx.session.header.id,
        call,
        answers,
        signal: ctx.signal
      });
    } catch (error) {
      const reason = `the check failed: ${firstLine(error)}`;
      return { spec: spec.id, callId: call.id, model: 'none', usage: { input: 0, output: 0 }, status: 'unavailable', reason };
    }
  }
}

/** The result the agent sees in place of a refused call: what failed, why, and what to do. */
export function refusal(spec: Spec, call: ToolCall, verdict: Verdict): ToolResult {
  if (verdict.status === 'unavailable') {
    const text =
      `The supervisor could not check this ${call.name} call, so it did not run: ${verdict.reason}. ` +
      'Try the call again later, or tell the person it is waiting.';
    return { content: [{ type: 'text', text }], isError: true };
  }
  // The analysis is the supervisor's words about the agent's material, and may quote it, so it is escaped like the material.
  const failed = failures(spec, verdict).map((item) => {
    const attrs = `id="${escapeAttr(item.id)}" title="${escapeAttr(item.title)}" severity="${item.severity}"`;
    const guidance = item.guidance === undefined ? '' : `\n<guidance>${escapeText(item.guidance)}</guidance>`;
    return `<failed_check ${attrs}>\n<analysis>${escapeText(item.analysis)}</analysis>${guidance}\n</failed_check>`;
  });
  const text = [
    `The supervisor stopped this ${call.name} call, so it did not run. ` +
      'Read what it found, fix every check that failed, then make the call again.',
    ...failed
  ].join('\n\n');
  return { content: [{ type: 'text', text }], isError: true };
}
