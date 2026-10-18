"""The codemode worker: runs one script in Monty and speaks JSON lines to its host.

The host starts this process for one script, writes a `start` message to stdin, answers each `call`
the worker writes to stdout with a `result`, and reads a final `done` or `error`. docs/codemode.md
describes the protocol. The worker trusts its host and nothing else: the script runs inside Monty,
which has no files, environment or network of its own, and reaches the host only through the tools
named in the `start` message.
"""

import asyncio
import datetime
import json
import sys
from typing import Any

from pydantic_monty import AsyncMonty, CollectString, MontyError, MontyRuntimeError, MontySyntaxError

# Monty's own suspension limit counts name lookups as well as calls, so it is only a backstop here.
# The host counts calls itself and ends the process at the agent's limit.
MAX_SUSPENSIONS = 10_000
DEFAULT_MAX_MEMORY = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 100_000


class Worker:
    def __init__(self) -> None:
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.next_id = 0

    def send(self, message: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()

    def tool(self, name: str, params: list[str]):
        """An async function the script calls by the tool's name. It sends a `call` and awaits its `result`."""

        async def call(*args: Any, **kwargs: Any) -> Any:
            if len(args) > len(params):
                raise TypeError(f"{name}() takes {len(params)} positional arguments but {len(args)} were given")
            tool_input = dict(zip(params, args, strict=False))
            for key, value in kwargs.items():
                if key in tool_input:
                    raise TypeError(f"{name}() got multiple values for argument '{key}'")
                tool_input[key] = value
            self.next_id += 1
            call_id = str(self.next_id)
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self.pending[call_id] = future
            self.send({"type": "call", "id": call_id, "name": name, "input": tool_input})
            result = await future
            if result.get("isError"):
                raise RuntimeError(result.get("text", ""))
            return result.get("text", "")

        return call

    async def read_results(self, reader: asyncio.StreamReader) -> None:
        """Hands each `result` from the host to the call waiting for it."""
        while line := await reader.readline():
            message = json.loads(line)
            if message.get("type") == "result":
                future = self.pending.pop(str(message.get("id")), None)
                if future is not None and not future.done():
                    future.set_result(message)
        # The host closed stdin: nothing more will come, so the script cannot finish.
        for future in self.pending.values():
            if not future.done():
                future.set_exception(RuntimeError("The host went away."))

    async def run(self, start: dict[str, Any], reader: asyncio.StreamReader) -> None:
        lookup = {tool["name"]: self.tool(tool["name"], list(tool.get("params", []))) for tool in start["tools"]}
        policy: dict[str, Any] = {}
        if start.get("startTime"):
            policy["datetime"] = datetime.datetime.fromisoformat(start["startTime"])
        limits = {"max_memory": start.get("maxMemory") or DEFAULT_MAX_MEMORY, "max_suspensions": MAX_SUSPENSIONS}
        printed = CollectString(max_bytes=MAX_OUTPUT_BYTES)
        results = asyncio.create_task(self.read_results(reader))
        try:
            # One script, one fresh session: a session that hit a limit cannot be trusted afterwards.
            async with AsyncMonty(max_processes=1) as pool, pool.checkout(limits=limits, os_policy=policy) as session:
                value = await session.feed_run(start["script"], external_lookup=lookup, print_callback=printed)
        except (MontyRuntimeError, MontySyntaxError) as error:
            self.send({"type": "error", "output": printed.output, "error": error.display("traceback")})
        except MontyError as error:
            self.send({"type": "error", "output": printed.output, "error": str(error)})
        else:
            self.send({"type": "done", "output": printed.output, "value": describe(value)})
        finally:
            results.cancel()


def describe(value: Any) -> str | None:
    """The script's return value as text: a string as it is, other values as JSON where they can be."""
    if value is None or isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return repr(value)


async def main() -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    first = await reader.readline()
    if not first:
        return
    await Worker().run(json.loads(first), reader)


if __name__ == "__main__":
    asyncio.run(main())
