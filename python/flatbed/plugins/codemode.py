"""Codemode: a `run_script` tool that lets the model write a short Python script which calls several of
the agent's tools and returns only what it needs, in one turn.

The script runs in Monty inside the shared worker process in `codemode/` at the repo root; this module
starts that process and speaks the JSON-lines protocol in docs/codemode.md to it. The TypeScript
package's README, ts/packages/codemode/README.md, explains the idea.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import signal
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from ..loop import error_result, message_of, settled
from ..types import ContextAddition, Plugin, Tool, ToolCall, ToolContext, ToolDefinition, ToolResult

DEFAULT_MAX_CALLS = 25
DEFAULT_TIMEOUT = 60.0
WORKER_DIR = Path(__file__).resolve().parents[3] / "codemode"


@dataclass
class CodemodeOptions:
    # The tools a script may call, by name. A script cannot call any other tool.
    tools: list[str]
    # The most tool calls one script may make.
    max_calls: int = DEFAULT_MAX_CALLS
    # How long one script may run, tool calls included, in seconds.
    timeout: float = DEFAULT_TIMEOUT
    # The most heap memory the script may use, in bytes. 64 MB when not set.
    max_memory: int | None = None
    # A fixed time for the script's clock, for replay tests. The script sees the real clock when not set.
    start_time: datetime | None = None
    # How to start the worker. `uv run` on `codemode/worker.py` when not set.
    worker: list[str] | None = None


def default_worker() -> list[str]:
    """`uv run` in the worker's own project, so that its one dependency stays its own."""
    project = str(WORKER_DIR)
    return ["uv", "run", "--quiet", "--frozen", "--project", project, "python", str(WORKER_DIR / "worker.py")]


def text_result(text: str, is_error: bool = False) -> ToolResult:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def with_codemode(plugins: list[Plugin], options: CodemodeOptions) -> list[Plugin]:
    """Adds codemode to a list of plugins.

    It returns the plugins with their `context` hooks wrapped, so that codemode can see the tools they
    add, followed by the codemode plugin itself. Codemode needs the allowed tools' descriptions and
    schemas to write `run_script`'s description, and a `context` hook sees nothing of the tools other
    plugins add. The calls themselves run through the core, with `ctx.run_tool`.
    """
    seen: dict[str, ToolDefinition] = {}

    def wrap(plugin: Plugin) -> Plugin:
        context = plugin.context
        if context is None:
            return plugin

        async def capture(ctx: Any) -> ContextAddition | None:
            added = await settled(context(ctx))
            for tool in added.tools if added else []:
                seen[tool.name] = tool.definition()
            return added

        return replace(plugin, context=capture)

    def codemode_context(ctx: Any) -> ContextAddition:
        callable_tools = [seen[name] for name in options.tools if name in seen]
        tool = Tool(
            name="run_script",
            description=describe(callable_tools, options.max_calls, options.timeout),
            input_schema={
                "type": "object",
                "properties": {"script": {"type": "string"}},
                "required": ["script"],
            },
            run=lambda tool_input, tool_ctx: run_script(
                str(tool_input["script"]), callable_tools, options, tool_ctx
            ),
        )
        return ContextAddition(tools=[tool])

    return [*map(wrap, plugins), Plugin(name="codemode", context=codemode_context)]


def describe(
    tools: list[ToolDefinition], max_calls: int = DEFAULT_MAX_CALLS, timeout: float = DEFAULT_TIMEOUT
) -> str:
    """The tool's description: what a script is for, its limits, and the tools as Python signatures."""
    signatures = "\n\n".join(signature(tool) for tool in tools) or "# None."
    return "\n".join(
        [
            "Run a short Python script that calls your tools, and get back what it prints and the value"
            " of its last line.",
            "Use it when a task needs several tool calls and you need only part of their results, such as"
            " reading several documents to find one fact.",
            "The script runs in a sandboxed subset of Python with no files, environment or network.",
            "Each tool below is an async function: await it, and use asyncio.gather to run calls at the same"
            " time.",
            "A tool returns its result as text, and raises RuntimeError with its message when it fails.",
            f"A script may make at most {max_calls} tool calls and run for at most {round(timeout)} seconds.",
            "",
            "The tools a script can call:",
            "",
            "```python",
            signatures,
            "```",
        ]
    )


PY_TYPES = {
    "string": "str",
    "integer": "int",
    "number": "float",
    "boolean": "bool",
    "array": "list",
    "object": "dict",
}


def signature(tool: ToolDefinition) -> str:
    """A tool as a Python signature, required parameters first, with its description as the docstring."""
    required, optional = params(tool)
    properties = tool["inputSchema"].get("properties", {})

    def typed(name: str) -> str:
        return f"{name}: {PY_TYPES.get(properties.get(name, {}).get('type', ''), 'object')}"

    args = ", ".join([*map(typed, required), *(f"{typed(name)} = None" for name in optional)])
    doc = tool["description"].replace('"""', '\\"\\"\\"')
    return f'async def {tool["name"]}({args}) -> str:\n    """{doc}"""'


def params(tool: ToolDefinition) -> tuple[list[str], list[str]]:
    names = list(tool["inputSchema"].get("properties", {}))
    required = tool["inputSchema"].get("required", [])
    return [n for n in names if n in required], [n for n in names if n not in required]


async def run_script(
    script: str,
    callable_tools: list[ToolDefinition],
    options: CodemodeOptions,
    ctx: ToolContext,
) -> ToolResult:
    """Runs one script in a fresh worker process, answering its calls, until it ends or a limit ends it."""
    command = options.worker or default_worker()
    # An empty environment but for what `uv` needs to find itself and its cache: no keys reach the worker.
    env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    try:
        # Its own process group, so that ending it ends Monty's interpreter process too.
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            start_new_session=True,
            limit=16 * 1024 * 1024,
        )
    except FileNotFoundError:
        return error_result(f"The codemode worker could not start: {command[0]} was not found.")

    session = Script(process, callable_tools, options, ctx)
    try:
        async with asyncio.timeout(options.timeout):
            return await ctx.signal.unless_set(session.talk(script, callable_tools))
    except TimeoutError:
        return error_result(f"The script ran for more than {options.timeout:g} seconds, so it was stopped.")
    except Exception as error:
        if ctx.signal.is_set:
            return error_result("The harness stopped this script.")
        return error_result(f"The codemode worker failed: {message_of(error)}")
    finally:
        session.done = True
        if process.stdin:
            process.stdin.close()
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()


class Script:
    """One script's conversation with its worker."""

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        callable_tools: list[ToolDefinition],
        options: CodemodeOptions,
        ctx: ToolContext,
    ):
        self.process = process
        # Checked here as well as in the worker, so that a worker that misbehaves still reaches only these.
        self.allowed = {tool["name"] for tool in callable_tools}
        self.options = options
        self.ctx = ctx
        self.id = secrets.token_hex(4)
        self.done = False

    def send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        if not self.done and not self.process.stdin.is_closing():
            self.process.stdin.write((json.dumps(message) + "\n").encode())

    async def talk(self, script: str, callable_tools: list[ToolDefinition]) -> ToolResult:
        start: dict[str, Any] = {
            "type": "start",
            "script": script,
            "tools": [{"name": t["name"], "params": sum(params(t), [])} for t in callable_tools],
            "timeoutMs": round(self.options.timeout * 1000),
        }
        if self.options.max_memory is not None:
            start["maxMemory"] = self.options.max_memory
        if self.options.start_time is not None:
            start["startTime"] = self.options.start_time.isoformat()
        self.send(start)
        calls = 0
        answering: set[asyncio.Task[None]] = set()
        assert self.process.stdout is not None
        while line := await self.process.stdout.readline():
            message = json.loads(line)
            if message["type"] == "done":
                return text_result(
                    joined(message["output"], message.get("value")) or "The script returned nothing."
                )
            if message["type"] == "error":
                return text_result(joined(message["output"], message["error"]), True)
            if message["type"] != "call":
                continue
            calls += 1
            if calls > self.options.max_calls:
                return error_result(
                    f"The script made more than {self.options.max_calls} tool calls, so it was stopped."
                )
            task = asyncio.create_task(self.answer(message))
            answering.add(task)
            task.add_done_callback(answering.discard)
        stderr = (await self.process.stderr.read()).decode()[-2000:].strip() if self.process.stderr else ""
        return error_result(
            "The codemode worker ended without finishing the script." + (f"\n{stderr}" if stderr else "")
        )

    async def answer(self, message: dict[str, Any]) -> None:
        call: ToolCall = {
            "type": "toolCall",
            "id": f"{self.id}-{message['id']}",
            "name": message["name"],
            "input": message["input"],
        }
        # The core runs the call as it runs the model's, under the turn's limit. A name off the
        # allow-list is as unknown as a name nobody has.
        if call["name"] in self.allowed:
            result = await self.ctx.run_tool(call)
        else:
            result = error_result(f"No tool named {call['name']}.")
        if self.done:
            return
        with contextlib.suppress(Exception):
            await self.ctx.append(
                {"type": "custom", "plugin": "codemode", "data": {"call": call, "result": result}}
            )
        text = "".join(block.get("text", "") for block in result["content"])
        self.send({"type": "result", "id": message["id"], "text": text, "isError": result["isError"]})


def joined(output: str, last: str | None) -> str:
    """What the script printed, then its value or error on a line of its own."""
    return "\n".join(part for part in (output.removesuffix("\n"), last or "") if part)
