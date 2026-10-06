"""Providers turn flatbed's messages into one API's request and back. See docs/spec/providers.md."""

from .anthropic import AnthropicProvider
from .faux import FauxProvider

__all__ = ["AnthropicProvider", "FauxProvider"]
