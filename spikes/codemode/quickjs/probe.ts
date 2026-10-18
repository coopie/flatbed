// ROUGH SPIKE PROBE. Not production code, not tested, not reviewed.
// A comparison point for the Monty probes: quickjs-emscripten's start-up,
// host-function bridge, concurrency through promises, a few escapes and the
// limits. Run with: node probe.ts. No model calls, nothing from .env.

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

let t = performance.now()
const QuickJS = await getQuickJS()
console.log(`load wasm module: ${(performance.now() - t).toFixed(1)} ms`)

function newContext() {
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(10_000_000)
  runtime.setMaxStackSize(256 * 1024)
  const vm = runtime.newContext()
  // read_doc: a plain synchronous host function.
  const readDoc = vm.newFunction('read_doc', (h) => vm.newString(`contents of ${vm.getString(h)}`))
  vm.setProp(vm.global, 'read_doc', readDoc)
  readDoc.dispose()
  // slow_tool: returns a promise the host settles later, so calls overlap.
  const slow = vm.newFunction('slow_tool', (h) => {
    const label = vm.getString(h)
    const p = vm.newPromise()
    setTimeout(() => {
      const s = vm.newString(`done ${label}`)
      p.resolve(s)
      s.dispose()
      p.dispose()
      runtime.executePendingJobs()
    }, 300)
    return p.handle
  })
  vm.setProp(vm.global, 'slow_tool', slow)
  slow.dispose()
  return { runtime, vm }
}

function evalShow(title: string, code: string, deadlineMs = 2000) {
  const { runtime, vm } = newContext()
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + deadlineMs))
  const t0 = performance.now()
  const r = vm.evalCode(code)
  const took = performance.now() - t0
  let out: string
  if (r.error) {
    out = `ERR -> ${JSON.stringify(vm.dump(r.error))}`
    r.error.dispose()
  } else {
    out = `OK -> ${JSON.stringify(vm.dump(r.value))}`
    try {
      r.value.dispose()
    } catch (e) {
      out += `  [host-side dispose failed: ${(e as Error).name}]`
    }
  }
  console.log(`  ${title}: ${out}`.slice(0, 300) + (took > 50 ? `  (${(took / 1000).toFixed(2)}s)` : ''))
  try {
    vm.dispose()
    runtime.dispose()
  } catch (e) {
    console.log(`    [host-side dispose failed: ${(e as Error).message.slice(0, 80)}]`)
  }
}

console.log('== bridge')
evalShow('tool call', "read_doc('a')")
{
  const { runtime, vm } = newContext()
  const t0 = performance.now()
  const r = vm.evalCode("Promise.all([slow_tool('a'), slow_tool('b'), slow_tool('c')])")
  const promise = vm.resolvePromise(vm.unwrapResult(r))
  r.value?.dispose()
  const settled = await promise
  const value = vm.unwrapResult(settled)
  console.log(`  3 x 0.3s promise tools via Promise.all: ${JSON.stringify(vm.dump(value))} in ${((performance.now() - t0) / 1000).toFixed(2)}s`)
  value.dispose()
  vm.dispose()
  runtime.dispose()
}

console.log('== what a script can see')
evalShow('require', "require('fs')")
evalShow('process', 'process.env')
evalShow('import()', "import('fs')")
evalShow('fetch', 'fetch')
evalShow('globalThis keys', 'Object.getOwnPropertyNames(globalThis)')
evalShow('tool source', 'read_doc.toString()')
evalShow('Function constructor', "new Function('return this')() === globalThis")
evalShow('Date.now', 'Date.now()')

console.log('== limits')
evalShow('time: while(true)', 'while (true) {}', 500)
evalShow('memory', "let a = []; while (true) a.push('x'.repeat(1000))")
evalShow('recursion', 'function f(n) { return f(n + 1) } f(0)')

console.log('== cost')
const n = 1000
t = performance.now()
for (let i = 0; i < n; i++) {
  const { runtime, vm } = newContext()
  const r = vm.evalCode("read_doc('a') + 'x'")
  r.value?.dispose()
  r.error?.dispose()
  vm.dispose()
  runtime.dispose()
}
console.log(`  new runtime + context + one tool call: ${((performance.now() - t) / n).toFixed(3)} ms each over ${n}`)
