"""A scripted fake model for tests.

It answers each request with the next scripted message, or calls the next scripted function with the
request, and records every request it receives. docs/spec/providers.md describes it.
"""

from __future__ import annotations

import copy
import dataclasses
from collections.abc import Callable
from typing import Any

from ..types import AssistantMessage, ProviderRequest

# A scripted step is a partial assistant message with at least `content`, or a function of the request
# that returns one.
type Scripted = dict[str, Any]
type ScriptStep = Scripted | Callable[[ProviderRequest], Scripted]


class FauxProvider:
    def __init__(self, script: list[ScriptStep]) -> None:
        self.steps = list(script)
        self.requests: list[ProviderRequest] = []

    async def complete(self, request: ProviderRequest) -> AssistantMessage:
        self.requests.append(copy.deepcopy(dataclasses.replace(request, signal=None)))
        if not self.steps:
            raise RuntimeError("No more scripted responses.")
        step = self.steps.pop(0)
        scripted = step(request) if callable(step) else step
        content = scripted["content"]
        has_call = any(block["type"] == "toolCall" for block in content)
        return {
            "role": "assistant",
            "content": content,
            "model": f"faux/{request.model}",
            "usage": scripted.get("usage", {"input": 0, "output": 0}),
            "stop": scripted.get("stop", "toolUse" if has_call else "end"),
        }
