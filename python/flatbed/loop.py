"""The loop, which is the whole harness.

A run asks the model for the next step, runs the tools it calls, and appends everything to the
session, until nothing new needs an answer. docs/spec/loop.md is the contract, and `Runner.run`
follows its numbered steps in order. docs/spec/plugins.md says how a tool call runs.
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any

from .render import path_of, render
from .store import Store, new_entry_id, new_session_id, now_iso
from .types import (
    Agent,
    AssistantMessage,
    ContextAddition,
    Entry,
    Event,
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


def notice(text: str) -> Entry:
    return {"type": "event", "kind": "notice", "attrs": {"from": "harness"}, "text": text}


def error_result(text: str) -> ToolResult:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def tool_calls(message: AssistantMessage) -> list[ToolCall]:
    return [block for block in message["content"] if block["type"] == "toolCall"]


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


class Runner:
    """Runs one agent against a store, with a provider for each provider name in its models.

    The host queues events with `deliver` and calls `run` when it wants the agent to answer.
    """

    def __init__(self, agent: Agent, store: Store, providers: dict[str, Provider]) -> None:
        provider_name, _, model_name = agent.model.partition("/")
        if provider_name not in providers or not model_name:
            raise ValueError(f"No provider for the model {agent.model}.")
        self.agent = agent
        self.store = store
        self.provider = providers[provider_name]
        self.model_name = model_name
        self._queue: list[tuple[Event, str | None]] = []
        self._running = threading.Lock()
        # The tools' code for the open session, so a run does not call the context hooks again.
        self._tools: tuple[str, dict[str, Tool]] | None = None

    def deliver(self, event: Event, parent_id: str | None = None) -> None:
        """Queue an event for the next delivery point. Give `parent_id` to rewind to that entry."""
        self._queue.append((event, parent_id))

    def run(self, stop: StopSignal | None = None) -> RunOutcome:
        # A simple in-process guard. A host on several machines uses its own lock.
        if not self._running.acquire(blocking=False):
            raise RuntimeError(f"Agent {self.agent.id} is already running.")
        try:
            return self._run(stop or StopSignal())
        finally:
            self._running.release()

    def _run(self, stop: StopSignal) -> RunOutcome:
        # 1. Open a session if none is open. Read the store every run: the host may have appended.
        session, tools = self._open_session()
        # 2. Repair calls left without a result. 3. Deliver waiting events.
        self._repair(session)
        self._deliver_queued(session)

        # 4. Loop while the session needs a run.
        while self._needs_run(session):
            if stop.is_set:
                return self._stopped(session, stop)

            rendered = render(path_of(session.entries))
            request = ProviderRequest(
                model=self.model_name,
                sections=rendered.sections,
                tools=rendered.tools,
                messages=rendered.messages,
                max_tokens=self.agent.max_tokens,
                effort=self.agent.effort,
                signal=stop,
            )
            try:
                message = self.provider.complete(request)
            except Exception as error:
                if stop.is_set:
                    return self._stopped(session, stop)
                failed: AssistantMessage = {
                    "role": "assistant",
                    "content": [],
                    "model": self.agent.model,
                    "usage": {"input": 0, "output": 0},
                    "stop": "error",
                }
                self._append(session, {"type": "message", "message": failed})
                self._append(session, notice(f"The model call failed: {message_of(error)}"))
                return "error"
            self._append(session, {"type": "message", "message": message})

            resets: list[str | None] = []
            ctx = ToolContext(**vars(self._context(session)), request_reset=resets.append)
            # Calls run one after another; the spec allows them to run concurrently. A response cut off
            # by the token limit may hold a call with half its input, so none of its calls run.
            for call in tool_calls(message):
                if message["stop"] == "maxTokens":
                    result = error_result(CUT_OFF_TEXT)
                else:
                    result = self._run_tool(call, rendered.tools, tools, ctx)
                tool_message = {"role": "tool", "callId": call["id"], "name": call["name"], **result}
                self._append(session, {"type": "message", "message": tool_message})
            if resets:
                return self._end_session(session, "agent", resets[0])

            usage = message["usage"]
            size = usage["input"] + usage["output"] + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
            if size > self.agent.hard_limit:
                return self._end_session(session, "harness", "context budget")
            if size > self.agent.soft_limit and not self._has_soft_notice(session):
                self._append(session, notice(SOFT_LIMIT_NOTICE))

            self._deliver_queued(session)
        return "idle"

    # Opening, repairing and ending sessions.

    def _open_session(self) -> tuple[Session, dict[str, Tool]]:
        """The agent's newest session, unless it ends in a reset; otherwise a new one."""
        ids = self.store.list(self.agent.id)
        newest = self.store.read(self.agent.id, ids[-1]) if ids else None
        last = newest.entries[-1] if newest and newest.entries else None
        if newest is not None and (last is None or last["type"] != "reset"):
            if self._tools is not None and self._tools[0] == newest.header["id"]:
                return newest, self._tools[1]
            # Opened by an earlier process: ask the plugins again for their tools' code.
            _, tools = self._collect_context(newest)
            self._tools = (newest.header["id"], tools)
            return newest, tools

        now = datetime.now(UTC)
        header: Any = {
            "type": "session",
            "version": 1,
            "id": new_session_id(now, ids[-1] if ids else None),
            "agent": self.agent.id,
            "createdAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        if ids:
            header["parent"] = {"session": ids[-1], "reason": "reset"}
        session = Session(header=header, entries=[])
        sections, tools = self._collect_context(session)
        self.store.create(header)
        definitions = [tool.definition() for tool in tools.values()]
        self._append(session, {"type": "context", "sections": sections, "tools": definitions})
        if last is None:
            why = "Session started."
        elif last.get("reason"):
            why = f"Session started after a reset: {last['reason']}"
        else:
            why = "Session started after a reset."
        self._append(session, notice(why))
        self._tools = (header["id"], tools)
        return session, tools

    def _collect_context(self, session: Session) -> tuple[list[Any], dict[str, Tool]]:
        """Calls every plugin's `context` hook, and adds the core `reset` tool after their tools."""
        sections: list[Any] = []
        tools: dict[str, Tool] = {}
        for plugin in self.agent.plugins:
            added = (plugin.context and plugin.context(self._context(session))) or ContextAddition()
            sections.extend(added.sections)
            for tool in added.tools:
                if tool.name in tools or tool.name == RESET_TOOL.name:
                    raise ValueError(f"Two tools are named {tool.name}.")
                tools[tool.name] = tool
        tools[RESET_TOOL.name] = RESET_TOOL
        return sections, tools

    def _repair(self, session: Session) -> None:
        """Gives every unanswered call of the last assistant message an error result."""
        path = path_of(session.entries)
        for index in range(len(path) - 1, -1, -1):
            entry = path[index]
            if entry["type"] == "message" and entry["message"]["role"] == "assistant":
                answered = {
                    later["message"]["callId"]
                    for later in path[index + 1 :]
                    if later["type"] == "message" and later["message"]["role"] == "tool"
                }
                for call in tool_calls(entry["message"]):
                    if call["id"] not in answered:
                        result = error_result(REPAIR_TEXT)
                        tool_message = {"role": "tool", "callId": call["id"], "name": call["name"], **result}
                        self._append(session, {"type": "message", "message": tool_message})
                return

    def _end_session(self, session: Session, by: str, reason: str | None) -> RunOutcome:
        entry: Entry = {"type": "reset", "by": by}
        if reason:
            entry["reason"] = reason
        self._append(session, entry)
        for plugin in self.agent.plugins:
            if plugin.on_session_end:
                plugin.on_session_end(session, self._context(session))
        return "reset"

    def _stopped(self, session: Session, stop: StopSignal) -> RunOutcome:
        self._append(session, notice(f"Stopped by {stop.who}."))
        return "stopped"

    # Appending and delivering.

    def _append(self, session: Session, body: Entry, parent_id: str | None = None) -> Entry:
        """Appends an entry after the head, or after `parent_id` to rewind, and tells the plugins."""
        if session.entries and session.entries[-1]["type"] == "reset":
            raise RuntimeError("Nothing may follow a reset.")
        taken = {entry["id"] for entry in session.entries}
        entry_id = new_entry_id()
        while entry_id in taken:
            entry_id = new_entry_id()
        head = session.entries[-1]["id"] if session.entries else None
        entry = {"type": body["type"], "id": entry_id, "parentId": parent_id or head, "at": now_iso()}
        entry.update((key, value) for key, value in body.items() if key != "type")
        self.store.append(self.agent.id, session.header["id"], entry)
        session.entries.append(entry)
        for plugin in self.agent.plugins:
            if plugin.on_entry:
                plugin.on_entry(entry, self._context(session))
        return entry

    def _deliver_queued(self, session: Session) -> None:
        queued, self._queue = self._queue, []
        known = {entry["id"] for entry in session.entries}
        for event, parent_id in queued:
            # A rewind target outside the open session, such as one in a session since reset, cannot
            # be a parent here, so the event follows the head.
            self._append(session, {"type": "event", **event}, parent_id if parent_id in known else None)

    def _context(self, session: Session) -> PluginContext:
        def append(body: Entry) -> None:
            # Events go through deliver, so that they arrive only at a delivery point.
            if body.get("type") != "custom":
                raise ValueError("A plugin may append only custom entries. Deliver events instead.")
            self._append(session, body)

        return PluginContext(agent=self.agent, session=session, append=append, deliver=self.deliver)

    # Checks.

    @staticmethod
    def _needs_run(session: Session) -> bool:
        """True when the last entry on the path, leaving out custom and context entries, is a tool
        result or an event from outside the harness. The harness's own notices need no answer, except
        the soft-limit notice, which the model gets one turn to act on."""
        for entry in reversed(path_of(session.entries)):
            if entry["type"] in ("custom", "context"):
                continue
            if entry["type"] == "message":
                return entry["message"]["role"] == "tool"
            if entry["type"] == "event":
                from_harness = (entry.get("attrs") or {}).get("from") == "harness"
                return not from_harness or entry["text"] == SOFT_LIMIT_NOTICE
            return False
        return False

    @staticmethod
    def _has_soft_notice(session: Session) -> bool:
        return any(
            entry["type"] == "event" and entry["kind"] == "notice" and entry["text"] == SOFT_LIMIT_NOTICE
            for entry in session.entries
        )

    def _run_tool(
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
        for plugin in self.agent.plugins:
            if plugin.before_tool and (result := plugin.before_tool(call, ctx)) is not None:
                break
        if result is None:
            try:
                output = tool.run(call["input"], ctx)
                result = (
                    {"content": [{"type": "text", "text": output}], "isError": False}
                    if isinstance(output, str)
                    else output
                )
            except Exception as error:
                result = error_result(message_of(error))
        for plugin in self.agent.plugins:
            if plugin.after_tool:
                result = plugin.after_tool(call, result, ctx) or result
        return result
