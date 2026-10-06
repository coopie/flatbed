"""Reads settings from .env at the repo root, for the CLI and the live test.

It returns values to code and never prints them.
"""

import os
import re
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def read_env(name: str) -> str | None:
    """One value from .env at the repo root, falling back to the environment."""
    try:
        text = ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        text = ""
    for line in text.splitlines():
        match = LINE.match(line)
        if match and match.group(1) == name:
            return re.sub(r"^(['\"])(.*)\1$", r"\2", match.group(2))
    return os.environ.get(name)
