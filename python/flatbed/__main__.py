"""A rough CLI for trying the core by hand. It is a one-off tool, not part of the core: no tests, few
checks, and output shaped for reading rather than parsing.

    python -m flatbed chat <agent>          talk to an agent in the terminal
    python -m flatbed view <session-file>   print a session as the model sees it

`chat` keeps sessions under `data/` at the repo root. It uses the model in FLATBED_MODEL, which
defaults to `anthropic/claude-sonnet-5-5`; `faux/echo` answers offline by echoing you. The key comes
from ANTHROPIC_API_KEY in .env at the repo root.
"""

import getpass
import json
import os
import sys
from pathlib import Path

from . import Agent, ContextAddition, FileStore, Plugin, Runner, parse_session, path_of, render
from .env import read_env
from .providers import AnthropicProvider, FauxProvider
from .types import Block, Message, Provider

DATA = Path(__file__).resolve().parents[2] / "data"


def block_text(block: Block) -> str:
    match block["type"]:
        case "text":
            return block["text"]
        case "toolCall":
            return f"[call {block['name']} {json.dumps(block['input'])}]"
        case "thinking":
            return f"[thinking] {block['text']}"
        case _:
            return f"[image {block['mimeType']}]"


def message_text(message: Message) -> str:
    body = "\n".join(block_text(block) for block in message["content"])
    if message["role"] == "tool":
        return f"--- tool {message['name']}{' (error)' if message['isError'] else ''}\n{body}"
    if message["role"] == "assistant":
        return f"--- assistant ({message['model']}, stop {message['stop']})\n{body}"
    return f"--- user\n{body}"


def echo_step(request):
    # An offline stand-in: echoes the last thing said.
    last = request.messages[-1] if request.messages else None
    text = (
        " ".join(b["text"] for b in last["content"] if b["type"] == "text")
        if last and last["role"] == "user"
        else ""
    )
    return {"content": [{"type": "text", "text": f"You said: {text}"}]}


def print_entry(entry, ctx) -> None:
    if entry["type"] == "message":
        message = entry["message"]
        if message["role"] == "assistant" and message["content"]:
            print("\n".join(block_text(block) for block in message["content"]))
        if message["role"] == "tool":
            print(f"[{message['name']}: {' '.join(block_text(block) for block in message['content'])}]")
    elif entry["type"] == "event" and entry["kind"] == "notice":
        print(f"[notice] {entry['text']}")
    elif entry["type"] == "reset":
        print(f"[reset by {entry['by']}{': ' + entry['reason'] if entry.get('reason') else ''}]")


def chat(agent_id: str) -> None:
    model = os.environ.get("FLATBED_MODEL", "anthropic/claude-sonnet-5-5")
    providers: dict[str, Provider] = {"faux": FauxProvider([echo_step] * 1000)}
    if api_key := read_env("ANTHROPIC_API_KEY"):
        providers["anthropic"] = AnthropicProvider(api_key)
    soul = f"You are {agent_id}, talking with a person in a terminal. Keep answers short."
    printer = Plugin(
        name="printer",
        context=lambda ctx: ContextAddition(sections=[{"name": "soul", "text": soul, "cache": True}]),
        on_entry=print_entry,
    )
    runner = Runner(Agent(id=agent_id, model=model, plugins=[printer]), FileStore(DATA), providers)
    print(f"Talking to {agent_id} on {model}. Sessions are in {DATA / agent_id}/. Press Ctrl-D to leave.")
    while True:
        try:
            line = input("> ")
        except EOFError:
            print()
            return
        if line.strip():
            runner.deliver({"kind": "message", "attrs": {"from": getpass.getuser()}, "text": line})
            runner.run()


def view(file: str) -> None:
    session = parse_session(Path(file).read_text(encoding="utf-8"))
    header = session.header
    parent = header.get("parent")
    after = f", after {parent['session']} ({parent['reason']})" if parent else ""
    print(f"session {header['id']} of {header['agent']}{after}")
    rendered = render(path_of(session.entries))
    for section in rendered.sections:
        print(f"--- section {section['name']}{' (cache)' if section.get('cache') else ''}\n{section['text']}")
    print(f"--- tools: {', '.join(tool['name'] for tool in rendered.tools)}")
    for message in rendered.messages:
        print(message_text(message))


def main(args: list[str]) -> int:
    match args:
        case ["chat", agent_id]:
            chat(agent_id)
        case ["view", file]:
            view(file)
        case _:
            print(
                "Usage: python -m flatbed chat <agent> | python -m flatbed view <session-file>",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
