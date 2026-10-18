/**
 * Codemode: a `run_script` tool that lets the model write a short Python script which calls several
 * of the agent's tools and returns only what it needs, in one turn. The script runs in Monty inside
 * the shared worker process in `codemode/` at the repo root; this file starts that process and speaks
 * the JSON-lines protocol in docs/codemode.md to it. README.md explains the idea.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Plugin, Tool, ToolCall, ToolContext, ToolResult, ToolDefinition } from '@flatbed/core';

export type CodemodeOptions = {
  /** The tools a script may call, by name. A script cannot call any other tool. */
  tools: string[];
  /** The most tool calls one script may make. 25 unless set. */
  maxCalls?: number;
  /** How long one script may run, tool calls included, in milliseconds. 60 seconds unless set. */
  timeoutMs?: number;
  /** The most heap memory the script may use, in bytes. 64 MB unless set. */
  maxMemory?: number;
  /** A fixed time for the script's clock, for replay tests. The script sees the real clock unless set. */
  startTime?: Date;
  /** How to start the worker. `uv run` on `codemode/worker.py` unless set. */
  worker?: { command: string; args: string[] };
};

export const DEFAULT_MAX_CALLS = 25;
export const DEFAULT_TIMEOUT_MS = 60_000;
const WORKER_DIR = fileURLToPath(new URL('../../../codemode/', import.meta.url));

/** The worker command: `uv run` in the worker's own project, so its one dependency stays its own. */
export const defaultWorker = () => ({
  command: 'uv',
  args: ['run', '--quiet', '--frozen', '--project', WORKER_DIR, 'python', `${WORKER_DIR}worker.py`],
});

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });

/**
 * Adds codemode to a list of plugins. It returns the plugins with their `context` hooks wrapped, so
 * that codemode can see the tools they add, followed by the codemode plugin itself.
 *
 * Codemode needs the allowed tools' descriptions and schemas to write `run_script`'s description,
 * and a `context` hook sees nothing of the tools other plugins add. The calls themselves run through
 * the core, with `ctx.runTool`.
 */
export function withCodemode(plugins: Plugin[], options: CodemodeOptions): Plugin[] {
  const seen = new Map<string, ToolDefinition>();
  const wrapped = plugins.map((plugin): Plugin => {
    const { context } = plugin;
    if (context === undefined) return plugin;
    return {
      ...plugin,
      async context(ctx) {
        const added = await context.call(plugin, ctx);
        for (const tool of added?.tools ?? []) seen.set(tool.name, tool);
        return added;
      },
    };
  });
  return [...wrapped, codemodePlugin(seen, options)];
}

function codemodePlugin(seen: Map<string, ToolDefinition>, options: CodemodeOptions): Plugin {
  return {
    name: 'codemode',
    context() {
      const callable = options.tools.flatMap((name) => {
        const tool = seen.get(name);
        return tool === undefined ? [] : [tool];
      });
      return { tools: [runScriptTool(callable, options)] };
    },
  };
}

function runScriptTool(callable: ToolDefinition[], options: CodemodeOptions): Tool {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: 'run_script',
    description: describe(callable, maxCalls, timeoutMs),
    inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
    run: (input, ctx) => runScript(String(input.script), callable, options, ctx),
  };
}

/** The tool's description: what a script is for, its limits, and the tools as Python signatures. */
export function describe(tools: ToolDefinition[], maxCalls = DEFAULT_MAX_CALLS, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  const signatures = tools.map(signature).join('\n\n');
  return [
    'Run a short Python script that calls your tools, and get back what it prints and the value of its last line.',
    'Use it when a task needs several tool calls and you need only part of their results, such as reading several documents to find one fact.',
    'The script runs in a sandboxed subset of Python with no files, environment or network.',
    'Each tool below is an async function: await it, and use asyncio.gather to run calls at the same time.',
    'A tool returns its result as text, and raises RuntimeError with its message when it fails.',
    `A script may make at most ${maxCalls} tool calls and run for at most ${Math.round(timeoutMs / 1000)} seconds.`,
    '',
    'The tools a script can call:',
    '',
    '```python',
    signatures || '# None.',
    '```',
  ].join('\n');
}

const PY_TYPES: Record<string, string> = { string: 'str', integer: 'int', number: 'float', boolean: 'bool', array: 'list', object: 'dict' };

/** A tool as a Python signature, required parameters first, with its description as the docstring. */
export function signature(tool: ToolDefinition): string {
  const { required, optional } = params(tool);
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const typed = (name: string) => `${name}: ${PY_TYPES[properties[name]?.type ?? ''] ?? 'object'}`;
  const args = [...required.map(typed), ...optional.map((name) => `${typed(name)} = None`)].join(', ');
  const doc = tool.description.replaceAll('"""', '\\"\\"\\"');
  return `async def ${tool.name}(${args}) -> str:\n    """${doc}"""`;
}

function params(tool: ToolDefinition) {
  const names = Object.keys((tool.inputSchema.properties ?? {}) as object);
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  return { required: names.filter((n) => required.includes(n)), optional: names.filter((n) => !required.includes(n)) };
}

type WorkerMessage =
  | { type: 'call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; output: string; value: string | null }
  | { type: 'error'; output: string; error: string };

/** Runs one script in a fresh worker process, answering its calls, until it finishes or a limit ends it. */
async function runScript(script: string, callable: ToolDefinition[], options: CodemodeOptions, ctx: ToolContext): Promise<ToolResult> {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const worker = options.worker ?? defaultWorker();
  const scriptId = randomBytes(4).toString('hex');
  // Checked here as well as in the worker, so that a worker that misbehaves still reaches only these.
  const allowed = new Set(callable.map((tool) => tool.name));

  // An empty environment but for what `uv` needs to find itself and its cache: no keys reach the worker.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  // Its own process group, so that ending it ends Monty's interpreter process too.
  const child = spawn(worker.command, worker.args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  const send = (message: object) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return new Promise<ToolResult>((resolve) => {
    let calls = 0;
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onStop);
      child.stdin.end();
      killGroup(child.pid);
      resolve(result);
    };
    const timer = setTimeout(() => finish(text(`The script ran for more than ${timeoutMs / 1000} seconds, so it was stopped.`, true)), timeoutMs);
    const onStop = () => finish(text('The harness stopped this script.', true));
    if (ctx.signal.aborted) return onStop();
    ctx.signal.addEventListener('abort', onStop, { once: true });

    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      finish(text(missing ? `The codemode worker could not start: ${worker.command} was not found.` : `The codemode worker failed: ${error.message}`, true));
    });
    child.on('close', () => finish(text(`The codemode worker ended without finishing the script.${stderr ? `\n${stderr.trim()}` : ''}`, true)));

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line);
      } catch {
        return finish(text(`The codemode worker sent a line that is not JSON: ${line.slice(0, 200)}`, true));
      }
      if (message.type === 'done') return finish(text(joined(message.output, message.value) || 'The script returned nothing.'));
      if (message.type === 'error') return finish(text(joined(message.output, message.error), true));
      if (message.type !== 'call') return;
      calls += 1;
      if (calls > maxCalls) return finish(text(`The script made more than ${maxCalls} tool calls, so it was stopped.`, true));
      const call: ToolCall = { type: 'toolCall', id: `${scriptId}-${message.id}`, name: message.name, input: message.input };
      // The core runs the call as it runs the model's, under the turn's limit. A name off the
      // allow-list is as unknown as a name nobody has.
      void (async () => {
        const result = allowed.has(call.name) ? await ctx.runTool(call) : text(`No tool named ${call.name}.`, true);
        if (settled) return;
        await ctx.append({ type: 'custom', plugin: 'codemode', data: { call, result } }).catch(() => {});
        send({ type: 'result', id: message.id, text: result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), isError: result.isError });
      })();
    });

    send({
      type: 'start',
      script,
      tools: callable.map((tool) => ({ name: tool.name, params: [...params(tool).required, ...params(tool).optional] })),
      timeoutMs,
      ...(options.maxMemory === undefined ? {} : { maxMemory: options.maxMemory }),
      ...(options.startTime === undefined ? {} : { startTime: options.startTime.toISOString() }),
    });
  });
}

/** What the script printed, then its value or error on a line of its own. */
const joined = (output: string, last: string | null) => [output.replace(/\n$/, ''), last ?? ''].filter(Boolean).join('\n');

function killGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
