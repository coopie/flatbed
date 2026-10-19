# @flatbed/dispatch

Use this plugin to let an agent hand a piece of work to a sub-agent and hear back, such as research that would fill the agent's own session with pages it will never need again. The plugin adds a `dispatch` tool. The agent passes a brief and, optionally, which sub-agent to use and whether to wait.

A sub-agent is an ordinary flatbed agent, made fresh for each dispatch, with its own sessions in the same store. Its id is the dispatching agent's id, a dot, the sub-agent's name and four hex characters, such as `assistant.researcher-3f0c`. Its first session's header links back to the dispatching agent, its session and the assistant message that made the call, with `reason: "dispatch"`, through the core's agent `parent`. The plugin also keeps a `custom` entry in the dispatching session with the sub-agent's id and the brief, so you can follow the link either way.

The sub-agent sees its configured sections and then the brief, in a `brief` section. It gets one extra tool, `report`, which ends its work with an answer. The message that starts it says that `report` is the only way its answer reaches the agent that dispatched it. Only a report is a success: a sub-agent that ends any other way, such as by a reset, a stop or a last message with no report, gives an error that says how it ended and quotes its last text.

- **Waiting**, the default: the tool runs the sub-agent to the end and returns its report. When the dispatching run is stopped, the stop reaches the sub-agent too.
- **Not waiting**: the tool returns at once. When the sub-agent finishes, the plugin delivers a `dispatch_result` event to the dispatching agent, with the sub-agent's id and `status` (`reported`, `stopped` or `failed`) as attributes and the answer as its text. Then it calls your `wake(agentId)`, so you can run that agent again. The event waits in the queue of the agent object that made the call, so it arrives on that object's next run, or during the current one if it is still running. When your host makes a new agent object for each run, the event is lost: keep one agent object per agent for as long as it may have sub-agents working.

Each dispatch runs one session of the sub-agent. Its `softLimit` and `hardLimit` bound that session's size, as for any agent. `maxDepth` bounds how deep sub-agents go: at the default of 1, sub-agents get no `dispatch` tool, and at 2 they can dispatch once more.

## Set it up

```ts
import { createAgent, anthropicProvider } from '@flatbed/core';
import { fileStore } from '@flatbed/core/node';
import { dispatchPlugin } from '@flatbed/dispatch';

const store = fileStore('data/sessions');
const providers = { anthropic: anthropicProvider({ apiKey }) };

const dispatch = dispatchPlugin({
  agents: [
    {
      name: 'researcher',
      description: 'Reads around a question and reports what it found, with sources.',
      model: 'anthropic/claude-sonnet-5-5',
      sections: [{ name: 'soul', text: 'You research one question for another agent. Report what you found and where.' }],
      plugins: [webSearch],
      hardLimit: 60_000,
    },
  ],
  store,
  providers,
  // Run the dispatching agent again when a sub-agent it did not wait for reports.
  wake: (agentId) => runSoon(agentId),
});

const agent = createAgent({ id: 'assistant', model: 'anthropic/claude-opus-5-5', plugins: [dispatch] }, { store, providers });
```

Your `wake` may be called while that agent is still running, and `run` throws when the agent is already running. Queue the run, as `runSoon` does here, rather than calling `run` straight away.

## Tests

From this folder, `node --test "*.test.ts"`. The tests use the faux provider and need no network.
