"""The loop's behaviour that the conformance suite cannot express, such as how many calls run at once."""

import asyncio
import unittest

from flatbed import Agent, ContextAddition, MemoryStore, Plugin, Runner, StopSignal, Tool
from flatbed.providers import FauxProvider


class ConcurrentTools(unittest.IsolatedAsyncioTestCase):
    async def test_no_more_than_the_limit_run_at_once_and_results_keep_call_order(self):
        active = most = 0

        async def wait(tool_input, ctx):
            nonlocal active, most
            active += 1
            most = max(most, active)
            # Later calls finish first, so that call order and finishing order differ.
            await asyncio.sleep(0.02 - tool_input["n"] * 0.003)
            active -= 1
            return f"done {tool_input['n']}"

        tool = Tool(name="wait", description="Wait a moment.", input_schema={"type": "object"}, run=wait)
        calls = [{"type": "toolCall", "id": f"c{n}", "name": "wait", "input": {"n": n}} for n in range(5)]
        plugin = Plugin(name="test", context=lambda ctx: ContextAddition(tools=[tool]))
        faux = FauxProvider([{"content": calls}, {"content": [{"type": "text", "text": "Done."}]}])
        store = MemoryStore()
        agent = Agent(id="a", model="faux/test", plugins=[plugin], max_concurrent_tools=2)
        runner = Runner(agent, store, {"faux": faux})
        runner.deliver({"kind": "message", "text": "Go"})

        self.assertEqual(await runner.run(), "idle")
        self.assertEqual(most, 2)
        entries = store.read("a", store.list("a")[0]).entries
        texts = [
            e["message"]["content"][0]["text"] for e in entries if e.get("message", {}).get("role") == "tool"
        ]
        self.assertEqual(texts, [f"done {n}" for n in range(5)])


class Stopping(unittest.IsolatedAsyncioTestCase):
    async def test_a_stop_cancels_a_model_call_in_flight(self):
        stop = StopSignal()

        class Slow:
            async def complete(self, request):
                stop.set("Sam")
                await asyncio.sleep(60)

        store = MemoryStore()
        runner = Runner(Agent(id="a", model="slow/test"), store, {"slow": Slow()})
        runner.deliver({"kind": "message", "text": "Hello"})

        self.assertEqual(await asyncio.wait_for(runner.run(stop), 5), "stopped")
        entries = store.read("a", store.list("a")[0]).entries
        self.assertEqual(entries[-1]["text"], "Stopped by Sam.")


if __name__ == "__main__":
    unittest.main()
