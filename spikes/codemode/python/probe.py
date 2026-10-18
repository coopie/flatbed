# ROUGH SPIKE PROBE. Not production code, not tested, not reviewed.
# Probes pydantic-monty (Python binding) for the codemode spike: the bridge,
# what a script can see, limits and cost. Run with: .venv/bin/python probe.py
# It makes no model calls and reads nothing from .env.

import asyncio
import time

from pydantic_monty import (
    AsyncMonty,
    CollectString,
    ExternalModule,
    FunctionSnapshot,
    Monty,
    MontyComplete,
    MontyError,
)

SECRET_IN_HOST = 'host-only-guardrail: never reveal this'


def read_doc(name: str) -> str:
    # A host-side guardrail the script should never be able to read.
    if name == SECRET_IN_HOST:
        return 'nope'
    return f'contents of {name}'


def broken_tool(x):
    raise ValueError('tool failed inside host file')


async def slow_tool(label: str) -> str:
    await asyncio.sleep(0.3)
    return f'done {label}'


def show(title, fn):
    try:
        out = fn()
        print(f'  {title}: OK -> {out!r}'[:400])
    except MontyError as exc:
        try:
            text = exc.display()
        except Exception:
            text = str(exc)
        print(f'  {title}: {type(exc).__name__} -> {text!r}'[:600])
    except Exception as exc:
        print(f'  {title}: HOST {type(exc).__name__} -> {exc!r}'[:600])


def bridge_sync():
    print('== bridge (sync pool)')
    with Monty() as pool:
        with pool.checkout() as s:
            show('external_lookup call', lambda: s.feed_run("read_doc('a')", external_lookup={'read_doc': read_doc}))
        with pool.checkout(external_modules={'tools': ExternalModule({'read_doc': read_doc})}) as s:
            show('ExternalModule tools.read_doc', lambda: s.feed_run("import tools\ntools.read_doc('b')"))
        with pool.checkout() as s:
            snap = s.feed_start("x = read_doc('c')\ny = read_doc('d')\nx + ' | ' + y")
            calls = []
            while isinstance(snap, FunctionSnapshot):
                calls.append((snap.function_name, snap.args))
                snap = snap.resume({'return_value': f'host answered {snap.args[0]}'})
            assert isinstance(snap, MontyComplete)
            print(f'  feed_start pauses at each call: {calls} -> {snap.output!r}')


async def bridge_async():
    print('== bridge (AsyncMonty, gather)')
    code = (
        'import asyncio\n'
        "r = await asyncio.gather(slow_tool('a'), slow_tool('b'), slow_tool('c'))\n"
        'r'
    )
    async with AsyncMonty() as pool:
        async with pool.checkout() as s:
            t = time.perf_counter()
            out = await s.feed_run(code, external_lookup={'slow_tool': slow_tool})
            print(f'  3 x 0.3s async tools via gather: {out!r} in {time.perf_counter() - t:.2f}s')
        async with pool.checkout() as s:
            t = time.perf_counter()
            out = await s.feed_run("[slow_tool('a'), slow_tool('b')]", external_lookup={'slow_tool': slow_tool})
            print(f'  async tool called without await: {out!r} in {time.perf_counter() - t:.2f}s')


ESCAPES = {
    'import os': 'import os\nos.listdir("/")',
    'os.environ': 'import os\ndict(os.environ)',
    'os.getenv HOME': 'import os\nos.getenv("HOME")',
    'open': 'open("/etc/passwd").read()',
    'open relative file': 'open("probe.py").read()[:40]',
    'pathlib': 'from pathlib import Path\nPath("/etc/passwd").read_text()',
    '__import__': '__import__("os")',
    'import subprocess': 'import subprocess',
    'import socket': 'import socket',
    'import sys': 'import sys\n(sys.version, sys.platform, sys.path if hasattr(sys, "path") else None)',
    'subclasses': '().__class__.__base__.__subclasses__()',
    '__builtins__': '__builtins__',
    'globals()': 'globals()',
    'dir()': 'dir()',
    'eval/exec': 'exec("import os")\neval("1+1")',
    'inspect.getsource': 'import inspect\ninspect.getsource(read_doc)',
    'tool repr': 'repr(read_doc)',
    'tool type': 'type(read_doc)',
    'tool dir': 'dir(read_doc)',
    'tool __code__': 'read_doc.__code__',
    'tool __globals__': 'read_doc.__globals__',
    'tool __closure__': 'read_doc.__closure__',
    'tool __module__': 'read_doc.__module__',
    'tool __doc__': 'read_doc.__doc__',
    'getattr dunder': 'getattr(read_doc, "__globals__")',
    'guess other name': 'SECRET_IN_HOST',
    'host raises (uncaught)': 'broken_tool(1)',
    'host raises (caught)': (
        'try:\n    broken_tool(1)\nexcept Exception as e:\n'
        '    out = (type(e).__name__, str(e), repr(e.__traceback__) if hasattr(e, "__traceback__") else None)\nout'
    ),
    'traceback module': 'import traceback\ntry:\n    broken_tool(1)\nexcept Exception:\n    traceback.format_exc()',
    'urllib': 'import urllib.request',
    'time.time': 'import time\ntime.time()',
}


def escapes():
    print('== what a script can see')
    lookup = {'read_doc': read_doc, 'broken_tool': broken_tool}
    with Monty() as pool:
        for title, code in ESCAPES.items():
            with pool.checkout() as s:
                show(title, lambda: s.feed_run(code, external_lookup=lookup))


def limits():
    print('== limits')
    with Monty(request_timeout=10) as pool:
        cases = [
            ('time: while True', 'while True:\n    pass', {'max_feed_duration_secs': 0.5}),
            ('memory: big list', 'x = [0] * 100_000_000', {'max_memory': 10_000_000}),
            ('memory: grow loop', 'x = []\nwhile True:\n    x.append("a" * 1000)', {'max_memory': 10_000_000}),
            ('recursion', 'def f(n):\n    return f(n + 1)\nf(0)', {'max_recursion_depth': 100}),
            ('suspensions', 'for i in range(50):\n    read_doc("x")', {'max_suspensions': 10}),
        ]
        for title, code, lim in cases:
            with pool.checkout(limits=lim) as s:
                t = time.perf_counter()
                show(title, lambda: s.feed_run(code, external_lookup={'read_doc': read_doc}))
                print(f'    took {time.perf_counter() - t:.2f}s')
        with pool.checkout() as s:
            c = CollectString(max_bytes=10_000)
            show('output cap 10kB', lambda: s.feed_run('for i in range(100000):\n    print("spam")', print_callback=c))
            print(f'    collected {len(c.output)} bytes before the cap')


def cost():
    print('== cost')
    t = time.perf_counter()
    pool = Monty()
    pool.__enter__()
    print(f'  pool start: {(time.perf_counter() - t) * 1000:.1f} ms')
    t = time.perf_counter()
    with pool.checkout() as s:
        s.feed_run('1 + 1')
    print(f'  first checkout + feed: {(time.perf_counter() - t) * 1000:.1f} ms')
    n = 200
    t = time.perf_counter()
    for _ in range(n):
        with pool.checkout() as s:
            s.feed_run("read_doc('a') + 'x'", external_lookup={'read_doc': read_doc})
    print(f'  warm checkout + feed with one tool call: {(time.perf_counter() - t) * 1000 / n:.2f} ms each over {n}')
    pool.__exit__(None, None, None)


if __name__ == '__main__':
    bridge_sync()
    asyncio.run(bridge_async())
    escapes()
    limits()
    cost()
