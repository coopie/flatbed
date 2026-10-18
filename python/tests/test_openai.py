"""The OpenAI adapter's translation, and the retry rules every API provider shares."""

import unittest
from unittest import mock

import httpx

from flatbed import StopSignal
from flatbed.providers import http
from flatbed.providers.openai import from_openai, to_openai
from flatbed.types import ProviderRequest


class ToOpenAI(unittest.TestCase):
    def test_a_turn_with_a_call_and_its_result(self):
        request = ProviderRequest(
            model="gpt-test",
            sections=[{"name": "soul", "text": "You are kind."}, {"name": "today", "text": "Monday."}],
            tools=[{"name": "echo", "description": "Echo.", "inputSchema": {"type": "object"}}],
            messages=[
                {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "text": "Hmm.", "provider": "anthropic"},
                        {"type": "toolCall", "id": "c1", "name": "echo", "input": {"text": "hi"}},
                    ],
                    "model": "openai/gpt-test",
                    "usage": {"input": 1, "output": 1},
                    "stop": "toolUse",
                },
                {"role": "tool", "callId": "c1", "name": "echo", "content": [], "isError": False},
                # A failed call leaves an empty assistant message, which is left out.
                {
                    "role": "assistant",
                    "content": [],
                    "model": "openai/gpt-test",
                    "usage": {"input": 0, "output": 0},
                    "stop": "error",
                },
            ],
            effort="low",
        )
        body = to_openai(request)
        self.assertEqual(
            body["messages"],
            [
                {"role": "system", "content": "You are kind.\n\nMonday."},
                {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "echo", "arguments": '{"text": "hi"}'},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "c1", "content": "(no output)"},
            ],
        )
        self.assertEqual(body["tools"][0]["function"]["parameters"], {"type": "object"})
        self.assertEqual(body["reasoning_effort"], "low")


class FromOpenAI(unittest.TestCase):
    def test_calls_stops_and_cached_tokens(self):
        response = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "Let me check.",
                        "tool_calls": [
                            {"id": "c1", "function": {"name": "echo", "arguments": '{"text":"hi"}'}}
                        ],
                    },
                }
            ],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 7,
                "prompt_tokens_details": {"cached_tokens": 60},
            },
        }
        message = from_openai(response, "gpt-test")
        self.assertEqual(message["stop"], "toolUse")
        self.assertEqual(message["model"], "openai/gpt-test")
        self.assertEqual(message["usage"], {"input": 40, "output": 7, "cacheRead": 60})
        self.assertEqual(message["content"][1]["input"], {"text": "hi"})
        response["choices"][0]["finish_reason"] = "something_new"
        self.assertEqual(from_openai(response, "gpt-test")["stop"], "end")


class Retries(unittest.IsolatedAsyncioTestCase):
    async def post(self, statuses: list[int], signal: StopSignal | None = None) -> tuple[list[int], object]:
        """Posts against a fake server that answers with these statuses in turn, without real waits."""
        seen: list[int] = []

        def answer(request: httpx.Request) -> httpx.Response:
            status = statuses[len(seen)]
            seen.append(status)
            return httpx.Response(status, json={"ok": True})

        transport = httpx.MockTransport(answer)
        real_client = httpx.AsyncClient
        with (
            mock.patch.object(http.httpx, "AsyncClient", lambda **kw: real_client(transport=transport, **kw)),
            mock.patch.object(http.asyncio, "sleep", mock.AsyncMock()),
        ):
            try:
                result: object = await http.post_json("https://example.test", {}, {}, 1, signal)
            except RuntimeError as error:
                result = error
        return seen, result

    async def test_retries_the_listed_statuses_then_gives_up(self):
        seen, result = await self.post([408, 409, 429, 503])
        self.assertEqual(seen, [408, 409, 429, 503])
        self.assertIn("after 3 retries", str(result))

    async def test_does_not_retry_other_responses(self):
        seen, result = await self.post([400])
        self.assertEqual(seen, [400])
        self.assertIn("HTTP 400", str(result))

    async def test_a_stop_ends_the_backoff_wait(self):
        stop = StopSignal()
        stop.set("Sam")
        seen, result = await self.post([500, 200], stop)
        self.assertEqual(seen, [500])
        self.assertIn("stopped while waiting", str(result))


if __name__ == "__main__":
    unittest.main()
