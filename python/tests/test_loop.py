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

    def test_a_bad_setting_fails_at_once_in_the_words_host_md_gives(self):
        faux = FauxProvider([])

        def fails(config: AgentConfig, message: str) -> None:
            with self.assertRaises(ValueError) as caught:
                Agent(config, store=MemoryStore(), providers={"faux": faux})
            self.assertEqual(str(caught.exception), message)

        fails(AgentConfig(id="a", model="none/test"), "No provider named none for the model none/test.")
        fails(
            AgentConfig(id="a", model="faux/test", max_concurrent_tools=0),
            "max_concurrent_tools must be at least 1, not 0.",
        )
        fails(
            AgentConfig(id="a", model="faux/test", tool_execution="parallel"),  # type: ignore[arg-type]
            "tool_execution must be concurrent or serial, not parallel.",
        )


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

        self.assertEqual(await asyncio.wait_for(agent.run(signal=stop), 0.3), "stopped")
        entries = (await store.read("a", (await store.list("a"))[0])).entries
        self.assertEqual(entries[-1]["text"], "Stopped by Sam.")

    async def test_every_hook_sees_the_stop_and_a_stop_with_no_name_is_by_the_host(self):
        stop = StopSignal()
        seen: list[bool] = []

        def wait(tool_input, ctx):
            stop.set()
            return "Stopped."

        tool = Tool(name="wait", description="Stop the run.", input_schema={"type": "object"}, run=wait)

        def context(ctx):
            seen.append(ctx.signal is stop)
            return ContextAddition(tools=[tool])

        plugin = Plugin(
            name="test", context=context, on_entry=lambda entry, ctx: seen.append(ctx.signal is stop)
        )
        call = {"type": "toolCall", "id": "c1", "name": "wait", "input": {}}
        store = MemoryStore()
        agent = Agent(
            AgentConfig(id="a", model="faux/test", plugins=[plugin]),
            store=store,
            providers={"faux": FauxProvider([{"content": [call]}])},
        )
        agent.deliver({"kind": "message", "text": "Wait"})

        self.assertEqual(await agent.run(signal=stop), "stopped")
        self.assertTrue(len(seen) > 1 and all(seen))
        entries = (await store.read("a", (await store.list("a"))[0])).entries
        self.assertEqual(entries[-1]["text"], "Stopped by the host.")

    async def test_the_first_to_stop_is_the_one_recorded(self):
        stop = StopSignal()
        stop.set("Sam")
        stop.set("Ana")
        self.assertEqual(stop.who, "Sam")
        self.assertTrue(await stop.wait(0))


if __name__ == "__main__":
    unittest.main()
