"""The Anthropic Messages API over plain HTTP, with urllib from the standard library.

Sections become system blocks, `tool` messages become `tool_result` blocks inside user messages, and
`output_schema` becomes `output_config.format`. docs/spec/providers.md is the contract.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from ..types import AssistantMessage, Block, Message, ProviderRequest

API_URL = "https://api.anthropic.com/v1/messages"
RETRIES = 3
EPHEMERAL = {"type": "ephemeral"}
STOPS = {"end_turn": "end", "tool_use": "toolUse", "max_tokens": "maxTokens"}


class AnthropicProvider:
    def __init__(self, api_key: str, url: str = API_URL, timeout: float = 600) -> None:
        self._api_key = api_key
        self.url = url
        self.timeout = timeout

    def complete(self, request: ProviderRequest) -> AssistantMessage:
        response = self._post(to_anthropic(request), request)
        return from_anthropic(response, request.model)

    def _post(self, body: dict[str, Any], request: ProviderRequest) -> Any:
        """POSTs the body, retrying rate limits, server errors and network failures with backoff."""
        data = json.dumps(body).encode()
        headers = {
            "content-type": "application/json",
            "x-api-key": self._api_key,
            "anthropic-version": "2023-06-01",
        }
        for attempt in range(RETRIES + 1):
            try:
                http_request = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
                with urllib.request.urlopen(http_request, timeout=self.timeout) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                # The error body is the API's message; it never holds the request's headers.
                failure = f"HTTP {error.code}: {error.read().decode(errors='replace')[:500]}"
                if error.code != 429 and error.code < 500:
                    raise RuntimeError(failure) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                failure = f"Network error: {error}"
            if attempt == RETRIES or (request.signal and request.signal.is_set):
                raise RuntimeError(f"{failure} (after {attempt} retries)")
            time.sleep(2**attempt)
        raise AssertionError("unreachable")


def to_anthropic(request: ProviderRequest) -> dict[str, Any]:
    """The request body for the Messages API."""
    body: dict[str, Any] = {
        "model": request.model,
        "max_tokens": request.max_tokens,
        "system": [
            {"type": "text", "text": section["text"], **({"cache_control": EPHEMERAL} if section.get("cache") else {})}
            for section in request.sections
        ],
        "messages": to_anthropic_messages(request.messages),
    }
    if request.tools:
        tools = [
            {"name": tool["name"], "description": tool["description"], "input_schema": tool["inputSchema"]}
            for tool in request.tools
        ]
        # A cache breakpoint after the tool list.
        tools[-1]["cache_control"] = EPHEMERAL
        body["tools"] = tools
    if request.output_schema is not None:
        body["output_config"] = {"format": {"type": "json_schema", "schema": request.output_schema}}
    return body


def to_anthropic_messages(messages: list[Message]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def push(role: str, content: list[dict[str, Any]]) -> None:
        # The API wants roles to alternate, so neighbouring messages of one role merge.
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(content)
        else:
            out.append({"role": role, "content": content})

    for message in messages:
        if message["role"] == "user":
            push("user", [to_anthropic_block(block) for block in message["content"]])
        elif message["role"] == "tool":
            result = {
                "type": "tool_result",
                "tool_use_id": message["callId"],
                "content": [to_anthropic_block(block) for block in message["content"]],
                "is_error": message["isError"],
            }
            push("user", [result])
        else:
            content = [api for block in message["content"] if (api := to_anthropic_assistant_block(block))]
            # An assistant message left empty by a failed call has nothing to send, and the API rejects it.
            if content:
                push("assistant", content)
    return out


def to_anthropic_block(block: Block) -> dict[str, Any]:
    if block["type"] == "text":
        return {"type": "text", "text": block["text"]}
    if block["type"] == "image":
        return {"type": "image", "source": {"type": "base64", "media_type": block["mimeType"], "data": block["data"]}}
    raise ValueError(f"A {block['type']} block cannot go in a user message.")


def to_anthropic_assistant_block(block: Block) -> dict[str, Any] | None:
    match block["type"]:
        case "toolCall":
            return {"type": "tool_use", "id": block["id"], "name": block["name"], "input": block["input"]}
        case "thinking":
            # Thinking goes back only to the provider that made it.
            if block.get("provider") != "anthropic":
                return None
            return {"type": "thinking", "thinking": block["text"], "signature": block.get("signature", "")}
        case _:
            return to_anthropic_block(block)


def from_anthropic(response: Any, model: str) -> AssistantMessage:
    """The assistant message for a response. Checks the response's shape, since it comes from outside."""
    if not isinstance(response, dict) or not isinstance(response.get("content"), list):
        raise RuntimeError("The Anthropic response had no content.")
    usage = response.get("usage")
    if not isinstance(usage, dict) or not isinstance(usage.get("input_tokens"), int):
        raise RuntimeError("The Anthropic response had no usage.")

    content: list[Block] = []
    for block in response["content"]:
        match block.get("type"):
            case "text":
                content.append({"type": "text", "text": str(block["text"])})
            case "tool_use":
                content.append(
                    {"type": "toolCall", "id": str(block["id"]), "name": str(block["name"]), "input": block["input"]}
                )
            case "thinking":
                content.append(
                    {
                        "type": "thinking",
                        "text": str(block["thinking"]),
                        "signature": str(block.get("signature", "")),
                        "provider": "anthropic",
                    }
                )
            # Other blocks, such as redacted thinking, are left out.

    flatbed_usage: Any = {"input": usage["input_tokens"], "output": usage.get("output_tokens", 0)}
    if isinstance(usage.get("cache_read_input_tokens"), int):
        flatbed_usage["cacheRead"] = usage["cache_read_input_tokens"]
    if isinstance(usage.get("cache_creation_input_tokens"), int):
        flatbed_usage["cacheWrite"] = usage["cache_creation_input_tokens"]
    return {
        "role": "assistant",
        "content": content,
        "model": f"anthropic/{model}",
        "usage": flatbed_usage,
        "stop": STOPS.get(response.get("stop_reason"), "end"),
    }
