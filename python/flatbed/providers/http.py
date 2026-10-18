"""The POST every API provider makes, with the retry rules docs/spec/providers.md gives them all."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any

import httpx

from ..types import Stopped, StopSignal

RETRIES = 3
# Statuses worth trying again: a timeout, a conflict, a rate limit, and any server error.
RETRY_STATUSES = {408, 409, 429}
STOPPED = "The request was stopped."


async def post_json(
    url: str, body: Any, headers: dict[str, str], timeout: float, signal: StopSignal | None
) -> Any:
    """POSTs the body and returns the response's JSON, retrying up to three times after 1, 2 and 4
    seconds. A stop ends a request in flight or a backoff wait at once, with `Stopped`."""
    # A client per call: a model call takes seconds, so pooling saves little, and a client never
    # outlives the event loop it was made on.
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(RETRIES + 1):
            try:
                response = await until_stopped(client.post(url, json=body, headers=headers), signal)
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
            await until_stopped(asyncio.sleep(2**attempt), signal)
    raise AssertionError("unreachable")


async def until_stopped[T](work: Awaitable[T], signal: StopSignal | None) -> T:
    """Awaits `work`, or raises `Stopped("The request was stopped.")` as soon as the signal is set."""
    if signal is None:
        return await work
    try:
        return await signal.unless_set(work)
    except Stopped:
        raise Stopped(STOPPED) from None


def message_of(error: BaseException) -> str:
    # httpx's timeouts can carry an empty message.
    return str(error) or type(error).__name__
