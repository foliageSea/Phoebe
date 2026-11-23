import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const input = value => ({ currentTarget: { value } })

function harness() {
  let plugin, hooks, index, translations, sessionId = 's/1?😀', canDescribe = true
  let state = { status: 'ready', value: { mode: 'brief', reference_id: 'custom', playbackTarget: 'browser' }, revision: 7, writable: true }
  let control, failFetch = false
  const slots = new Map()
  const writes = [], fetches = [], contexts = [], streams = [], decodes = [], sources = []
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useId: () => 'phoebe-test',
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useRef(initial) { return hooks[index++] ??= { current: initial } },
    useState(initial) {
      const slot = React.useRef(initial)
      return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value }]
    },
    useLayoutEffect(effect) {
      const slot = React.useRef(null)
      if (slot.current === null) slot.current = effect()
    },
  }
  class AudioContext {
    state = 'suspended'
    destination = {}
    constructor() { contexts.push(this) }
    async resume() { this.state = 'running' }
    async close() { this.state = 'closed' }
    decodeAudioData(buffer) {
      return new Promise((resolve, reject) => decodes.push({ resolve, reject, bytes: [...new Uint8Array(buffer)] }))
    }
    createBufferSource() {
      const source = {
        connect: destination => assert.equal(destination, this.destination),
        start() { this.started = true },
        stop() { this.stopped = true },
        disconnect() { this.disconnected = true },
      }
      sources.push(source)
      return source
    }
  }
  runInNewContext(client, {
    window: { AudioContext, __ModuleLoader__: { load({ factory }) { plugin = factory(() => React) } } },
    AbortController, TextDecoder, atob,
    async fetch(url, options) {
      fetches.push({ url, options })
      if (failFetch) return { ok: false }
      const body = new ReadableStream({ start: stream => {
        streams.push(stream)
        options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true })
      } })
      return { ok: true, body }
    },
  })
  const form = {
    subscribe() { return () => {} },
    getSnapshot() { return state },
    get state() { return state },
    async mutate(ops, revision) {
      writes.push({ ops: JSON.parse(JSON.stringify(ops)), revision })
      state = { ...state, revision: state.revision + 1,
        value: { ...state.value, ...Object.fromEntries(ops.map(op => [op.path[0], op.value])) } }
      return true
    },
  }
  plugin.apply({
    effect: callback => callback(), locale: { register: (_ns, value) => { translations = value } },
    configForms: { get: () => form },
    slots: { inject: (_name, callback) => callback(), register: (entry, tag) => slots.set(entry.name, { entry, tag }) },
  })
  function render(node, values = []) {
    hooks = values
    index = 0
    return node.tag(node.props)
  }
  function slot(name, props) {
    const { entry, tag } = slots.get(name)
    return render({ tag, props: { ...entry.inject(), t: key => key,
      useRemoteAccess: operation => operation !== 'settings/describe' || canDescribe, ...props } })
  }
  function unmount() {
    if (control) for (const hook of control.values) if (typeof hook.current === 'function') hook.current()
    control = null
  }
  const configHooks = []
  return {
    writes, fetches, contexts, decodes, sources, translations, unmount, streams,
    setSession: value => { sessionId = value },
    setConfig: value => { state = { ...state, revision: state.revision + 1, value: { ...state.value, ...value } } },
    setPermission: value => { canDescribe = value },
    failFetch: value => { failFetch = value },
    send: text => streams.at(-1).enqueue(new TextEncoder().encode(text)),
    dock() {
      // Match React's keyed mount/unmount behavior, without mounting the other Dock children.
      const entry = slot('conversation.composer.dock', { sessionId }).children[3]
      const node = render(entry)
      if (!node || control?.key !== node.props.key) unmount()
      if (!node) return null
      control ??= { key: node.props.key, values: [] }
      return render(node, control.values)
    },
    config() {
      const config = slot('plugins.row.config', { form })
      return render(render(config).children[2], configHooks)
    },
  }
}

const label = dock => dock.children[0].children[0]
const click = dock => dock.children[0].props.onClick()

test('playback destination defaults to host and saves with mode in one revision-checked transaction', async () => {
  const h = harness()
  h.setConfig({ playbackTarget: undefined })
  const fields = () => h.config().children[1].children
  const destination = () => fields()[2].children[1]
  assert.equal(destination().props.value, 'host')
  assert.equal(destination().children[0].map(item => item.props.value).join(','), 'host,browser')
  for (const locale of ['en', 'zh']) for (const label of ['host', 'browser', 'playbackTarget', 'browserEnable', 'browserRetry']) {
    assert.equal(typeof h.translations[locale][label], 'string')
  }
  destination().props.onChange(input('browser'))
  fields()[1].children[1].props.onChange(input('notice'))
  assert.equal(h.writes.length, 0)
  await h.config().props.onSubmit({ preventDefault() {} })
  assert.deepEqual(h.writes, [{ revision: 8, ops: [
    { op: 'set', path: ['mode'], value: 'notice' }, { op: 'set', path: ['playbackTarget'], value: 'browser' },
  ] }])
  assert.equal(destination().props.value, 'browser')
  destination().props.onChange(input('host'))
  h.setConfig({ reference_id: 'other' })
  await h.config().props.onSubmit({ preventDefault() {} })
  assert.equal(h.writes.length, 1, 'a stale destination draft cannot overwrite the latest revision')
})

test('dock gates browser activation, resumes on click, encodes strict session ID, and never auto-reopens', async () => {
  const h = harness()
  for (const invalid of [undefined, null, 1, '', 'with space', 'id\n', 'id\x00', 'id\x7f', '\ud800', 'x'.repeat(257)]) {
    h.setSession(invalid)
    assert.equal(h.dock(), null)
  }
  h.setSession('s/1?😀')
  assert.equal(label(h.dock()), 'browserEnable')
  assert.equal(h.contexts.length, 0)
  assert.equal(h.fetches.length, 0)
  let pending = click(h.dock())
  assert.equal(h.contexts[0].state, 'running', 'resume is invoked in the click stack')
  assert.equal(h.fetches.length, 0, 'fetch comes after resume')
  await turn()
  const request = h.fetches[0]
  assert.equal(request.url, 'api/phoebe-voice.audio?session=s%2F1%3F%F0%9F%98%80')
  assert.equal(request.options.cache, 'no-store')
  assert.equal(request.options.redirect, 'error')
  assert.equal(request.options.headers['x-phoebe-browser-audio'], '1')
  assert.equal(label(h.dock()), 'browserDisable')
  await click(h.dock())
  await pending
  assert.equal(label(h.dock()), 'browserEnable')
  assert.equal(request.options.signal.aborted, true)
  assert.equal(h.contexts[0].state, 'closed')

  for (const reason of ['session', 'target', 'mode', 'permission', 'unmount']) {
    pending = click(h.dock())
    await turn()
    const stream = h.fetches.at(-1)
    const context = h.contexts.at(-1)
    h.send('{"type":"ready"}\n{"type":"audio","audio":"AA=="}\n')
    await turn()
    h.decodes.at(-1).resolve({})
    await turn()
    const source = h.sources.at(-1)
    assert.equal(source.started, true)
    if (reason === 'session') { h.setSession('different'); assert.equal(label(h.dock()), 'browserEnable') }
    if (reason === 'target') { h.setConfig({ playbackTarget: 'host' }); assert.equal(h.dock(), null) }
    if (reason === 'mode') { h.setConfig({ mode: 'off' }); assert.equal(h.dock(), null) }
    if (reason === 'permission') { h.setPermission(false); assert.equal(h.dock(), null) }
    if (reason === 'unmount') {
      source.stop = () => { source.stopped = true; throw new Error('source already stopped') }
      h.unmount()
    }
    await pending
    assert.equal(stream.options.signal.aborted, true, reason)
    assert.equal(context.state, 'closed', reason)
    assert.equal(source.stopped, true, reason)
    assert.equal(source.disconnected, true, reason)
    h.setConfig({ playbackTarget: 'browser', mode: 'summary' })
    h.setPermission(true)
    assert.equal(label(h.dock()), 'browserEnable', reason)
    assert.equal(h.fetches.at(-1), stream, reason)
  }
})

test('fragmented and batched NDJSON handles stop, replacements, and recoverable clip errors', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.send('{"type":"rea')
  await turn()
  assert.equal(h.dock().children[1].children[0], 'browserConnecting')
  h.send('dy"}\n{"type":"ping"}\n{"type":"audio","audio":"AQID"}\n{"type":"stop"}\n')
  await turn()
  assert.deepEqual(h.decodes[0].bytes, [1, 2, 3])
  h.decodes[0].resolve({})
  await turn()
  assert.equal(h.sources.length, 0, 'stop invalidates pending decode')
  h.send('{"type":"audio","audio":"Ag=="}\n{"type":"audio","audio":"Aw=="}\n')
  await turn()
  h.decodes[2].resolve({})
  h.decodes[1].resolve({})
  await turn()
  assert.equal(h.sources.length, 1, 'only the newest pending decode plays')
  assert.equal(h.sources[0].started, true)
  h.send('{"type":"audio","audio":"BA=="}\n')
  await turn()
  assert.equal(h.sources[0].stopped, true, 'replacement stops the active source immediately')
  h.decodes[3].resolve({})
  await turn()
  h.send('{"type":"stop"}\n{"type":"error"}\n')
  await turn()
  assert.equal(h.sources[1].stopped, true)
  assert.equal(label(h.dock()), 'browserDisable')
  assert.equal(h.dock().children[2].children[0], 'browserClipFailed')
  await click(h.dock())
  await pending
})

test('overlong incomplete lines and oversized audio fail before decode; fetch/decode failures can be retried', async () => {
  const h = harness()
  for (const failure of ['fetch', 'line', 'audio', 'decode', 'disconnect']) {
    h.failFetch(failure === 'fetch')
    const pending = click(h.dock())
    await turn()
    if (failure === 'line') h.send('a'.repeat(1_333_401))
    if (failure === 'audio') h.send(JSON.stringify({ type: 'audio', audio: 'a'.repeat(1_333_337) }) + '\n')
    if (failure === 'decode') {
      h.send(JSON.stringify({ type: 'audio', audio: 'a'.repeat(1_333_334) + '==' }) + '\n')
      await turn()
      assert.equal(h.decodes.at(-1).bytes.length, 1_000_000)
      h.decodes.at(-1).reject(new Error('test decode failure'))
    }
    if (failure === 'disconnect') h.streams.at(-1).close()
    await pending
    assert.equal(label(h.dock()), 'browserRetry', failure)
    assert.equal(h.dock().children[2].children[0], 'browserFailed', failure)
    assert.equal(h.contexts.at(-1).state, 'closed', failure)
    assert.equal(h.fetches.at(-1).options.signal.aborted, true, failure)
    assert.equal(h.decodes.length, ['decode', 'disconnect'].includes(failure) ? 1 : 0)
  }
})
