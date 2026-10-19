/**
 * A rough CLI for trying the core by hand. It is a one-off tool, not part of the core: no tests,
 * few checks, and output shaped for reading rather than parsing.
 *
 *   node ts/packages/core/cli.ts chat <agent>          talk to an agent in the terminal
 *   node ts/packages/core/cli.ts view <session-file>   print a session as the model sees it
 *
 * `chat` keeps sessions under `data/` at the repo root. It uses the model in FLATBED_MODEL, which
 * defaults to `anthropic/claude-sonnet-5-5`; `faux/echo` answers offline by echoing you. Keys come
 * from .env at the repo root: ANTHROPIC_API_KEY, and OPENAI_API_KEY with an optional OPENAI_BASE_URL.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readEnv } from './env.ts';
import { createAgent } from './loop.ts';
import { anthropicProvider } from './providers/anthropic.ts';
import { fauxProvider } from './providers/faux.ts';
import { openaiProvider } from './providers/openai.ts';
import { pathOf, render } from './render.ts';
import { fileStore } from './file-store.ts';
import { parseSession } from './store.ts';
import type { Block, Message, Plugin, Provider } from './types.ts';

const DATA = fileURLToPath(new URL('../../../data/', import.meta.url));

function blockText(block: Block): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'toolCall') return `[call ${block.name} ${JSON.stringify(block.input)}]`;
  if (block.type === 'thinking') return `[thinking] ${block.text}`;
  return `[image ${block.mimeType}]`;
}

function messageText(message: Message): string {
  if (message.role === 'tool') return `--- tool ${message.name}${message.isError ? ' (error)' : ''}\n${message.content.map(blockText).join('\n')}`;
  const head = message.role === 'assistant' ? `--- assistant (${message.model}, stop ${message.stop})` : '--- user';
  return `${head}\n${message.content.map(blockText).join('\n')}`;
}

async function chat(agentId: string) {
  const model = process.env.FLATBED_MODEL ?? 'anthropic/claude-sonnet-5-5';
  const providers: Record<string, Provider> = {
    // An offline stand-in: echoes the last thing said, for as long as you like.
    faux: fauxProvider(Array.from({ length: 1000 }, () => (request) => {
      const last = request.messages.at(-1);
      const text = last?.role === 'user' ? last.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ') : '';
      return { content: [{ type: 'text', text: `You said: ${text}` }] };
    })),
  };
  const anthropicKey = await readEnv('ANTHROPIC_API_KEY');
  if (anthropicKey) providers.anthropic = anthropicProvider({ apiKey: anthropicKey });
  const openaiKey = await readEnv('OPENAI_API_KEY');
  if (openaiKey) providers.openai = openaiProvider({ apiKey: openaiKey, baseUrl: await readEnv('OPENAI_BASE_URL') });

  const printer: Plugin = {
    name: 'printer',
    context: () => ({ sections: [{ name: 'soul', text: `You are ${agentId}, talking with a person in a terminal. Keep answers short.`, cache: true }] }),
    onEntry(entry) {
      if (entry.type === 'message' && entry.message.role === 'assistant' && entry.message.content.length > 0) console.log(entry.message.content.map(blockText).join('\n'));
      if (entry.type === 'message' && entry.message.role === 'tool') console.log(`[${entry.message.name}: ${entry.message.content.map(blockText).join(' ')}]`);
      if (entry.type === 'event' && entry.kind === 'notice') console.log(`[notice] ${entry.text}`);
      if (entry.type === 'reset') console.log(`[reset by ${entry.by}${entry.reason ? `: ${entry.reason}` : ''}]`);
    },
  };
  const agent = createAgent({ id: agentId, model, plugins: [printer] }, { store: fileStore(DATA), providers });
  const terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  console.log(`Talking to ${agentId} on ${model}. Sessions are in ${DATA}${agentId}/. Press Ctrl-D to leave.`);
  terminal.prompt();
  for await (const line of terminal) {
    if (line.trim() !== '') {
      agent.deliver({ kind: 'message', attrs: { from: process.env.USER ?? 'you' }, text: line });
      await agent.run();
    }
    terminal.prompt();
  }
}

async function view(file: string) {
  const session = parseSession(await readFile(file, 'utf8'));
  const { context, messages } = render(pathOf(session.entries));
  console.log(`session ${session.header.id} of ${session.header.agent}${session.header.parent ? `, after ${session.header.parent.session} (${session.header.parent.reason})` : ''}`);
  for (const section of context.sections) console.log(`--- section ${section.name}${section.cache ? ' (cache)' : ''}\n${section.text}`);
  console.log(`--- tools: ${context.tools.map((t) => t.name).join(', ')}`);
  for (const message of messages) console.log(messageText(message));
}

const [command, arg] = process.argv.slice(2);
if (command === 'chat' && arg) await chat(arg);
else if (command === 'view' && arg) await view(arg);
else {
  console.error('Usage: cli.ts chat <agent> | cli.ts view <session-file>');
  process.exitCode = 2;
}
