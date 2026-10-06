"""The types flatbed holds: sessions and their entries, messages in flatbed's own format, and the
shapes of agents, plugins, tools and provider requests. docs/spec/ is the contract these follow.

Entries and messages are plain dicts at run time, so that they go to and from JSON unchanged. The
TypedDicts below say which keys they carry, with the spec's own field names.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, Protocol, TypedDict

type JsonSchema = dict[str, Any]

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
    run: Callable[[dict[str, Any], ToolContext], ToolResult | str]

    def definition(self) -> ToolDefinition:
        return {"name": self.name, "description": self.description, "inputSchema": self.input_schema}


@dataclass
class ContextAddition:
    """What a plugin's `context` hook returns."""

    sections: list[Section] = field(default_factory=list)
    tools: list[Tool] = field(default_factory=list)


@dataclass
class Plugin:
    """A plugin is a name and any of five hooks. A hook left as None is skipped."""

    name: str
    context: Callable[[PluginContext], ContextAddition | None] | None = None
    before_tool: Callable[[ToolCall, ToolContext], ToolResult | None] | None = None
    after_tool: Callable[[ToolCall, ToolResult, ToolContext], ToolResult | None] | None = None
    on_entry: Callable[[Entry, PluginContext], object] | None = None
    on_session_end: Callable[[Session, PluginContext], object] | None = None


@dataclass
class Agent:
    id: str
    # `<provider>/<model-name>`, such as `anthropic/claude-opus-5-5`.
    model: str
    plugins: list[Plugin] = field(default_factory=list)
    soft_limit: int = 120_000
    hard_limit: int = 180_000
    max_tokens: int = 8_192


@dataclass
class PluginContext:
    agent: Agent
    session: Session
    # Adds a `custom` entry, or an `event`, to the open session now.
    append: Callable[[Entry], None]
    # Queues an event for the next delivery point.
    deliver: Callable[[Event], None]


@dataclass
class ToolContext(PluginContext):
    request_reset: Callable[[str | None], None] = lambda reason: None


class StopSignal:
    """Set by the host, from any thread, to stop a run at its next turn. It records who stopped it."""

    def __init__(self) -> None:
        self.who: str | None = None

    def set(self, who: str) -> None:
        self.who = who

    @property
    def is_set(self) -> bool:
        return self.who is not None


@dataclass
class ProviderRequest:
    # The model name, without the provider prefix.
    model: str
    sections: list[Section]
    tools: list[ToolDefinition]
    messages: list[Message]
    max_tokens: int = 8_192
    output_schema: JsonSchema | None = None
    signal: StopSignal | None = None


class Provider(Protocol):
    """A provider turns a request into one API's format and the response back into a message."""

    def complete(self, request: ProviderRequest) -> AssistantMessage: ...


type RunOutcome = Literal["idle", "reset", "stopped", "error"]
