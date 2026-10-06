"""Turning a session into what the model sees, as docs/spec/sessions.md describes.

Entries form a tree through `parentId`. The path runs from the root to the head, the last entry in
the file, and the model only ever sees the path. Rendering turns the path into the context entry and
a list of messages.
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import Entry, Event, Message, Section, ToolDefinition


def path_of(entries: list[Entry]) -> list[Entry]:
    """The entries from the root to the head, found by following `parentId` back from the head."""
    by_id = {entry["id"]: entry for entry in entries}
    path: list[Entry] = []
    entry = entries[-1] if entries else None
    while entry is not None:
        path.append(entry)
        parent_id = entry["parentId"]
        entry = by_id[parent_id] if parent_id is not None else None
    path.reverse()
    return path


def escape_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def escape_attr(text: str) -> str:
    return escape_text(text).replace('"', "&quot;")


def render_event(event: Event) -> str:
    """An event as an XML element, such as `<message from="Sam">Can you move my 3pm?</message>`."""
    attrs = event.get("attrs") or {}
    attr_text = "".join(f' {key}="{escape_attr(attrs[key])}"' for key in sorted(attrs))
    kind = event["kind"]
    return f"<{kind}{attr_text}>{escape_text(event['text'])}</{kind}>"


@dataclass
class Rendered:
    sections: list[Section]
    tools: list[ToolDefinition]
    messages: list[Message]


def render(path: list[Entry]) -> Rendered:
    sections: list[Section] = []
    tools: list[ToolDefinition] = []
    messages: list[Message] = []

    def add_user_block(text: str) -> None:
        # Neighbouring user messages merge into one, keeping block order.
        if messages and messages[-1]["role"] == "user":
            messages[-1]["content"].append({"type": "text", "text": text})
        else:
            messages.append({"role": "user", "content": [{"type": "text", "text": text}]})

    for entry in path:
        match entry["type"]:
            case "context":
                sections, tools = entry["sections"], entry["tools"]
            case "message":
                message = entry["message"]
                if message["role"] == "user" and messages and messages[-1]["role"] == "user":
                    messages[-1]["content"].extend(message["content"])
                elif message["role"] == "user":
                    messages.append({"role": "user", "content": list(message["content"])})
                else:
                    messages.append(message)
            case "event":
                add_user_block(render_event(entry))
            case "reset" | "custom":
                pass
            case other:
                raise ValueError(f"Unknown entry type {other!r}.")
    return Rendered(sections=sections, tools=tools, messages=messages)
