"""The loop, which is the whole harness.

A run asks the model for the next step, runs the tools it calls, and appends everything to the
session, until nothing new needs an answer. docs/spec/loop.md is the contract, and `Agent.run`
follows its numbered steps in order. docs/spec/plugins.md says how a tool call runs, and
docs/spec/host.md what a host sees.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from .render import path_of, render
from .store import Store, new_entry_id, new_session_id, now_iso
from .types import (
    AgentConfig,
    AssistantMessage,
    ContextAddition,
    Entry,
    Event,
    MaybeAwaitable,
    PluginContext,
    Provider,
    ProviderRequest,
    RunOutcome,
    Session,
    StopSignal,
    Tool,
    ToolCall,
    ToolContext,
    ToolDefinition,
    ToolResult,
)

SOFT_LIMIT_NOTICE = "This session is nearly full. Bring your notes up to date, then call reset."
REPAIR_TEXT = "The harness stopped before this tool ran."
CUT_OFF_TEXT = "The response was cut off before this call was complete."


def _reset_run(tool_input: dict[str, Any], ctx: ToolContext) -> str:
    ctx.request_reset(tool_input.get("reason"))
    return "Session will reset after this turn."


RESET_TOOL = Tool(
    name="reset",
    description=(
        "End this session and start a fresh one. Call it when your notes are up to date and the session "
        "is long, or when the work is finished. Anything not written down will be forgotten."
    ),
    input_schema={"type": "object", "properties": {"reason": {"type": "string"}}},
    run=_reset_run,
)


async def settled[T](value: MaybeAwaitable[T]) -> T:
    """The value a hook or tool returned, awaited when it is awaitable, so plain functions work too."""
    return await value if inspect.isawaitable(value) else value


def notice(text: str) -> Entry:
    return {"type": "event", "kind": "notice", "attrs": {"from": "harness"}, "text": text}


def is_stop_notice(entry: Entry) -> bool:
    return (
        entry["kind"] == "notice" and entry["text"].startswith("Stopped by ") and entry["text"].endswith(".")
    )


def error_result(text: str) -> ToolResult:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def tool_calls(message: AssistantMessage) -> list[ToolCall]:
    return [block for block in message["content"] if block["type"] == "toolCall"]


def unanswered_calls(path: list[Entry]) -> list[ToolCall]:
    """The calls of the last assistant message on the path that have no `tool` message after it."""
    for index in range(len(path) - 1, -1, -1):
        entry = path[index]
        if entry["type"] == "message" and entry["message"]["role"] == "assistant":
            answered = {
                later["message"]["callId"]
                for later in path[index + 1 :]
                if later["type"] == "message" and later["message"]["role"] == "tool"
            }
            return [call for call in tool_calls(entry["message"]) if call["id"] not in answered]
    return []


def check_input(tool_input: object, schema: dict[str, Any]) -> str | None:
    """The least check the spec asks for: an object, with its required properties present."""
    if not isinstance(tool_input, dict):
        return "expected an object"
    for name in schema.get("required", []):
        if name not in tool_input:
            return f'missing required property "{name}"'
    return None


def message_of(error: BaseException) -> str:
    return str(error) or type(error).__name__


def plugin_failed(plugin: str, error: BaseException) -> ToolResult:
    """A throwing hook is the plugin's bug: the call gets an error result, and no later hook runs."""
    return error_result(f"The {plugin} plugin failed: {message_of(error)}")


class Place:
    """A tool's place under the turn's limit.

    While the calls a tool made with `run_tool` run, the tool gives up its place, and it takes one back
    when the last of them finishes, so a tool never waits on its own place. `finish` gives the place
    back when the tool ends, unless it ended without one, while calls it made were still running.
    """

    def __init__(self, places: asyncio.Semaphore) -> None:
        self.places = places
        self.holding = True
        self.finished = False
        self.waiting = 0
        self.back: asyncio.Future[None] | None = None

    async def give_up_while(self, call: Awaitable[ToolResult]) -> ToolResult:
        self.waiting += 1
        if self.waiting == 1:
            if self.back is not None:
                await asyncio.shield(self.back)
            if self.holding:
                self.places.release()
            self.holding = False
        try:
            return await call
        finally:
            self.waiting -= 1
            if self.waiting == 0 and not self.finished:
                # Shielded, so that a cancelled tool still gets the place `finish` will give back.
                self.back = asyncio.ensure_future(self._take_back())
                await asyncio.shield(self.back)

    async def _take_back(self) -> None:
        await self.places.acquire()
        if self.finished:
            self.places.release()
        else:
            self.holding = True

    def finish(self) -> None:
        self.finished = True
        if self.holding:
            self.places.release()
        self.holding = False


class Agent:
    """One agent: its configuration, the store that keeps its sessions, and a provider for each
    provider name in its models.

    The host queues events with `deliver` and calls `run` when it wants the agent to answer.
    """

    def __init__(self, config: AgentConfig, *, store: Store, providers: dict[str, Provider]) -> None:
        provider_name, _, model_name = config.model.partition("/")
        if provider_name not in providers:
            raise ValueError(f"No provider named {provider_name} for the model {config.model}.")
        if config.max_concurrent_tools < 1:
            raise ValueError(f"max_concurrent_tools must be at least 1, not {config.max_concurrent_tools}.")
        if config.tool_execution not in ("concurrent", "serial"):
            raise ValueError(f"tool_execution must be concurrent or serial, not {config.tool_execution}.")
        self.config = config
        self.store = store
        self.provider = providers[provider_name]
        self.model_name = model_name
        self._queue: list[tuple[Event, str | None]] = []
        self._running = False
        # The running run's stop signal, which every hook and tool sees. Never set between runs.
        self._stop = StopSignal()
        # Calls running together may append at once. Each append reads the head and writes after it,
        # so they take turns.
        self._appending = asyncio.Lock()
        # The code for the open session's tools, and for the tools it may add, so a run does not call
        # the context hooks again.
        self._tools: tuple[str, dict[str, Tool], dict[str, Tool]] | None = None

    def deliver(self, event: Event, *, parent_id: str | None = None) -> None:
        """Queue an event for the next delivery point. Give `parent_id` to rewind to that entry."""
        self._queue.append((event, parent_id))

    async def run(self, *, signal: StopSignal | None = None) -> RunOutcome:
        # A simple in-process guard. A host on several machines uses its own lock.
        if self._running:
            raise RuntimeError(f"Agent {self.config.id} is already running.")
        self._running = True
        # A run the host cannot stop gets a stop that is never set, so the loop has one shape.
        self._stop = signal or StopSignal()
        try:
            return await self._run(self._stop)
        finally:
            self._running = False
            self._stop = StopSignal()

    async def _run(self, stop: StopSignal) -> RunOutcome:
        # 1. Open a session if none is open. Read the store every run: the host may have appended.
        session, tools, available = await self._open_session()
        # 2. Repair calls left without a result. 3. Deliver waiting events.
        await self._repair(session)
        await self._deliver_queued(session)

        # 4. Freeze the context: the last context entry on the path, for the whole run, until a tool
        # adds tools after a turn's results.
        frozen = render(path_of(session.entries))
        code = tools | available
        # The tools that join the session after this turn's results, in the order they were asked for.
        adding: list[Tool] = []

        def add_tools(names: list[str]) -> list[str]:
            present = {definition["name"] for definition in frozen.tools} | {tool.name for tool in adding}
            added = []
            for name in names:
                if name in available and name not in present:
                    present.add(name)
                    added.append(name)
                    adding.append(available[name])
            return added

        # 5. Loop while the session needs a run.
        while self._needs_run(session):
            # i. Stop when the stop is set.
            if stop.is_set:
                return await self._stopped(session, stop)

            request = ProviderRequest(
                model=self.model_name,
                sections=frozen.sections,
                tools=frozen.tools,
                messages=render(path_of(session.entries)).messages,
                max_tokens=self.config.max_tokens,
                effort=self.config.effort,
                signal=stop,
            )
            try:
                # ii. Call the provider. A stop abandons the call in flight, whatever the provider does.
                message = await stop.unless_set(self.provider.complete(request))
            except Exception as error:
                if stop.is_set:
                    return await self._stopped(session, stop)
                failed: AssistantMessage = {
                    "role": "assistant",
                    "content": [],
                    "model": self.config.model,
                    "usage": {"input": 0, "output": 0},
                    "stop": "error",
                }
                await self._append(session, {"type": "message", "message": failed})
                await self._append(session, notice(f"The model call failed: {message_of(error)}"))
                return "error"
            # iii. Append the assistant message.
            await self._append(session, {"type": "message", "message": message})

            # iv. Run the calls, then append their results in call order. A response cut off by the
            # token limit may hold a call with half its input, so none of its calls run.
            calls = tool_calls(message)
            # The reset each call requested, by call index, so that the first in call order wins.
            resets: dict[int, str | None] = {}
            if message["stop"] == "maxTokens":
                results = [error_result(CUT_OFF_TEXT) for _ in calls]
            else:
                results = await self._run_calls(calls, frozen.tools, code, session, resets, add_tools)
            for call, result in zip(calls, results, strict=True):
                tool_message = {"role": "tool", "callId": call["id"], "name": call["name"], **result}
                await self._append(session, {"type": "message", "message": tool_message})
            # Tools a call added join now, in a new context entry, which the rest of the run uses.
            if adding:
                definitions = frozen.tools + [tool.definition() for tool in adding]
                adding.clear()
                await self._append(
                    session, {"type": "context", "sections": frozen.sections, "tools": definitions}
                )
                frozen = render(path_of(session.entries))

            # v. A reset wins over a stop, since the model has already been told the session will reset.
            if resets:
                return await self._end_session(session, "agent", resets[min(resets)])
            if calls and stop.is_set:
                return await self._stopped(session, stop)

            # vi. Check the budget.
            usage = message["usage"]
            size = usage["input"] + usage["output"] + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
            if size > self.config.hard_limit:
                return await self._end_session(session, "harness", "context budget")
            if size > self.config.soft_limit and not self._has_soft_notice(session):
                await self._append(session, notice(SOFT_LIMIT_NOTICE))

            # vii. Deliver waiting events.
            await self._deliver_queued(session)
        # 6. End.
        return "idle"

    # Opening, repairing and ending sessions.

    async def _open_session(self) -> tuple[Session, dict[str, Tool], dict[str, Tool]]:
        """The agent's newest session, unless it ends in a reset; otherwise a new one. A newest
        session that holds only its header, because a process stopped after writing it, is opened
        in place."""
        ids = await self.store.list(self.config.id)
        newest = await self.store.read(self.config.id, ids[-1]) if ids else None
        last = newest.entries[-1] if newest and newest.entries else None
        if newest is not None and last is not None and last["type"] != "reset":
            if self._tools is not None and self._tools[0] == newest.header["id"]:
                return newest, self._tools[1], self._tools[2]
            # Opened by an earlier process: ask the plugins again for their tools' code, including
            # tools a tool may have added.
            _, tools, available = await self._collect_context(newest)
            self._tools = (newest.header["id"], tools, available)
            return newest, tools, available

        header_only = newest is not None and not newest.entries
        if newest is not None and header_only:
            # A process stopped after writing the header. The session before it says why it starts.
            session = newest
            previous = (await self.store.read(self.config.id, ids[-2])).entries if len(ids) > 1 else []
            last = previous[-1] if previous else None
        else:
            session = Session(header=self._new_header(ids), entries=[])
        sections, tools, available = await self._collect_context(session)
        if not header_only:
            await self.store.create(session.header)
        definitions = [tool.definition() for tool in tools.values()]
        await self._append(session, {"type": "context", "sections": sections, "tools": definitions})
        if last is None or last["type"] != "reset":
            why = "Session started."
        elif last.get("reason"):
            why = f"Session started after a reset: {last['reason']}"
        else:
            why = "Session started after a reset."
        await self._append(session, notice(why))
        self._tools = (session.header["id"], tools, available)
        return session, tools, available

    def _new_header(self, ids: list[str]) -> Any:
        """A header for a new session: its parent is the previous session, or the agent's parent."""
        now = datetime.now(UTC)
        header: Any = {
            "type": "session",
            "version": 1,
            "id": new_session_id(now, ids[-1] if ids else None),
            "agent": self.config.id,
            "createdAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        if ids:
            header["parent"] = {"session": ids[-1], "reason": "reset"}
        elif self.config.parent is not None:
            header["parent"] = dict(self.config.parent)
        return header

    async def _collect_context(self, session: Session) -> tuple[list[Any], dict[str, Tool], dict[str, Tool]]:
        """Calls every plugin's `context` hook, and adds the core `reset` tool after their tools.
        Nothing can be appended yet, since a session's first entry is its `context` entry. No two
        tools, whether in the session or available to add, may share a name."""
        sections: list[Any] = []
        tools: dict[str, Tool] = {}
        available: dict[str, Tool] = {}
        ctx = self._context(session, refusal="The session is opening, so nothing can be appended yet.")
        for plugin in self.config.plugins:
            try:
                added = (plugin.context and await settled(plugin.context(ctx))) or ContextAddition()
            except Exception as error:
                raise RuntimeError(f"The {plugin.name} plugin failed: {message_of(error)}") from error
            sections.extend(added.sections)
            for into, given in ((tools, added.tools), (available, added.available)):
                for tool in given:
                    if tool.name in tools or tool.name in available or tool.name == RESET_TOOL.name:
                        raise ValueError(f"Two tools are named {tool.name}.")
                    into[tool.name] = tool
        tools[RESET_TOOL.name] = RESET_TOOL
        return sections, tools, available

    async def _repair(self, session: Session) -> None:
        """Gives every unanswered call of the last assistant message an error result."""
        for call in unanswered_calls(path_of(session.entries)):
            tool_message = {
                "role": "tool",
                "callId": call["id"],
                "name": call["name"],
                **error_result(REPAIR_TEXT),
            }
            await self._append(session, {"type": "message", "message": tool_message})

    async def _end_session(self, session: Session, by: str, reason: str | None) -> RunOutcome:
        entry: Entry = {"type": "reset", "by": by}
        if reason:
            entry["reason"] = reason
        await self._append(session, entry)
        # The session has ended, so an error here can change nothing. `append` fails, since nothing
        # follows a reset.
        for plugin in self.config.plugins:
            if plugin.on_session_end:
                with contextlib.suppress(Exception):
                    await settled(plugin.on_session_end(session, self._context(session)))
        return "reset"

    async def _stopped(self, session: Session, stop: StopSignal) -> RunOutcome:
        await self._append(session, notice(f"Stopped by {stop.who}."))
        return "stopped"

    # Appending and delivering.

    async def _append(self, session: Session, body: Entry, parent_id: str | None = None) -> Entry:
        """Appends an entry after the head, or after `parent_id` to rewind, and tells the plugins."""
        async with self._appending:
            if session.entries and session.entries[-1]["type"] == "reset":
                raise RuntimeError("Nothing may follow a reset.")
            taken = {entry["id"] for entry in session.entries}
            entry_id = new_entry_id()
            while entry_id in taken:
                entry_id = new_entry_id()
            head = session.entries[-1]["id"] if session.entries else None
            entry = {"type": body["type"], "id": entry_id, "parentId": parent_id or head, "at": now_iso()}
            entry.update((key, value) for key, value in body.items() if key != "type")
            await self.store.append(self.config.id, session.header["id"], entry)
            session.entries.append(entry)
        # Outside the lock, since a watcher may append in turn. A watcher's error is ignored, so that
        # it can never leave a turn's results half written.
        for plugin in self.config.plugins:
            if plugin.on_entry:
                with contextlib.suppress(Exception):
                    await settled(plugin.on_entry(entry, self._context(session)))
        return entry

    async def _deliver_queued(self, session: Session) -> None:
        queued, self._queue = self._queue, []
        for event, parent_id in queued:
            if parent_id is not None and not self._can_rewind_to(session, parent_id):
                parent_id = None
            await self._append(session, {"type": "event", **event}, parent_id)

    @staticmethod
    def _can_rewind_to(session: Session, parent_id: str) -> bool:
        """A rewind stays inside the open session and never leaves a call without its result."""
        entries = session.entries
        index = next((i for i, entry in enumerate(entries) if entry["id"] == parent_id), None)
        # Parents come before their children in the file, so the path to the target ends at the target.
        return index is not None and not unanswered_calls(path_of(entries[: index + 1]))

    def _context(self, session: Session, refusal: str | None = None) -> PluginContext:
        """What a hook sees. `refusal` is why `append` fails, when it must: while the session opens."""

        async def append(body: Entry) -> None:
            if refusal is not None:
                raise RuntimeError(refusal)
            # Events go through deliver, so that they arrive only at a delivery point.
            if body.get("type") != "custom":
                raise ValueError("A plugin may append only custom entries. Deliver events instead.")
            await self._append(session, body)

        return PluginContext(
            agent=self.config, session=session, append=append, deliver=self.deliver, signal=self._stop
        )

    # Checks.

    @staticmethod
    def _needs_run(session: Session) -> bool:
        """True when the last entry on the path, leaving out custom and context entries, is a tool
        result or an event from outside the harness. The harness's own notices need no answer, except
        the soft-limit notice, which the model gets one turn to act on. A stop does not take that turn
        away, so stop notices after the soft-limit notice are looked past."""
        after_stop = False
        for entry in reversed(path_of(session.entries)):
            if entry["type"] in ("custom", "context"):
                continue
            if entry["type"] == "message":
                return entry["message"]["role"] == "tool" and not after_stop
            if entry["type"] == "event":
                if (entry.get("attrs") or {}).get("from") != "harness":
                    return not after_stop
                if entry["text"] == SOFT_LIMIT_NOTICE:
                    return True
                if is_stop_notice(entry):
                    after_stop = True
                    continue
            return False
        return False

    @staticmethod
    def _has_soft_notice(session: Session) -> bool:
        return any(
            entry["type"] == "event" and entry["kind"] == "notice" and entry["text"] == SOFT_LIMIT_NOTICE
            for entry in session.entries
        )

    async def _run_calls(
        self,
        calls: list[ToolCall],
        definitions: list[ToolDefinition],
        code: dict[str, Tool],
        session: Session,
        resets: dict[int, str | None],
        add_tools: Callable[[list[str]], list[str]],
    ) -> list[ToolResult]:
        """Runs a turn's calls by the agent's `tool_execution`, and returns their results in call order.
        Records in `resets` the first reset each call requests, by call index.

        Calls queue for a place in call order, and a call a tool makes with `run_tool` queues the same
        way. Serial execution starts each call after the one before and has one place. Once the stop is
        set, a call that has not started does not start: it gets the same result as a call a crash left
        unanswered.
        """
        serial = self.config.tool_execution == "serial"
        places = asyncio.Semaphore(1 if serial else self.config.max_concurrent_tools)

        async def run_limited(call: ToolCall, request_reset: Callable[[str | None], None]) -> ToolResult:
            await places.acquire()
            if self._stop.is_set:
                places.release()
                return error_result(REPAIR_TEXT)
            place = Place(places)
            ctx = ToolContext(
                **vars(self._context(session)),
                request_reset=request_reset,
                run_tool=lambda nested: place.give_up_while(run_limited(nested, request_reset)),
                add_tools=add_tools,
            )
            try:
                return await self._run_tool(call, definitions, code, ctx)
            finally:
                place.finish()

        def requester(index: int) -> Callable[[str | None], None]:
            return lambda reason: resets.setdefault(index, reason)

        if serial:
            return [await run_limited(call, requester(index)) for index, call in enumerate(calls)]
        return await asyncio.gather(
            *(run_limited(call, requester(index)) for index, call in enumerate(calls))
        )

    async def _run_tool(
        self, call: ToolCall, definitions: list[ToolDefinition], code: dict[str, Tool], ctx: ToolContext
    ) -> ToolResult:
        """Runs one call as docs/spec/plugins.md describes. A tool's own failure becomes its result."""
        # The frozen context decides which tools exist; the plugins only supply their code.
        definition = next((d for d in definitions if d["name"] == call["name"]), None)
        tool = code.get(call["name"])
        if definition is None or tool is None:
            return error_result(f"No tool named {call['name']}.")
        problem = check_input(call["input"], definition["inputSchema"])
        if problem is not None:
            return error_result(f"Invalid input for {call['name']}: {problem}.")

        result: ToolResult | None = None
        for plugin in self.config.plugins:
            try:
                if (
                    plugin.before_tool
                    and (result := await settled(plugin.before_tool(call, ctx))) is not None
                ):
                    break
            except Exception as error:
                return plugin_failed(plugin.name, error)
        if result is None:
            try:
                output = await settled(tool.run(call["input"], ctx))
                result = (
                    {"content": [{"type": "text", "text": output}], "isError": False}
                    if isinstance(output, str)
                    else output
                )
            except Exception as error:
                result = error_result(message_of(error))
        for plugin in self.config.plugins:
            try:
                if plugin.after_tool:
                    result = await settled(plugin.after_tool(call, result, ctx)) or result
            except Exception as error:
                return plugin_failed(plugin.name, error)
        return result
