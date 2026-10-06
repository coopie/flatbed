# /// script
# requires-python = ">=3.13"
# dependencies = ["mcp>=1.20,<2"]
# ///
"""A tiny MCP server with two invented tools, to show a Python tool joining a flatbed agent.

Run it with `uv run server.py`. It speaks MCP over stdio, so an agent's mcp plugin starts it as a
command. Pass `--http` to serve streamable HTTP on http://127.0.0.1:8000/mcp instead.
"""

import sys

from mcp.server.fastmcp import FastMCP

server = FastMCP("units")

METRES_PER = {"mm": 0.001, "cm": 0.01, "m": 1.0, "km": 1000.0, "in": 0.0254, "ft": 0.3048, "mi": 1609.344}


@server.tool()
def convert_length(value: float, from_unit: str, to_unit: str) -> str:
    """Convert a length between units. Units: mm, cm, m, km, in, ft, mi."""
    for unit in (from_unit, to_unit):
        if unit not in METRES_PER:
            raise ValueError(f"Unknown unit {unit}. Use one of: {', '.join(METRES_PER)}.")
    result = value * METRES_PER[from_unit] / METRES_PER[to_unit]
    return f"{value:g} {from_unit} is {result:.6g} {to_unit}"


@server.tool()
def convert_temperature(value: float, from_unit: str, to_unit: str) -> str:
    """Convert a temperature between C, F and K."""
    to_kelvin = {"C": lambda v: v + 273.15, "F": lambda v: (v - 32) * 5 / 9 + 273.15, "K": lambda v: v}
    from_kelvin = {"C": lambda k: k - 273.15, "F": lambda k: (k - 273.15) * 9 / 5 + 32, "K": lambda k: k}
    if from_unit not in to_kelvin or to_unit not in from_kelvin:
        raise ValueError("Use C, F or K.")
    result = from_kelvin[to_unit](to_kelvin[from_unit](value))
    return f"{value:g} {from_unit} is {result:.4g} {to_unit}"


if __name__ == "__main__":
    server.run("streamable-http" if "--http" in sys.argv else "stdio")
