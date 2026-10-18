"""The loop's behaviour that the conformance suite cannot express, such as the order calls finish in,
or a stop set from another thread."""

import asyncio
import threading
import unittest

from flatbed import Agent, AgentConfig, ContextAddition, MemoryStore, Plugin, StopSignal, Tool
from flatbed.providers import FauxProvider


async def tool_texts(store: MemoryStore, agent_id: str) -> list[str]:
    entries = (await store.read(agent_id, (await store.list(agent_id))[0])).entries
    return [e["message"]["content"][0]["text"] for e in entries if e.get("message", {}).get("role") == "tool"]


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
        config = AgentConfig(id="a", model="faux/test", plugins=[plugin], max_concurrent_tools=2)
        agent = Agent(config, store=store, providers={"faux": faux})
        agent.deliver({"kind": "message", "text": "Go"})

        self.assertEqual(await agent.run(), "idle")
        self.assertEqual(most, 2)
        self.assertEqual(await tool_texts(store, "a"), [f"done {n}" for n in range(5)])

    def test_a_bad_setting_fails_before_anything_is_stored(self):
        faux = FauxProvider([])
        with self.assertRaises(ValueError):
            Agent(
                AgentConfig(id="a", model="faux/test", max_concurrent_tools=0),
                store=MemoryStore(),
                providers={"faux": faux},
            )
        with self.assertRaises(ValueError):
            Agent(AgentConfig(id="a", model="none/test"), store=MemoryStore(), providers={"faux": faux})


class Stopping(unittest.IsolatedAsyncioTestCase):
    async def test_a_stop_from_another_thread_ends_a_model_call_that_ignores_it(self):
        stop = StopSignal()

        class Deaf:
            async def complete(self, request):
                threading.Timer(0.01, stop.set, ["Sam"]).start()
                # Ignores the signal and its own cancellation for a while.
                try:
                    await asyncio.sleep(60)
                except asyncio.CancelledError:
                    await asyncio.sleep(0.5)

        store = MemoryStore()
        agent = Agent(AgentConfig(id="a", model="deaf/test"), store=store, providers={"deaf": Deaf()})
        agent.deliver({"kind": "message", "text": "Hello"})

        self.assertEqual(await asyncio.wait_for(agent.run(stop=stop), 0.3), "stopped")
        entries = (await store.read("a", (await store.list("a"))[0])).entries
        self.assertEqual(entries[-1]["text"], "Stopped by Sam.")

    async def test_the_first_to_stop_is_the_one_recorded(self):
        stop = StopSignal()
        stop.set("Sam")
        stop.set("Ana")
        self.assertEqual(stop.who, "Sam")
        self.assertTrue(await stop.wait(0))


if __name__ == "__main__":
    unittest.main()
