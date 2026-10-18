"""The codemode plugin, with the fake provider and the real worker process. Skipped without `uv`."""

import asyncio
import shutil
import time
import unittest

from flatbed import Agent, AgentConfig, ContextAddition, MemoryStore, Plugin, StopSignal, Tool
from flatbed.plugins.codemode import CodemodeOptions, with_codemode
from flatbed.providers import FauxProvider


def setup(script: str, on_slow=None, max_concurrent_tools: int = 4, **options):
    """An agent whose tools are `slow`, `read_doc` and `send_email`, with codemode allowed the first two."""
    spans: list[tuple[float, float]] = []
    sent: list[str] = []

    async def slow(tool_input, ctx):
        start = time.monotonic()
        if on_slow:
            on_slow()
        await asyncio.sleep(0.3)
        spans.append((start, time.monotonic()))
        return f"done {tool_input['label']}"

    def send_email(tool_input, ctx):
        sent.append(tool_input["to"])
        return "sent"

    def schema(name):
        return {"type": "object", "properties": {name: {"type": "string"}}, "required": [name]}

    tools = [
        Tool(
            name="slow", description="Wait a moment, then say done.", input_schema=schema("label"), run=slow
        ),
        Tool(
            name="read_doc",
            description="Read one of your documents by name.",
            input_schema=schema("name"),
            run=lambda tool_input, ctx: f"contents of {tool_input['name']}",
        ),
        Tool(name="send_email", description="Send an email.", input_schema=schema("to"), run=send_email),
    ]
    provider = Plugin(name="tools", context=lambda ctx: ContextAddition(tools=tools))

    # A guard, to show that nested calls pass through the agent's own hooks.
    def guard_before(call, ctx):
        if call["name"] == "read_doc" and call["input"].get("name") == "secret":
            return {"content": [{"type": "text", "text": "Refused."}], "isError": True}
        return None

    guard = Plugin(name="guard", before_tool=guard_before)
    plugins = with_codemode([provider, guard], CodemodeOptions(tools=["slow", "read_doc"], **options))
    faux = FauxProvider(
        [
            {
                "content": [
                    {"type": "toolCall", "id": "call_1", "name": "run_script", "input": {"script": script}}
                ]
            },
            {"content": [{"type": "text", "text": "Done."}]},
        ]
    )
    store = MemoryStore()
    agent = Agent(
        AgentConfig(
            id="coder", model="faux/test", plugins=plugins, max_concurrent_tools=max_concurrent_tools
        ),
        store=store,
        providers={"faux": faux},
    )
    agent.deliver({"kind": "message", "attrs": {"from": "Sam"}, "text": "Go."})

    async def entries():
        return (await store.read("coder", (await store.list("coder"))[0])).entries

    return agent, entries, faux, spans, sent


def script_result(entries):
    message = next(e["message"] for e in entries if e["type"] == "message" and e["message"]["role"] == "tool")
    return "".join(b["text"] for b in message["content"]), message["isError"]


def nested(entries):
    return [e["data"] for e in entries if e["type"] == "custom" and e["plugin"] == "codemode"]


@unittest.skipIf(shutil.which("uv") is None, "uv is not installed, so the codemode worker cannot run.")
class Codemode(unittest.IsolatedAsyncioTestCase):
    async def test_two_gathered_calls_run_at_once_through_the_hooks_and_are_recorded(self):
        agent, entries, faux, spans, _ = setup(
            "import asyncio\n"
            "a, b = await asyncio.gather(slow('a'), slow(label='b'))\n"
            "try:\n    await read_doc('secret')\nexcept RuntimeError as e:\n    print('guard said', e)\n"
            "[a, b]"
        )
        self.assertEqual(await agent.run(), "idle")
        found = await entries()
        self.assertEqual(script_result(found), ('guard said Refused.\n["done a", "done b"]', False))
        # Each started before the other ended.
        self.assertEqual(len(spans), 2)
        self.assertTrue(spans[0][0] < spans[1][1] and spans[1][0] < spans[0][1])
        self.assertEqual(
            [(n["call"]["name"], n["result"]["isError"]) for n in nested(found)],
            [("slow", False), ("slow", False), ("read_doc", True)],
        )
        description = next(t for t in faux.requests[0].tools if t["name"] == "run_script")["description"]
        self.assertIn("async def slow(label: str) -> str:", description)
        self.assertNotIn("send_email", description)

    async def test_gathered_calls_take_turns_when_the_agent_allows_one_call_at_a_time(self):
        agent, entries, _, spans, _ = setup(
            "import asyncio\nawait asyncio.gather(slow('a'), slow('b'))", max_concurrent_tools=1
        )
        self.assertEqual(await agent.run(), "idle")
        self.assertEqual(script_result(await entries()), ('["done a", "done b"]', False))
        # run_script gave up its place, so its calls could run, one after the other.
        first, second = sorted(spans)
        self.assertLessEqual(first[1], second[0])

    async def test_a_tool_off_the_allow_list_does_not_exist_inside_the_script(self):
        agent, entries, _, _, sent = setup("await send_email('someone@example.com')")
        await agent.run()
        text, is_error = script_result(await entries())
        self.assertTrue(is_error)
        self.assertIn("NameError: name 'send_email' is not defined", text)
        self.assertEqual(sent, [])

    async def test_a_script_that_makes_more_calls_than_the_limit_is_stopped(self):
        agent, entries, *_ = setup("for i in range(10):\n    await read_doc(str(i))", max_calls=3)
        await agent.run()
        found = await entries()
        self.assertEqual(
            script_result(found), ("The script made more than 3 tool calls, so it was stopped.", True)
        )
        self.assertEqual(len(nested(found)), 3)

    async def test_a_script_that_runs_past_its_deadline_is_stopped(self):
        agent, entries, *_ = setup("while True:\n    pass", timeout=1)
        started = time.monotonic()
        await agent.run()
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(
            script_result(await entries()),
            ("The script ran for more than 1 seconds, so it was stopped.", True),
        )

    async def test_a_stop_during_a_script_ends_the_script_and_the_run(self):
        stop = StopSignal()
        loop = asyncio.get_running_loop()
        agent, entries, *_ = setup(
            "await slow('a')\nwhile True:\n    pass", on_slow=lambda: loop.call_later(0.05, stop.set, "Sam")
        )
        self.assertEqual(await agent.run(signal=stop), "stopped")
        found = await entries()
        self.assertEqual(script_result(found), ("The harness stopped this script.", True))
        self.assertEqual(found[-1]["text"], "Stopped by Sam.")

    async def test_an_error_in_a_script_comes_back_with_what_it_printed_first(self):
        agent, entries, *_ = setup("print('before')\n1 / 0")
        await agent.run()
        text, is_error = script_result(await entries())
        self.assertTrue(is_error)
        self.assertTrue(text.startswith("before\n"))
        self.assertIn("ZeroDivisionError: division by zero", text)
