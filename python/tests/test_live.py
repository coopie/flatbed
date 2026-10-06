"""One live run through Anthropic. Skipped unless FLATBED_LIVE=1, so the ordinary run is fast and free.

The key comes from ANTHROPIC_API_KEY in .env at the repo root, and is never printed.
"""

import os
import unittest

from flatbed import Agent, ContextAddition, MemoryStore, Plugin, Runner, Tool
from flatbed.env import read_env
from flatbed.providers import AnthropicProvider

LIVE = os.environ.get("FLATBED_LIVE") == "1"


@unittest.skipUnless(LIVE, "set FLATBED_LIVE=1 to call Anthropic")
class LiveAnthropic(unittest.TestCase):
    def test_the_model_calls_a_tool_and_answers(self):
        api_key = read_env("ANTHROPIC_API_KEY")
        if not api_key:
            self.skipTest("no ANTHROPIC_API_KEY in .env")
        echo = Tool(
            name="echo",
            description="Echo the text you give it. Call it when asked to echo something.",
            input_schema={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
            run=lambda tool_input, ctx: tool_input["text"],
        )
        plugin = Plugin(
            name="live",
            context=lambda ctx: ContextAddition(
                sections=[
                    {"name": "soul", "text": "You are a test agent. Keep answers short.", "cache": True}
                ],
                tools=[echo],
            ),
        )
        store = MemoryStore()
        agent = Agent(id="live", model="anthropic/claude-sonnet-5-5", plugins=[plugin])
        runner = Runner(agent, store, {"anthropic": AnthropicProvider(api_key)})
        runner.deliver({"kind": "message", "attrs": {"from": "Ana"}, "text": "Please echo the word pumpkin."})

        self.assertEqual(runner.run(), "idle")
        entries = store.read("live", store.list("live")[-1]).entries
        results = [e["message"] for e in entries if e["type"] == "message" and e["message"]["role"] == "tool"]
        self.assertEqual(results[0]["content"][0]["text"].lower(), "pumpkin")
        self.assertEqual(entries[-1]["message"]["stop"], "end")


if __name__ == "__main__":
    unittest.main()
