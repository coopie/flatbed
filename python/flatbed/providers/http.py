"""The POST every API provider makes, with the retry rules docs/spec/providers.md gives them all."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from ..types import StopSignal

RETRIES = 3
# Statuses worth trying again: a timeout, a conflict, a rate limit, and any server error.
RETRY_STATUSES = {408, 409, 429}


async def post_json(
    url: str, body: Any, headers: dict[str, str], timeout: float, signal: StopSignal | None
) -> Any:
    """POSTs the body and returns the response's JSON, retrying up to three times after 1, 2 and 4
    seconds. A stop ends a backoff wait at once."""
    # A client per call: a model call takes seconds, so pooling saves little, and a client never
    # outlives the event loop it was made on.
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(RETRIES + 1):
            try:
                response = await client.post(url, json=body, headers=headers)
                if response.is_success:
                    return response.json()
                # The error body is the API's message; it never holds the request's headers.
                failure = f"HTTP {response.status_code}: {response.text[:500]}"
                if response.status_code not in RETRY_STATUSES and response.status_code < 500:
                    raise RuntimeError(failure)
            except httpx.TransportError as error:
                # No response came back, such as a refused connection or a timeout.
                failure = f"Network error: {message_of(error)}"
            if attempt == RETRIES:
                raise RuntimeError(f"{failure} (after {attempt} retries)")
            if signal is None:
                await asyncio.sleep(2**attempt)
            elif await signal.wait(2**attempt):
                raise RuntimeError(f"{failure} (stopped while waiting to retry)")
    raise AssertionError("unreachable")


def message_of(error: BaseException) -> str:
    # httpx's timeouts can carry an empty message.
    return str(error) or type(error).__name__
