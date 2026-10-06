"""The conformance runner, as docs/spec/conformance.md describes.

Runs every scenario in conformance/scenarios/ against a temporary file store with an agent named
`test`, and prints `ok <name>` or `FAIL <name>: <first difference>` for each. Exits 1 on any failure.

    uv run python conformance.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from flatbed import Agent, ContextAddition, FileStore, Plugin, Runner, StopSignal, Tool, path_of
from flatbed.providers import FauxProvider
from flatbed.store import new_entry_id, now_iso

SCENARIOS = Path(__file__).resolve().parent.parent / "conformance" / "scenarios"


def make_tool(spec: dict[str, Any]) -> Tool:
    behaviour = spec["behaviour"]

    def run(tool_input: dict[str, Any], ctx: Any) -> str:
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


def make_plugin(scenario: dict[str, Any]) -> Plugin:
    """The test plugin: the scenario's sections and tools, and any hooks its `plugin` field gives."""
    tools = [make_tool(spec) for spec in scenario["tools"]]
    hooks = scenario.get("plugin") or {}
    before, after = hooks.get("beforeTool", {}), hooks.get("afterTool", {})

    def on_entry(entry: dict[str, Any], ctx: Any) -> None:
        if entry["type"] == "message" and entry["message"]["role"] == "tool":
            ctx.append({"type": "custom", "plugin": "test", "data": hooks["onEntry"]["custom"]})

    return Plugin(
        name="test",
        context=lambda ctx: ContextAddition(sections=scenario["sections"], tools=tools),
        before_tool=(lambda call, ctx: before.get(call["name"])) if before else None,
        after_tool=(lambda call, result, ctx: after.get(call["name"])) if after else None,
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


def run_scenario(scenario: dict[str, Any], root: Path) -> str | None:
    """Runs one scenario and returns its first difference, or None when it passes."""
    store = FileStore(root)
    spec = scenario["agent"]
    agent = Agent(
        id="test",
        model=spec["model"],
        plugins=[make_plugin(scenario)],
        soft_limit=spec["softLimit"],
        hard_limit=spec["hardLimit"],
        max_tokens=spec.get("maxTokens", 8_192),
    )
    faux = FauxProvider(
        [abort_step(step["abort"]) if "abort" in step else step for step in scenario["script"]]
    )
    runner = Runner(agent, store, {"faux": faux})
    rewind_to: str | None = None
    rewind_targets: set[str] = set()

    for index, step in enumerate(scenario["steps"]):
        if "deliver" in step:
            runner.deliver(step["deliver"], rewind_to)
            rewind_to = None
        elif "run" in step:
            stop = StopSignal()
            if "stop" in step["run"]:
                stop.set(step["run"]["stop"])
            outcome = runner.run(stop)
            if "expect" in step and outcome != step["expect"]:
                return f"step {index} ended {outcome}, expected {step['expect']}"
        elif "crash" in step:
            # Append straight to the newest session, as a crashed process would have.
            newest = store.list("test")[-1]
            entries = store.read("test", newest).entries
            entry = {
                "type": step["crash"]["type"],
                "id": new_entry_id(),
                "parentId": entries[-1]["id"],
                "at": now_iso(),
            }
            entry.update(step["crash"])
            store.append("test", newest, entry)
        elif "rewind" in step:
            path = path_of(store.read("test", store.list("test")[-1]).entries)
            rewind_to = path[step["rewind"]]["id"]
            rewind_targets.add(rewind_to)
        else:
            raise ValueError(f"Unknown step {step}.")

    expected_sessions = scenario["expect"]["sessions"]
    ids = store.list("test")
    if len(ids) != len(expected_sessions):
        return f"there are {len(ids)} sessions, expected {len(expected_sessions)}"
    for number, (session_id, expected) in enumerate(zip(ids, expected_sessions, strict=True)):
        session = store.read("test", session_id)
        if expected and "header" in expected[0]:
            want = expected[0]["header"]["parent"]["reason"]
            got = session.header.get("parent", {}).get("reason")
            if got != want:
                return f"session {number} header parent reason is {got}, expected {want}"
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

    if "requests" in scenario["expect"]:
        received = [request.messages for request in faux.requests]
        if found := first_difference(scenario["expect"]["requests"], received, "requests"):
            return found
    return None


def main() -> int:
    failures = 0
    for path in sorted(SCENARIOS.glob("*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as root:
            try:
                difference = run_scenario(scenario, Path(root))
            except Exception as error:
                difference = f"raised {type(error).__name__}: {error}"
        if difference is None:
            print(f"ok {scenario['name']}")
        else:
            failures += 1
            print(f"FAIL {scenario['name']}: {difference}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
