"""The types flatbed holds: sessions and their entries, messages in flatbed's own format, and the
shapes of agents, plugins, tools and provider requests. docs/spec/ is the contract these follow.

Entries and messages are plain dicts at run time, so that they go to and from JSON unchanged. The
TypedDicts below say which keys they carry, with the spec's own field names.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, Protocol, TypedDict

type JsonSchema = dict[str, Any]
# Hooks and tools may be coroutines or plain functions; the loop awaits what is awaitable.
type MaybeAwaitable[T] = T | Awaitable[T]

# Content blocks and messages, as docs/spec/sessions.md describes.


class TextBlock(TypedDict):
    type: Literal["text"]
    text: str


class ImageBlock(TypedDict):
    type: Literal["image"]
    mimeType: str
    data: str


class ThinkingBlock(TypedDict):
    type: Literal["thinking"]
    text: str
    signature: NotRequired[str]
    provider: NotRequired[str]


class ToolCall(TypedDict):
    type: Literal["toolCall"]
    id: str
    name: str
    input: dict[str, Any]


type Block = TextBlock | ImageBlock | ThinkingBlock | ToolCall


class Usage(TypedDict):
    input: int
    output: int
    cacheRead: NotRequired[int]
    cacheWrite: NotRequired[int]


type Stop = Literal["end", "toolUse", "maxTokens", "refusal", "error"]


class UserMessage(TypedDict):
    role: Literal["user"]
    content: list[TextBlock | ImageBlock]


class AssistantMessage(TypedDict):
    role: Literal["assistant"]
    content: list[Block]
    model: str
    usage: Usage
    stop: Stop


class ToolMessage(TypedDict):
    role: Literal["tool"]
    callId: str
    name: str
    content: list[TextBlock | ImageBlock]
    isError: bool


type Message = UserMessage | AssistantMessage | ToolMessage

# Sessions.


class Section(TypedDict):
    name: str
    text: str
    cache: NotRequired[bool]


class ToolDefinition(TypedDict):
    name: str
    description: str
    inputSchema: JsonSchema


class Event(TypedDict):
    kind: str
    attrs: NotRequired[dict[str, str]]
    text: str


class Header(TypedDict):
    type: Literal["session"]
    version: Literal[1]
    id: str
    agent: str
    createdAt: str
    parent: NotRequired[dict[str, str]]


# An entry is one of these shapes, plus `id`, `parentId` and `at`, which the loop adds as it appends:
#   {"type": "context", "sections": [...], "tools": [...]}
#   {"type": "message", "message": {...}}
#   {"type": "event", "kind": ..., "attrs": {...}, "text": ...}
#   {"type": "reset", "by": "agent" | "harness", "reason": ...}
#   {"type": "custom", "plugin": ..., "data": ...}
type Entry = dict[str, Any]


@dataclass
class Session:
    header: Header
    entries: list[Entry]


class ToolResult(TypedDict):
    content: list[TextBlock | ImageBlock]
    isError: bool


# Agents, plugins and tools, as docs/spec/plugins.md describes.


@dataclass
class Tool:
    name: str
    description: str
    input_schema: JsonSchema
    # Called with the input and a ToolContext. Returns a ToolResult, or a string for one text block.
    run: Callable[[dict[str, Any], ToolContext], MaybeAwaitable[ToolResult | str]]

    def definition(self) -> ToolDefinition:
        return {"name": self.name, "description": self.description, "inputSchema": self.input_schema}


@dataclass
class ContextAddition:
    """What a plugin's `context` hook returns."""

    sections: list[Section] = field(default_factory=list)
    tools: list[Tool] = field(default_factory=list)


@dataclass
class Plugin:
    """A plugin is a name and any of five hooks. A hook left as None is skipped. A hook may be an
    `async def` or a plain function."""

    name: str
    context: Callable[[PluginContext], MaybeAwaitable[ContextAddition | None]] | None = None
    before_tool: Callable[[ToolCall, ToolContext], MaybeAwaitable[ToolResult | None]] | None = None
    after_tool: Callable[[ToolCall, ToolResult, ToolContext], MaybeAwaitable[ToolResult | None]] | None = None
    on_entry: Callable[[Entry, PluginContext], MaybeAwaitable[object]] | None = None
    on_session_end: Callable[[Session, PluginContext], MaybeAwaitable[object]] | None = None


type ToolExecution = Literal["concurrent", "serial"]


@dataclass
class AgentConfig:
    """An agent's configuration, as docs/spec/host.md describes."""

    id: str
    # `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5`.
    model: str
    plugins: list[Plugin] = field(default_factory=list)
    soft_limit: int = 120_000
    hard_limit: int = 180_000
    max_tokens: int = 8_192
    # Passed to providers that take it, such as Anthropic's `output_config.effort`. Optional.
    effort: str | None = None
    # How a turn's tool calls run: together, at most `max_concurrent_tools` at once, or one at a time.
    tool_execution: ToolExecution = "concurrent"
    max_concurrent_tools: int = 4
    # The parent of the agent's first session, such as the session that dispatched it: `session`,
    # `reason`, and optionally `entry` and `agent`, as docs/spec/sessions.md describes.
    parent: dict[str, str] | None = None


@dataclass
class PluginContext:
    agent: AgentConfig
    session: Session
    # Adds a `custom` entry to the open session now. Await it.
    append: Callable[[Entry], Awaitable[None]]
    # Queues an event for the next delivery point.
    deliver: Callable[[Event], None]
    # The run's stop signal, so that a long hook or tool can stop when the run is stopped.
    signal: StopSignal


@dataclass
class ToolContext(PluginContext):
    request_reset: Callable[[str | None], None] = lambda reason: None
    # Runs another call as the loop runs the model's calls, through the same hooks and under the
    # turn's limit, and returns its result without appending a `tool` message. The calling tool gives
    # up its place under the limit while it waits.
    run_tool: Callable[[ToolCall], Awaitable[ToolResult]] = lambda call: _no_runner(call)


async def _no_runner(call: ToolCall) -> ToolResult:
    raise RuntimeError("This context cannot run tools; only a tool's context from the loop can.")


class StopSignal:
    """Set by the host to stop a run, with who stopped it. The first `set` wins.

    `set` is safe from any task or thread: it wakes every waiter on its own event loop. A stop
    abandons a model call in flight at once, and stops a turn's calls that have not started.
    """

    def __init__(self) -> None:
        self.who: str | None = None
        self._lock = threading.Lock()
        self._waiters: list[tuple[asyncio.AbstractEventLoop, asyncio.Future[None]]] = []

    def set(self, who: str = "the host") -> None:
        with self._lock:
            if self.who is not None:
                return
            self.who = who
            waiters, self._waiters = self._waiters, []
        for loop, future in waiters:
            # A loop that has closed has nobody left waiting on it.
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(_finish, future)

    @property
    def is_set(self) -> bool:
        return self.who is not None

    def _when_set(self) -> asyncio.Future[None]:
        """A future on the running loop that is done once the signal is set."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        with self._lock:
            if self.who is None:
                # Leave out waiters that were cancelled, so a long run does not pile them up.
                self._waiters = [waiter for waiter in self._waiters if not waiter[1].done()]
                self._waiters.append((loop, future))
                return future
        future.set_result(None)
        return future

    async def wait(self, seconds: float | None = None) -> bool:
        """Waits until the signal is set, or up to `seconds`. Returns whether it is set."""
        try:
            async with asyncio.timeout(seconds):
                await self._when_set()
        except TimeoutError:
            return False
        return True

    async def unless_set[T](self, work: Awaitable[T]) -> T:
        """Awaits `work`, but abandons it and raises `Stopped` as soon as the signal is set, even when
        `work` ignores its cancellation."""
        task = asyncio.ensure_future(work)
        when_set = self._when_set()
        try:
            await asyncio.wait({task, when_set}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            when_set.cancel()
            cut_short = not task.done()
            if cut_short:
                task.cancel()
        if cut_short:
            raise Stopped(f"Stopped by {self.who}.")
        return task.result()


def _finish(future: asyncio.Future[None]) -> None:
    if not future.done():
        future.set_result(None)


class Stopped(Exception):
    """Raised when a stop signal cuts work short."""


@dataclass
class ProviderRequest:
    # The model name, without the provider prefix.
    model: str
    sections: list[Section]
    tools: list[ToolDefinition]
    messages: list[Message]
    max_tokens: int = 8_192
    output_schema: JsonSchema | None = None
    effort: str | None = None
    signal: StopSignal | None = None


class Provider(Protocol):
    """A provider turns a request into one API's format and the response back into a message."""

    async def complete(self, request: ProviderRequest) -> AssistantMessage: ...


type RunOutcome = Literal["idle", "reset", "stopped", "error"]
