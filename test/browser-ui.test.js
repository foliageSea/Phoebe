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
  let failFetch = false, failStart = false, resumeGate
  let now = 0, nextTimer = 0
  const timers = new Map()
  const subscribers = new Set()
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
    async resume() {
      if (resumeGate) await resumeGate
      this.state = 'running'
    }
    async close() { this.state = 'closed' }
    decodeAudioData(buffer) {
      return new Promise((resolve, reject) => decodes.push({ resolve, reject, bytes: [...new Uint8Array(buffer)] }))
    }
    createBufferSource() {
      const source = {
        connect: destination => assert.equal(destination, this.destination),
        start() {
          if (failStart) throw new Error('test source start failure')
          assert.equal(sources.some(source => source !== this && source.started && !source.ended && !source.stopped), false,
            'browser sources never overlap')
          this.started = true
        },
        end() { this.ended = true; this.onended?.() },
        stop() { this.stopped = true },
        disconnect() { this.disconnected = true },
      }
      sources.push(source)
      return source
    }
  }
  runInNewContext(client, {
    window: { AudioContext, __ModuleLoader__: { load({ factory }) { plugin = factory(() => React) } } },
    AbortController, TextDecoder, atob, performance: { now: () => now },
    setTimeout(callback, ms) {
      const id = ++nextTimer
      timers.set(id, { callback, at: now + ms })
      return id
    },
    clearTimeout: id => timers.delete(id),
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
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
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
  const configHooks = []
  return {
    writes, fetches, contexts, decodes, sources, translations, streams, timers,
    advance(ms, runTimers = true) {
      now += ms
      if (runTimers) for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    failStart: value => { failStart = value },
    setSession: value => { sessionId = value },
    setConfig: value => {
      state = { ...state, revision: state.revision + 1, value: { ...state.value, ...value } }
      for (const listener of subscribers) listener()
    },
    setPermission: value => { canDescribe = value },
    failFetch: value => { failFetch = value },
    holdResume: () => {
      let unlock
      resumeGate = new Promise(resolve => { unlock = resolve })
      return unlock
    },
    send: text => streams.at(-1).enqueue(new TextEncoder().encode(text)),
    events: (...events) => streams.at(-1).enqueue(new TextEncoder().encode(events.map(event => JSON.stringify(event) + '\n').join(''))),
    dock() {
      return render(slot('conversation.composer.dock', { sessionId }).children[3])
    },
    config() {
      const config = slot('plugins.row.config', { form })
      return render(render(config).children[2], configHooks)
    },
  }
}

const label = dock => dock.children[0].children[0]
const click = dock => dock.children[0].props.onClick()
const clip = (id, waitMs = 20_000, audio = btoa(String.fromCharCode(id))) => ({ type: 'audio', id, waitMs, audio })
const cancel = id => ({ type: 'cancel', id })
const stop = { type: 'stop' }
const ready = { type: 'ready' }
const warning = h => h.dock().children[2]?.children?.[1].children[0]

test('playback destination and Fish model save with mode in one revision-checked transaction', async () => {
  const h = harness()
  h.setConfig({ playbackTarget: undefined })
  const fields = () => h.config().children[1].children
  const destination = () => fields()[2].children[1]
  const fishModel = () => fields()[3].children[1]
  assert.equal(fishModel().props.value, 's2.1-pro-free')
  assert.equal(fishModel().children[0].map(item => item.props.value).join(','), 's2.1-pro-free,s2.1-pro')
  fishModel().props.onChange(input('invalid-model'))
  assert.equal(fishModel().props.value, 's2.1-pro-free')
  fishModel().props.onChange(input('s2.1-pro'))
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
    { op: 'set', path: ['fishModel'], value: 's2.1-pro' },
  ] }])
  assert.equal(destination().props.value, 'browser')
  assert.equal(fishModel().props.value, 's2.1-pro')
  fishModel().props.onChange(input('s2.1-pro-free'))
  h.setConfig({ reference_id: 'other' })
  await h.config().props.onSubmit({ preventDefault() {} })
  assert.equal(h.writes.length, 1, 'a stale model draft cannot overwrite the latest revision')
})

test('dock resumes on click, subscribes to all sessions, and stops on request', async () => {
  const h = harness()
  assert.equal(label(h.dock()), 'browserEnable')
  assert.equal(h.contexts.length, 0)
  assert.equal(h.fetches.length, 0)
  let pending = click(h.dock())
  assert.equal(h.contexts[0].state, 'running', 'resume is invoked in the click stack')
  assert.equal(h.fetches.length, 0, 'fetch comes after resume')
  await turn()
  const request = h.fetches[0]
  assert.equal(request.url, 'api/phoebe-voice.audio?scope=all')
  assert.equal(request.options.cache, 'no-store')
  assert.equal(request.options.redirect, 'error')
  assert.equal(request.options.headers['x-phoebe-browser-audio'], '2')
  assert.equal(label(h.dock()), 'browserDisable')
  await click(h.dock())
  await pending
  assert.equal(label(h.dock()), 'browserEnable')
  assert.equal(request.options.signal.aborted, true)
  assert.equal(h.contexts[0].state, 'closed')

})

test('switching sessions or leaving chat does not stop or recreate the stream', async () => {
  const h = harness()
  const unlock = h.holdResume()
  const pending = click(h.dock())
  h.setSession('another-session')
  assert.equal(label(h.dock()), 'browserDisable')
  unlock()
  await turn()
  h.events(ready, clip(1))
  await turn()
  h.decodes[0].resolve({})
  await turn()
  assert.equal(h.sources[0].started, true)
  // No Dock render is needed to receive a clip while another page is open.
  h.events(clip(2))
  await turn()
  assert.equal(h.decodes.length, 1)
  h.sources[0].end()
  h.decodes[1].resolve({})
  await turn()
  assert.equal(h.sources[1].started, true)
  h.setSession('third-session')
  assert.equal(label(h.dock()), 'browserDisable')
  assert.equal(h.contexts.length, 1)
  assert.equal(h.fetches.length, 1)
  assert.equal(h.fetches[0].options.signal.aborted, false)
  await click(h.dock())
  await pending
  assert.equal(h.contexts[0].state, 'closed')
})

test('turning off playback or losing permission revokes the tab unlock', async () => {
  const cases = [h => h.setConfig({ playbackTarget: 'host' }), h => h.setConfig({ mode: 'off' }), h => h.setPermission(false)]
  for (const change of cases) {
    const h = harness()
    const pending = click(h.dock())
    await turn()
    change(h)
    assert.equal(h.dock(), null)
    await pending
    assert.equal(h.fetches[0].options.signal.aborted, true)
    assert.equal(h.contexts[0].state, 'closed')
    h.setConfig({ playbackTarget: 'browser', mode: 'summary' })
    h.setPermission(true)
    assert.equal(label(h.dock()), 'browserEnable')
    assert.equal(h.fetches.length, 1)
  }
})

test('fragmented and batched NDJSON handles cancellation and stop without accepting stale decodes', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.send('{"type":"rea')
  await turn()
  assert.equal(h.dock().children[1].children[0], 'browserConnecting')
  h.send('dy"}\n')
  h.events({ type: 'ping' }, clip(1), clip(2), clip(3), cancel(2), cancel(999), cancel(1))
  await turn()
  assert.deepEqual(h.decodes.map(decode => decode.bytes), [[1], [3]])
  h.decodes[0].resolve({})
  await turn()
  assert.equal(h.sources.length, 0, 'targeted cancellation invalidates the active decode only')
  h.decodes[1].resolve({})
  await turn()
  h.events(clip(4), clip(5), cancel(3))
  await turn()
  assert.equal(h.sources[0].stopped, true)
  assert.equal(h.sources[0].disconnected, true)
  assert.deepEqual(h.decodes.map(decode => decode.bytes), [[1], [3], [4]])
  h.events(stop, clip(6))
  await turn()
  h.decodes[2].reject(new Error('stale decode must not affect the next clip'))
  h.decodes[3].resolve({})
  await turn()
  assert.deepEqual(h.decodes.map(decode => decode.bytes), [[1], [3], [4], [6]], 'stop clears active and queued clips')
  assert.equal(h.sources[1].started, true)
  assert.equal(warning(h), undefined)
  h.events(clip(7), stop, { type: 'error' })
  await turn()
  assert.equal(h.sources[1].stopped, true)
  assert.equal(h.decodes.length, 4)
  assert.equal(h.timers.size, 0)
  assert.equal(label(h.dock()), 'browserDisable')
  const [icon, tip] = h.dock().children[2].children
  assert.equal(icon.props.tabIndex, 0)
  assert.equal(icon.props['aria-describedby'], tip.props.id)
  assert.equal(tip.props.role, 'tooltip')
  assert.equal(warning(h), 'browserClipFailed')
  await click(h.dock())
  await pending
})

test('browser playback is FIFO with one active decode or source and up to eight pending clips', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.events(ready, ...Array.from({ length: 10 }, (_, i) => clip(i + 1)))
  await turn()
  assert.equal(h.decodes.length, 1, 'queued clips cannot start decode while another is active')
  for (let i = 0; i < 9; i++) {
    assert.equal(h.decodes.length, i + 1)
    assert.deepEqual(h.decodes[i].bytes, [i + 1])
    h.decodes[i].resolve({})
    await turn()
    assert.equal(h.sources[i].started, true)
    assert.equal(h.decodes.length, i + 1, 'playback retains its active slot')
    h.sources[i].end()
    assert.equal(h.sources[i].disconnected, true)
  }
  assert.equal(h.decodes.length, 9, 'the newest arrival was dropped without evicting existing clips')
  assert.equal(h.timers.size, 0)
  await click(h.dock())
  await pending
})

test('browser queue skips clips whose wait budget expired relative to receipt', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.events(ready, clip(1, 0), clip(2), clip(3, 10), ...Array.from({ length: 7 }, (_, i) => clip(i + 4)))
  await turn()
  assert.deepEqual(h.decodes.map(decode => decode.bytes), [[2]])
  h.advance(10)
  h.events(clip(11), clip(12, 1))
  await turn()
  h.events(cancel(4), clip(13, 1), clip(14))
  await turn()
  h.advance(1)
  for (const [index, id] of [2, 5, 6, 7, 8, 9, 10, 11].entries()) {
    assert.deepEqual(h.decodes[index].bytes, [id])
    h.decodes[index].resolve({})
    await turn()
    h.sources[index].end()
  }
  assert.equal(h.decodes.length, 8, 'expired entries neither consume pending capacity nor start playback')
  await click(h.dock())
  await pending
})

test('the 30 second watchdog includes decode time and recovers from expired and hung clips', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.events(ready, clip(1), clip(2))
  await turn()
  h.advance(29_000)
  h.events(clip(3))
  await turn()
  h.advance(999)
  assert.equal(h.decodes.length, 1)
  h.advance(1)
  assert.deepEqual(h.decodes.map(decode => decode.bytes), [[1], [3]])
  assert.equal(warning(h), 'browserClipFailed')
  h.decodes[0].resolve({})
  await turn()
  assert.equal(h.sources.length, 0)
  h.advance(29_000)
  h.events(clip(4))
  await turn()
  h.decodes[1].resolve({})
  await turn()
  assert.equal(h.sources[0].started, true)
  assert.equal(warning(h), undefined)
  const staleEnd = h.sources[0].onended
  h.advance(999)
  assert.equal(h.sources[0].stopped, undefined)
  h.advance(1)
  assert.equal(h.sources[0].stopped, true, 'the timer is not restarted when decoding finishes')
  assert.equal(h.sources[0].disconnected, true)
  assert.equal(warning(h), 'browserClipFailed')
  staleEnd()
  assert.deepEqual(h.decodes.map(decode => decode.bytes), [[1], [3], [4]])
  h.decodes[2].resolve({})
  await turn()
  assert.equal(h.sources[1].started, true)
  await click(h.dock())
  await pending
  assert.equal(h.timers.size, 0)
})

test('a decode resolving after its deadline cannot play even if the watchdog task has not run', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.events(ready, clip(1))
  await turn()
  h.advance(30_000, false)
  h.decodes[0].resolve({})
  await turn()
  assert.equal(warning(h), 'browserClipFailed')
  assert.equal(h.sources.length, 0)
  assert.equal(h.timers.size, 0)
  await click(h.dock())
  await pending
})

test('maximum-size audio with v2 metadata is accepted; decode and playback failures recover within the same stream', async () => {
  const h = harness()
  const pending = click(h.dock())
  await turn()
  h.events(ready, clip(Number.MAX_SAFE_INTEGER, 20_000, 'a'.repeat(1_333_334) + '=='), clip(2), clip(3))
  await turn()
  assert.equal(h.decodes[0].bytes.length, 1_000_000)
  h.decodes[0].reject(new Error('test decode failure'))
  await turn()
  assert.equal(warning(h), 'browserClipFailed')
  assert.deepEqual(h.decodes[1].bytes, [2])
  h.failStart(true)
  h.decodes[1].resolve({})
  await turn()
  assert.equal(h.sources[0].disconnected, true)
  assert.equal(warning(h), 'browserClipFailed')
  h.failStart(false)
  h.decodes[2].resolve({})
  await turn()
  assert.equal(h.sources[1].started, true)
  assert.equal(warning(h), undefined)
  assert.equal(label(h.dock()), 'browserDisable')
  assert.equal(h.fetches[0].options.signal.aborted, false)
  await click(h.dock())
  await pending
})

test('malformed packets fail before decode and stream failures can be retried', async () => {
  const h = harness()
  const failures = [
    ['fetch', () => {}],
    ['line too long', () => h.send('a'.repeat(1_333_433))],
    ['oversized encoded audio', () => h.events(clip(1, 20_000, 'a'.repeat(1_333_337)))],
    ['oversized decoded audio without padding', () => h.events(clip(1, 20_000, 'a'.repeat(1_333_336)))],
    ['oversized decoded audio with single padding', () => h.events(clip(1, 20_000, 'a'.repeat(1_333_335) + '='))],
    ['invalid audio alphabet', () => h.events(clip(1, 1, 'abcd!'))],
    ['invalid audio padding', () => h.events(clip(1, 1, 'a==='))],
    ['missing metadata', () => h.events({ type: 'audio', audio: 'AQ==' })],
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(id => [
      `bad audio id ${id}`, () => h.events(clip(id, 1, 'AQ==')),
    ]),
    ...[-1, 20_001, 1.5, '1', undefined].map(waitMs => [
      `bad waitMs ${waitMs}`, () => h.events({ ...clip(1), waitMs }),
    ]),
    ['invalid cancel id', () => h.events(cancel(0))],
    ['disconnect', () => h.streams.at(-1).close()],
  ]
  for (const [failure, trigger] of failures) {
    h.failFetch(failure === 'fetch')
    const pending = click(h.dock())
    await turn()
    trigger()
    await pending
    assert.equal(label(h.dock()), 'browserRetry', failure)
    assert.equal(warning(h), 'browserFailed', failure)
    assert.equal(h.contexts.at(-1).state, 'closed', failure)
    assert.equal(h.fetches.at(-1).options.signal.aborted, true, failure)
    assert.equal(h.decodes.length, 0, failure)
    assert.equal(h.timers.size, 0, failure)
  }
})
