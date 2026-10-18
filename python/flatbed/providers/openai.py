"""Any chat-completions-compatible endpoint over plain HTTP, with httpx's async client.

Sections join into one system message, tool calls go as `tool_calls` with JSON-encoded arguments,
and `tool` messages stay `tool` messages. docs/spec/providers.md is the contract.
"""

from __future__ import annotations

import json
from typing import Any

from ..types import AssistantMessage, Block, Message, ProviderRequest
from .http import post_json

BASE_URL = "https://api.openai.com/v1"
STOPS = {"tool_calls": "toolUse", "length": "maxTokens", "content_filter": "refusal"}


class OpenAIProvider:
    def __init__(self, api_key: str, base_url: str = BASE_URL, timeout: float = 600) -> None:
        self._api_key = api_key
        self.url = f"{base_url.rstrip('/')}/chat/completions"
        self.timeout = timeout

    async def complete(self, request: ProviderRequest) -> AssistantMessage:
        headers = {"authorization": f"Bearer {self._api_key}"}
        response = await post_json(self.url, to_openai(request), headers, self.timeout, request.signal)
        return from_openai(response, request.model)


def to_openai(request: ProviderRequest) -> dict[str, Any]:
    """The request body for the chat completions API."""
    system = "\n\n".join(section["text"] for section in request.sections if section["text"])
    messages = [{"role": "system", "content": system}] if system else []
    messages.extend(api for message in request.messages if (api := to_openai_message(message)))
    body: dict[str, Any] = {"model": request.model, "max_tokens": request.max_tokens, "messages": messages}
    if request.tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["inputSchema"],
                },
            }
            for tool in request.tools
        ]
    if request.output_schema is not None:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "output", "schema": request.output_schema, "strict": True},
        }
    if request.effort is not None:
        body["reasoning_effort"] = request.effort
    return body


def to_openai_message(message: Message) -> dict[str, Any] | None:
    """One message in the API's format, or None for an assistant message with nothing to send."""
    if message["role"] == "user":
        return {"role": "user", "content": [to_openai_part(block) for block in message["content"]]}
    if message["role"] == "tool":
        # Tool messages take text only.
        text = "\n".join(block["text"] for block in message["content"] if block["type"] == "text")
        return {"role": "tool", "tool_call_id": message["callId"], "content": text or "(no output)"}
    text = "".join(block["text"] for block in message["content"] if block["type"] == "text")
    calls = [
        {
            "id": block["id"],
            "type": "function",
            "function": {"name": block["name"], "arguments": json.dumps(block["input"])},
        }
        for block in message["content"]
        if block["type"] == "toolCall"
    ]
    # Thinking is left out, since it goes back only to the provider that made it. An assistant message
    # left empty by a failed call has nothing to send.
    if not text and not calls:
        return None
    api: dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:
        api["tool_calls"] = calls
    return api


def to_openai_part(block: Block) -> dict[str, Any]:
    if block["type"] == "text":
        return {"type": "text", "text": block["text"]}
    if block["type"] == "image":
        url = f"data:{block['mimeType']};base64,{block['data']}"
        return {"type": "image_url", "image_url": {"url": url}}
    raise ValueError(f"A {block['type']} block cannot go in a user message.")


def from_openai(response: Any, model: str) -> AssistantMessage:
    """The assistant message for a response. Checks the response's shape, since it comes from outside."""
    choices = response.get("choices") if isinstance(response, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0].get("message"), dict):
        raise RuntimeError("The OpenAI response had no choices.")
    choice = choices[0]
    content: list[Block] = []
    if isinstance(choice["message"].get("content"), str) and choice["message"]["content"]:
        content.append({"type": "text", "text": choice["message"]["content"]})
    for call in choice["message"].get("tool_calls") or []:
        # Arguments that are not JSON fail the model call, as a response we cannot read.
        try:
            arguments = json.loads(call["function"].get("arguments") or "{}")
        except json.JSONDecodeError as error:
            raise RuntimeError(f"The OpenAI response had arguments that are not JSON: {error}") from error
        content.append(
            {
                "type": "toolCall",
                "id": str(call["id"]),
                "name": str(call["function"]["name"]),
                "input": arguments,
            }
        )

    usage = response.get("usage") or {}
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    # OpenAI counts cached tokens inside prompt_tokens; flatbed counts them apart, as Anthropic does.
    flatbed_usage: Any = {
        "input": usage.get("prompt_tokens", 0) - cached,
        "output": usage.get("completion_tokens", 0),
    }
    if cached:
        flatbed_usage["cacheRead"] = cached
    return {
        "role": "assistant",
        "content": content,
        "model": f"openai/{model}",
        "usage": flatbed_usage,
        "stop": STOPS.get(choice.get("finish_reason"), "end"),
    }
