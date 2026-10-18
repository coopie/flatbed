"""The Anthropic adapter's translation, which the conformance suite cannot reach."""

import unittest

from flatbed.providers.anthropic import from_anthropic, to_anthropic
from flatbed.types import ProviderRequest


def request(**changes) -> ProviderRequest:
    base = ProviderRequest(
        model="claude-sonnet-5-5",
        sections=[
            {"name": "soul", "text": "You are kind.", "cache": True},
            {"name": "today", "text": "Monday."},
        ],
        tools=[{"name": "echo", "description": "Echo.", "inputSchema": {"type": "object"}}],
        messages=[],
    )
    for key, value in changes.items():
        setattr(base, key, value)
    return base


class ToAnthropic(unittest.TestCase):
    def test_sections_become_system_blocks_with_cache_breakpoints(self):
        body = to_anthropic(request())
        self.assertEqual(
            body["system"],
            [
                {"type": "text", "text": "You are kind.", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "Monday."},
            ],
        )
        self.assertEqual(body["tools"][-1]["cache_control"], {"type": "ephemeral"})
        self.assertNotIn("output_config", body)

    def test_cache_breakpoints_stop_at_four_with_the_earliest_sections(self):
        sections = [{"name": f"s{i}", "text": f"Part {i}.", "cache": True} for i in range(5)]
        sections.append({"name": "empty", "text": ""})
        messages = [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}]
        body = to_anthropic(request(sections=sections, messages=messages, effort="low"))
        self.assertEqual(len(body["system"]), 5)  # The empty section is left out.
        marked = [block["text"] for block in body["system"] if "cache_control" in block]
        self.assertEqual(marked, ["Part 0.", "Part 1."])
        self.assertIn("cache_control", body["tools"][-1])
        self.assertEqual(body["cache_control"], {"type": "ephemeral"})  # The history.
        self.assertEqual(body["output_config"], {"effort": "low"})

    def test_no_sections_leave_out_the_system_prompt(self):
        body = to_anthropic(request(sections=[{"name": "empty", "text": ""}]))
        self.assertNotIn("system", body)

    def test_a_tool_result_with_no_text_says_so(self):
        messages = [
            {
                "role": "tool",
                "callId": "c1",
                "name": "echo",
                "content": [{"type": "text", "text": ""}],
                "isError": False,
            }
        ]
        body = to_anthropic(request(messages=messages))
        self.assertEqual(
            body["messages"][0]["content"][0]["content"], [{"type": "text", "text": "(no output)"}]
        )

    def test_tool_results_go_first_in_a_user_message_and_empty_messages_are_left_out(self):
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": ""},
                    {"type": "thinking", "text": "hmm", "signature": "sig", "provider": "anthropic"},
                    {"type": "thinking", "text": "elsewhere", "provider": "openai"},
                    {"type": "toolCall", "id": "c1", "name": "echo", "input": {"text": "x"}},
                ],
                "model": "anthropic/claude-sonnet-5-5",
                "usage": {"input": 1, "output": 1},
                "stop": "toolUse",
            },
            {"role": "user", "content": [{"type": "text", "text": "<notice>Late.</notice>"}]},
            {
                "role": "tool",
                "callId": "c1",
                "name": "echo",
                "content": [{"type": "text", "text": "x"}],
                "isError": False,
            },
            {
                "role": "assistant",
                "content": [],
                "model": "anthropic/x",
                "usage": {"input": 0, "output": 0},
                "stop": "error",
            },
        ]
        body = to_anthropic(request(messages=messages))
        self.assertEqual([m["role"] for m in body["messages"]], ["user", "assistant", "user"])
        self.assertEqual(
            body["messages"][1]["content"],
            [
                {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                {"type": "tool_use", "id": "c1", "name": "echo", "input": {"text": "x"}},
            ],
        )
        self.assertEqual(
            body["messages"][2]["content"],
            [
                {
                    "type": "tool_result",
                    "tool_use_id": "c1",
                    "content": [{"type": "text", "text": "x"}],
                    "is_error": False,
                },
                {"type": "text", "text": "<notice>Late.</notice>"},
            ],
        )

    def test_an_output_schema_becomes_output_config(self):
        schema = {"type": "object", "properties": {}, "additionalProperties": False}
        body = to_anthropic(request(output_schema=schema))
        self.assertEqual(body["output_config"], {"format": {"type": "json_schema", "schema": schema}})


class FromAnthropic(unittest.TestCase):
    def test_a_response_becomes_an_assistant_message(self):
        response = {
            "content": [
                {"type": "thinking", "thinking": "plan", "signature": "s1"},
                {"type": "text", "text": "Calling."},
                {"type": "tool_use", "id": "toolu_1", "name": "echo", "input": {"text": "x"}},
            ],
            "stop_reason": "tool_use",
            "usage": {
                "input_tokens": 12,
                "output_tokens": 4,
                "cache_read_input_tokens": 3,
                "cache_creation_input_tokens": None,
            },
        }
        self.assertEqual(
            from_anthropic(response, "claude-sonnet-5-5"),
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "text": "plan", "signature": "s1", "provider": "anthropic"},
                    {"type": "text", "text": "Calling."},
                    {"type": "toolCall", "id": "toolu_1", "name": "echo", "input": {"text": "x"}},
                ],
                "model": "anthropic/claude-sonnet-5-5",
                "usage": {"input": 12, "output": 4, "cacheRead": 3},
                "stop": "toolUse",
            },
        )

    def test_stops_map_and_unknown_ones_become_end(self):
        def stop_for(reason):
            response = {
                "content": [],
                "stop_reason": reason,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }
            return from_anthropic(response, "m")["stop"]

        self.assertEqual(stop_for("end_turn"), "end")
        self.assertEqual(stop_for("max_tokens"), "maxTokens")
        self.assertEqual(stop_for("refusal"), "refusal")
        self.assertEqual(stop_for("pause_turn"), "end")

    def test_a_response_without_usage_is_an_error(self):
        with self.assertRaises(RuntimeError):
            from_anthropic({"content": []}, "m")


if __name__ == "__main__":
    unittest.main()
