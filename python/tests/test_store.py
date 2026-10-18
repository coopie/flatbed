"""Stores and ids: what the conformance suite does not reach, such as reading a TypeScript session."""

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from flatbed import FileStore, path_of, render
from flatbed.store import new_session_id

FIXTURE = Path(__file__).parent / "fixtures" / "ts-session.jsonl"


class ReadsTypeScriptSessions(unittest.IsolatedAsyncioTestCase):
    async def test_a_session_written_by_the_typescript_core_reads_and_renders(self):
        # The fixture was written by ts/packages/core with the faux provider: one tool call, then an answer.
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "fixture").mkdir()
            (Path(root) / "fixture" / FIXTURE.name).write_bytes(FIXTURE.read_bytes())
            store = FileStore(root)
            [session_id] = await store.list("fixture")
            session = await store.read("fixture", session_id)

        self.assertEqual(session.header["agent"], "fixture")
        rendered = render(path_of(session.entries))
        self.assertEqual([tool["name"] for tool in rendered.tools], ["echo", "reset"])
        self.assertEqual(
            rendered.messages[0]["content"][1]["text"],
            '<message from="Ana">Echo &lt;hi&gt; &amp; bye</message>',
        )
        self.assertEqual(rendered.messages[1]["content"][0]["text"], "Let me echo — café.")
        self.assertEqual([m["role"] for m in rendered.messages], ["user", "assistant", "tool", "assistant"])

    async def test_a_session_written_by_python_has_the_same_line_shape(self):
        # Compact JSON with raw UTF-8, as JSON.stringify writes, so either core reads the other's files.
        source = FIXTURE.read_text(encoding="utf-8").splitlines()
        with tempfile.TemporaryDirectory() as root:
            store = FileStore(root)
            session = await FileStore(FIXTURE.parent.parent).read("fixtures", FIXTURE.stem)
            await store.create(session.header)
            for entry in session.entries:
                await store.append(session.header["agent"], session.header["id"], entry)
            written_file = Path(root) / "fixture" / f"{session.header['id']}.jsonl"
            written = written_file.read_text(encoding="utf-8").splitlines()
        self.assertEqual(written, source)


class SessionIds(unittest.TestCase):
    def test_an_id_made_in_the_same_second_sorts_after_the_previous_one(self):
        now = datetime(2026, 10, 6, 21, 4, 11, tzinfo=UTC)
        self.assertEqual(new_session_id(now, "2026-10-06T21-04-11Z-a3f9"), "2026-10-06T21-04-11Z-a3fa")
        self.assertTrue(new_session_id(now).startswith("2026-10-06T21-04-11Z-"))
        self.assertGreater(new_session_id(now, "2026-10-06T21-04-10Z-ffff"), "2026-10-06T21-04-10Z-ffff")


if __name__ == "__main__":
    unittest.main()
