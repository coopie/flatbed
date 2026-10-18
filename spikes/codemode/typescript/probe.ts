// ROUGH SPIKE PROBE. Not production code, not tested, not reviewed.
// Probes @pydantic/monty (TypeScript binding) for the codemode spike: the
// bridge, what a script can see, limits and cost. Run with: node probe.ts
// It makes no model calls and reads nothing from .env.

import { CollectString, ExternalModule, FunctionSnapshot, Monty, MontyComplete, MontyError } from '@pydantic/monty'

const SECRET_IN_HOST = 'host-only-guardrail: never reveal this'

function readDoc(name: string): string {
  // A host-side guardrail the script should never be able to read.
  if (name === SECRET_IN_HOST) return 'nope'
  return `contents of ${name}`
}

function brokenTool(_x: unknown): never {
  const err = new Error(`tool failed inside host file ${import.meta.url}`)
  err.name = 'ValueError'
  throw err
}

function brokenToolTypeError(_x: unknown): never {
  // An error the host did not shape: a real TypeError with a host stack.
  return (null as any).boom
}

async function slowTool(label: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 300))
  return `done ${label}`
}

const lookup = { read_doc: readDoc, broken_tool: brokenTool, broken_type_error: brokenToolTypeError, slow_tool: slowTool }

function describe(err: unknown): string {
  if (err instanceof MontyError) {
    const anyErr = err as any
    return `${err.constructor.name} -> ${JSON.stringify(typeof anyErr.display === 'function' ? anyErr.display() : String(err))}`
  }
  return `HOST ${(err as Error)?.name} -> ${JSON.stringify(String(err))}`
}

async function show(title: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn()
    console.log(`  ${title}: OK -> ${JSON.stringify(out)}`.slice(0, 400))
  } catch (err) {
    console.log(`  ${title}: ${describe(err)}`.slice(0, 700))
  }
}

async function bridge(pool: Monty) {
  console.log('== bridge')
  {
    await using s = await pool.checkout()
    await show('externalLookup call', () => s.feedRun("read_doc('a')", { externalLookup: lookup }))
  }
  {
    await using s = await pool.checkout({ externalModules: { tools: new ExternalModule({ read_doc: readDoc }) } })
    await show('ExternalModule tools.read_doc', () => s.feedRun("import tools\ntools.read_doc('b')"))
  }
  {
    await using s = await pool.checkout()
    let snap = await s.feedStart("x = read_doc('c')\ny = read_doc('d')\nx + ' | ' + y")
    const calls: unknown[] = []
    while (snap instanceof FunctionSnapshot) {
      calls.push([snap.functionName, snap.args])
      snap = await snap.resume(`host answered ${snap.args[0]}`)
    }
    if (!(snap instanceof MontyComplete)) throw new Error('expected completion')
    console.log(`  feedStart pauses at each call: ${JSON.stringify(calls)} -> ${JSON.stringify(snap.output)}`)
  }
  {
    await using s = await pool.checkout()
    const t = performance.now()
    const out = await s.feedRun(
      "import asyncio\nr = await asyncio.gather(slow_tool('a'), slow_tool('b'), slow_tool('c'))\nr",
      { externalLookup: lookup },
    )
    console.log(`  3 x 0.3s async tools via gather: ${JSON.stringify(out)} in ${((performance.now() - t) / 1000).toFixed(2)}s`)
  }
  {
    await using s = await pool.checkout()
    const t = performance.now()
    const out = await s.feedRun("[slow_tool('a'), slow_tool('b')]", { externalLookup: lookup })
    console.log(`  async tool called without await: ${JSON.stringify(out)} in ${((performance.now() - t) / 1000).toFixed(2)}s`)
  }
}

const ESCAPES: Record<string, string> = {
  'import os': 'import os\nos.listdir("/")',
  'os.environ': 'import os\ndict(os.environ)',
  'os.getenv HOME': 'import os\nos.getenv("HOME")',
  open: 'open("/etc/passwd").read()',
  'open relative file': 'open("probe.ts").read()[:40]',
  __import__: '__import__("os")',
  'import subprocess': 'import subprocess',
  subclasses: '().__class__.__base__.__subclasses__()',
  'globals()': 'globals()',
  'eval/exec': 'exec("import os")\neval("1+1")',
  'inspect.getsource': 'import inspect\ninspect.getsource(read_doc)',
  'tool repr': 'repr(read_doc)',
  'tool str': 'str(read_doc)',
  'tool type': 'type(read_doc)',
  'tool __code__': 'read_doc.__code__',
  'tool __globals__': 'read_doc.__globals__',
  'getattr dunder': 'getattr(read_doc, "__globals__")',
  'tool returned to host': 'read_doc',
  'guess other name': 'SECRET_IN_HOST',
  'guess JS global': 'process',
  'host raises shaped (uncaught)': 'broken_tool(1)',
  'host raises shaped (caught)': 'try:\n    broken_tool(1)\nexcept Exception as e:\n    out = (type(e).__name__, str(e))\nout',
  'host raises TypeError (caught)': 'try:\n    broken_type_error(1)\nexcept Exception as e:\n    out = (type(e).__name__, str(e))\nout',
  'urllib': 'import urllib.request',
  'time.time': 'import time\ntime.time()',
}

async function escapes(pool: Monty) {
  console.log('== what a script can see')
  for (const [title, code] of Object.entries(ESCAPES)) {
    let s
    try {
      s = await pool.checkout()
    } catch (err) {
      console.log(`  ${title}: CHECKOUT FAILED -> ${String(err)}`)
      continue
    }
    await show(title, () => s.feedRun(code, { externalLookup: lookup }))
    const t = performance.now()
    await s[Symbol.asyncDispose]()
    const ms = performance.now() - t
    if (ms > 50) console.log(`    returning this checkout took ${ms.toFixed(0)} ms`)
  }
  // A JS object handed in as an input: do its methods or prototype leak?
  {
    await using s = await pool.checkout()
    const cfg = { retries: 3, secret: () => SECRET_IN_HOST }
    await show('object input with a method', () => s.feedRun('cfg', { inputs: { cfg } }))
  }
}

async function limits() {
  console.log('== limits')
  await using pool = await Monty.create({ requestTimeout: 10 })
  const cases: [string, string, Record<string, number>][] = [
    ['time: while True', 'while True:\n    pass', { maxFeedDurationSecs: 0.5 }],
    ['memory: big list', 'x = [0] * 100_000_000', { maxMemory: 10_000_000 }],
    ['memory: grow loop', 'x = []\nwhile True:\n    x.append("a" * 1000)', { maxMemory: 10_000_000 }],
    ['recursion', 'def f(n):\n    return f(n + 1)\nf(0)', { maxRecursionDepth: 100 }],
    ['suspensions', 'for i in range(50):\n    read_doc("x")', { maxSuspensions: 10 }],
  ]
  for (const [title, code, lim] of cases) {
    await using s = await pool.checkout({ limits: lim })
    const t = performance.now()
    await show(title, () => s.feedRun(code, { externalLookup: lookup }))
    console.log(`    took ${((performance.now() - t) / 1000).toFixed(2)}s`)
  }
  {
    await using s = await pool.checkout()
    const c = new CollectString(10_000)
    await show('output cap 10kB', () => s.feedRun('for i in range(100000):\n    print("spam")', { printCallback: c }))
    console.log(`    collected ${c.output.length} bytes before the cap`)
  }
}

async function cost() {
  console.log('== cost')
  let t = performance.now()
  const pool = await Monty.create()
  console.log(`  pool start: ${(performance.now() - t).toFixed(1)} ms`)
  t = performance.now()
  {
    await using s = await pool.checkout()
    await s.feedRun('1 + 1')
  }
  console.log(`  first checkout + feed: ${(performance.now() - t).toFixed(1)} ms`)
  const n = 200
  t = performance.now()
  for (let i = 0; i < n; i++) {
    await using s = await pool.checkout()
    await s.feedRun("read_doc('a') + 'x'", { externalLookup: lookup })
  }
  console.log(`  warm checkout + feed with one tool call: ${((performance.now() - t) / n).toFixed(2)} ms each over ${n}`)
  await pool[Symbol.asyncDispose]()
}

setTimeout(() => {
  console.log('WATCHDOG: probe gave up after 120s')
  process.exit(2)
}, 120_000).unref()

{
  await using pool = await Monty.create({ requestTimeout: 10, checkoutTimeout: 10 })
  await bridge(pool)
}
{
  await using pool = await Monty.create({ maxProcesses: 2, requestTimeout: 10, checkoutTimeout: 3 })
  await escapes(pool)
}
await limits()
await cost()
