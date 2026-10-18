// ROUGH SPIKE CHECK: which checkouts fail to return their worker to the pool?
import { ExternalModule, FunctionSnapshot, Monty } from '@pydantic/monty'
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 60000).unref()
const lookup = { read_doc: (n: string) => `c ${n}`, slow_tool: async (l: string) => { await new Promise((r) => setTimeout(r, 300)); return l } }
const cases: Record<string, string> = {
  plain_os_listdir: 'import os\nos.listdir("/")',
  plain_open: 'open("/etc/passwd").read()',
  plain_getenv: 'import os\nos.getenv("HOME")',
  plain_ok: '1 + 1',
  plain_error: 'import subprocess',
  lookup_unused_ok: '1 + 1',
  tool_call_ok: "read_doc('a')",
  unawaited_async: "[slow_tool('a')]",
  name_error: 'nope',
  gather: "import asyncio\nawait asyncio.gather(slow_tool('a'), slow_tool('b'))",
  external_module: "import tools\ntools.read_doc('b')",
  feed_start: 'feed_start',
}
for (const [name, code] of Object.entries(cases)) {
  const pool = await Monty.create({ maxProcesses: 2, checkoutTimeout: 3 })
  let ok = 0, err = ''
  for (let i = 0; i < 5; i++) {
    try {
      await using s = await pool.checkout(name === 'external_module' ? { externalModules: { tools: new ExternalModule(lookup) } } : {})
      try {
        if (name === 'feed_start') {
          let snap: any = await s.feedStart("read_doc('c')")
          while (snap instanceof FunctionSnapshot) snap = await snap.resume('x')
        } else await s.feedRun(code, name.startsWith('plain') ? {} : { externalLookup: lookup })
      } catch (e: any) { console.log('   feed error', e.message) }
      ok++
    } catch (e: any) { err = e.message; break }
  }
  console.log(`${name}: ${ok}/5 checkouts with maxProcesses 2 ${err ? '-> ' + err : ''}`)
  await pool[Symbol.asyncDispose]().catch(() => {})
}
process.exit(0)
