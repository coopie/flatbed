"""The conformance runner, as docs/spec/conformance.md describes.

Runs every scenario in conformance/scenarios/ against a temporary file store with an agent named
`test`, and prints `ok <name>` or `FAIL <name>: <first difference>` for each. Exits 1 on any failure.

    uv run python conformance.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from flatbed import Agent, AgentConfig, ContextAddition, FileStore, Plugin, StopSignal, Tool, path_of
from flatbed.providers import FauxProvider
from flatbed.store import new_entry_id, new_session_id, now_iso

SCENARIOS = Path(__file__).resolve().parent.parent / "conformance" / "scenarios"


class Running:
    """Counts the tool calls running at once, for `expect.maxRunning`."""

    def __init__(self) -> None:
        self.now = 0
        self.most = 0


def make_tool(spec: dict[str, Any], running: Running) -> Tool:
    behaviour = spec["behaviour"]

    async def run(tool_input: dict[str, Any], ctx: Any) -> str:
        running.now += 1
        running.most = max(running.most, running.now)
        try:
            return await behave(tool_input, ctx)
        finally:
            running.now -= 1

    async def behave(tool_input: dict[str, Any], ctx: Any) -> str:
        if "sleep" in behaviour:
            await asyncio.sleep(behaviour["sleep"] / 1000)
            return behaviour["text"]
        if "waitForStop" in behaviour:
            await ctx.signal.wait()
            return behaviour["waitForStop"]
        if "echo" in behaviour:
            return str(tool_input[behaviour["echo"]])
        if "text" in behaviour:
            return behaviour["text"]
        if "error" in behaviour:
            raise RuntimeError(behaviour["error"])
        if "reset" in behaviour:
            ctx.request_reset(behaviour["reset"])
            return "Session will reset after this turn."
        if "deliver" in behaviour:
            ctx.deliver(behaviour["deliver"])
            return "Delivered."
        raise ValueError(f"Unknown behaviour {behaviour}.")

    return Tool(name=spec["name"], description=spec["description"], input_schema=spec["inputSchema"], run=run)


def make_plugin(scenario: dict[str, Any], running: Running) -> Plugin:
    """The test plugin: the scenario's sections and tools, and any hooks its `plugin` field gives."""
    tools = [make_tool(spec, running) for spec in scenario["tools"]]
    hooks = scenario.get("plugin") or {}
    before, after = hooks.get("beforeTool", {}), hooks.get("afterTool", {})

    def hook_result(result: Any) -> Any:
        # `{"throw": "<message>"}` makes the hook throw instead of returning a result.
        if result is not None and "throw" in result:
            raise RuntimeError(result["throw"])
        return result

    async def on_entry(entry: dict[str, Any], ctx: Any) -> None:
        if entry["type"] == "message" and entry["message"]["role"] == "tool":
            await ctx.append({"type": "custom", "plugin": "test", "data": hooks["onEntry"]["custom"]})

    return Plugin(
        name="test",
        context=lambda ctx: ContextAddition(sections=scenario["sections"], tools=tools),
        before_tool=(lambda call, ctx: hook_result(before.get(call["name"]))) if before else None,
        after_tool=(lambda call, result, ctx: hook_result(after.get(call["name"]))) if after else None,
        on_entry=on_entry if "onEntry" in hooks else None,
        on_session_end=(
            (lambda session, ctx: ctx.deliver(hooks["onSessionEnd"]["deliver"]))
            if "onSessionEnd" in hooks
            else None
        ),
    )


def abort_step(who: str) -> Any:
    """A scripted step that sets the stop signal while the call is in flight, then fails the call."""

    def step(request: Any) -> Any:
        request.signal.set(who)
        raise RuntimeError("The request was cancelled.")

    return step


def hang_step(release: asyncio.Event) -> Any:
    """A scripted step that never answers and ignores the stop, and even its own cancellation, until the
    scenario is over. The run ends only if the loop abandons the call."""

    async def step(request: Any) -> Any:
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                continue
        return {"content": [{"type": "text", "text": "The scenario is over."}]}

    return step


def first_difference(expected: Any, actual: Any, where: str = "") -> str | None:
    """Where two JSON values first differ, as a path such as `[1].message.content`, or None."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(expected.keys() | actual.keys()):
            if key not in actual:
                return f"{where}.{key} is missing"
            if key not in expected:
                return f"{where}.{key} is unexpected: {json.dumps(actual[key])}"
            if found := first_difference(expected[key], actual[key], f"{where}.{key}"):
                return found
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        for index, (want, got) in enumerate(zip(expected, actual, strict=False)):
            if found := first_difference(want, got, f"{where}[{index}]"):
                return found
        if len(expected) != len(actual):
            return f"{where} has {len(actual)} items, expected {len(expected)}"
        return None
    if expected != actual or type(expected) is not type(actual):
        return f"{where or 'value'} is {json.dumps(actual)}, expected {json.dumps(expected)}"
    return None


async def run_scenario(scenario: dict[str, Any], root: Path) -> str | None:
    """Runs one scenario and returns its first difference, or None when it passes."""
    release = asyncio.Event()
    try:
        return await check_scenario(scenario, root, release)
    finally:
        # Let a hanging call the loop abandoned finish, so that nothing is left running.
        release.set()


async def check_scenario(scenario: dict[str, Any], root: Path, release: asyncio.Event) -> str | None:
    store = FileStore(root)
    spec = scenario["agent"]
    running = Running()
    config = AgentConfig(
        id="test",
        model=spec["model"],
        plugins=[make_plugin(scenario, running)],
        soft_limit=spec["softLimit"],
        hard_limit=spec["hardLimit"],
        max_tokens=spec.get("maxTokens", 8_192),
        effort=spec.get("effort"),
        tool_execution=spec.get("toolExecution", "concurrent"),
        max_concurrent_tools=spec.get("maxConcurrentTools", 4),
        parent=spec.get("parent"),
    )
    steps = []
    for step in scenario["script"]:
        if "abort" in step:
            steps.append(abort_step(step["abort"]))
        elif step.get("hang"):
            steps.append(hang_step(release))
        else:
            steps.append(step)
    faux = FauxProvider(steps)
    agent = Agent(config, store=store, providers={"faux": faux})
    rewind_to: str | None = None
    rewind_targets: set[str] = set()

    for index, step in enumerate(scenario["steps"]):
        if "deliver" in step:
            agent.deliver(step["deliver"], parent_id=rewind_to)
            rewind_to = None
        elif "run" in step:
            if found := await run_step(agent, step, index):
                return found
        elif "crash" in step:
            # Append straight to the newest session, as a crashed process would have.
            newest = (await store.list("test"))[-1]
            entries = (await store.read("test", newest)).entries
            entry = {
                "type": step["crash"]["type"],
                "id": new_entry_id(),
                "parentId": entries[-1]["id"],
                "at": now_iso(),
            }
            entry.update(step["crash"])
            await store.append("test", newest, entry)
        elif "header" in step:
            # Only the header of a new session, as a process that stopped before its context entry left.
            ids = await store.list("test")
            now = datetime.now(UTC)
            header: Any = {
                "type": "session",
                "version": 1,
                "id": new_session_id(now, ids[-1] if ids else None),
                "agent": "test",
                "createdAt": now_iso(),
            }
            if ids:
                header["parent"] = {"session": ids[-1], "reason": "reset"}
            await store.create(header)
        elif "rewind" in step:
            path = path_of((await store.read("test", (await store.list("test"))[-1])).entries)
            rewind_to = path[step["rewind"]]["id"]
            rewind_targets.add(rewind_to)
        else:
            raise ValueError(f"Unknown step {step}.")

    expected_sessions = scenario["expect"]["sessions"]
    ids = await store.list("test")
    if len(ids) != len(expected_sessions):
        return f"there are {len(ids)} sessions, expected {len(expected_sessions)}"
    for number, (session_id, expected) in enumerate(zip(ids, expected_sessions, strict=True)):
        session = await store.read("test", session_id)
        if expected and "header" in expected[0]:
            want = expected[0]["header"]["parent"]
            got = session.header.get("parent")
            # A scenario cannot know the id of a session the loop made, so it may leave `session` out.
            if got is not None and "session" not in want:
                got = {k: v for k, v in got.items() if k != "session"}
            if found := first_difference(want, got, f"session {number} header parent"):
                return found
            expected = expected[1:]
        previous = None
        for position, entry in enumerate(session.entries):
            rewound = entry["type"] == "event" and entry["parentId"] in rewind_targets
            if entry["parentId"] != previous and not rewound:
                return (
                    f"session {number} entry {position} has parentId {entry['parentId']}, expected {previous}"
                )
            previous = entry["id"]
        stripped = [
            {k: v for k, v in entry.items() if k not in ("id", "parentId", "at")} for entry in session.entries
        ]
        if found := first_difference(expected, stripped, f"session {number}"):
            return found

    expected_requests = scenario["expect"].get("requests")
    if expected_requests is not None:
        if len(faux.requests) != len(expected_requests):
            return f"the model received {len(faux.requests)} requests, expected {len(expected_requests)}"
        for number, (want, request) in enumerate(zip(expected_requests, faux.requests, strict=True)):
            # An item is the messages alone, or an object naming the parts of the request to compare.
            got = request_parts(request, want) if isinstance(want, dict) else request.messages
            if found := first_difference(want, got, f"requests[{number}]"):
                return found

    if "maxRunning" in scenario["expect"] and running.most != scenario["expect"]["maxRunning"]:
        return f"at most {running.most} tool calls ran at once, expected {scenario['expect']['maxRunning']}"
    return None


async def run_step(agent: Agent, step: dict[str, Any], index: int) -> str | None:
    """Runs the agent for a `run` step, with the stop it asks for, and checks the outcome."""
    stop = StopSignal()
    timer = None
    if "stop" in step["run"]:
        if "stopAfter" in step["run"]:
            # Set from another thread, as a host may, since a stop must work from anywhere.
            timer = threading.Timer(step["run"]["stopAfter"] / 1000, stop.set, [step["run"]["stop"]])
            timer.start()
        else:
            stop.set(step["run"]["stop"])
    expected = step.get("expect")
    try:
        outcome = await agent.run(stop=stop)
    except Exception as error:
        if isinstance(expected, dict) and str(error) == expected.get("error"):
            return None
        raise
    finally:
        if timer is not None:
            timer.cancel()
    if expected is not None and outcome != expected:
        return f"step {index} ended {outcome}, expected {json.dumps(expected)}"
    return None


def request_parts(request: Any, want: dict[str, Any]) -> dict[str, Any]:
    """The parts of a request the scenario names, by their spec names."""
    parts = {
        "messages": request.messages,
        "sections": request.sections,
        "tools": request.tools,
        "maxTokens": request.max_tokens,
        "effort": request.effort,
    }
    return {name: parts[name] for name in want if name in parts}


async def main() -> int:
    failures = 0
    for path in sorted(SCENARIOS.glob("*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as root:
            try:
                difference = await run_scenario(scenario, Path(root))
            except Exception as error:
                difference = f"raised {type(error).__name__}: {error}"
        if difference is None:
            print(f"ok {scenario['name']}")
        else:
            failures += 1
            print(f"FAIL {scenario['name']}: {difference}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
