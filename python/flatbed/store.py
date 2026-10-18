"""Session stores and ids.

The file store keeps each session as `<root>/<agent>/<session>.jsonl`, one JSON object per line:
the header, then the entries. The memory store keeps the same objects in a dict, for tests. Both
only ever create a session or append to one, never rewrite a line.

Stores are async, as everything in the core is. The file store does its file I/O in a worker thread,
so that a slow disk never blocks the event loop.
"""

from __future__ import annotations

import asyncio
import copy
import json
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .types import Entry, Header, Session


class Store(Protocol):
    async def list(self, agent: str) -> list[str]:
        """The agent's session ids, oldest first."""
        ...

    async def read(self, agent: str, session: str) -> Session: ...

    async def create(self, header: Header) -> None: ...

    async def append(self, agent: str, session: str, entry: Entry) -> None: ...


def now_iso() -> str:
    """The time now in UTC, as `2026-10-06T21:04:11.000Z`."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_entry_id() -> str:
    return secrets.token_hex(4)


def new_session_id(now: datetime, previous: str | None = None) -> str:
    """A session id such as `2026-10-06T21-04-11Z-a3f9`, which sorts after `previous`.

    When the clock has not moved on since the previous session, take the previous id's time and add
    one to its hex part, so that a directory listing still sorts by age.
    """
    time_part = f"{now.astimezone(UTC).strftime('%Y-%m-%dT%H-%M-%S')}Z"
    stem, _, hex_part = (previous or "").rpartition("-")
    if previous is None or time_part > stem:
        return f"{time_part}-{secrets.token_hex(2)}"
    following = int(hex_part, 16) + 1
    if following > 0xFFFF:
        raise ValueError(f"Cannot make a session id after {previous}.")
    return f"{stem}-{following:04x}"


def to_line(value: object) -> str:
    # Compact separators and raw UTF-8, as JSON.stringify writes, so the files look alike.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


def parse_session(text: str) -> Session:
    objects = [json.loads(line) for line in text.splitlines() if line.strip()]
    if not objects or objects[0].get("type") != "session":
        raise ValueError("A session file must start with a session header.")
    return Session(header=objects[0], entries=objects[1:])


class FileStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _file(self, agent: str, session: str) -> Path:
        return self.root / agent / f"{session}.jsonl"

    async def list(self, agent: str) -> list[str]:
        directory = self.root / agent

        def ids() -> list[str]:
            if not directory.is_dir():
                return []
            return sorted(path.stem for path in directory.glob("*.jsonl"))

        return await asyncio.to_thread(ids)

    async def read(self, agent: str, session: str) -> Session:
        text = await asyncio.to_thread(self._file(agent, session).read_text, encoding="utf-8")
        return parse_session(text)

    async def create(self, header: Header) -> None:
        path = self._file(header["agent"], header["id"])

        def write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Mode "x" fails when the file exists, so two sessions can never share an id.
            with path.open("x", encoding="utf-8") as file:
                file.write(to_line(header))

        await asyncio.to_thread(write)

    async def append(self, agent: str, session: str, entry: Entry) -> None:
        line = to_line(entry)

        def write() -> None:
            with self._file(agent, session).open("a", encoding="utf-8") as file:
                file.write(line)

        await asyncio.to_thread(write)


class MemoryStore:
    def __init__(self) -> None:
        self._sessions: dict[tuple[str, str], Session] = {}

    def _get(self, agent: str, session: str) -> Session:
        found = self._sessions.get((agent, session))
        if found is None:
            raise KeyError(f"No session {agent}/{session}.")
        return found

    async def list(self, agent: str) -> list[str]:
        return sorted(session for owner, session in self._sessions if owner == agent)

    async def read(self, agent: str, session: str) -> Session:
        # A copy, so that a caller holding a session never sees later appends change it.
        return copy.deepcopy(self._get(agent, session))

    async def create(self, header: Header) -> None:
        key = (header["agent"], header["id"])
        if key in self._sessions:
            raise ValueError(f"Session {header['id']} already exists.")
        self._sessions[key] = Session(header=copy.deepcopy(header), entries=[])

    async def append(self, agent: str, session: str, entry: Entry) -> None:
        self._get(agent, session).entries.append(copy.deepcopy(entry))
