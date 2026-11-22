import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPresets, registerPresetRoute } from '../host/preset-route.js'
import { PHOEBE_VOICE } from '../host/playback.js'
import { NOTICES } from '../host/speech.js'

const url = 'http://127.0.0.1/api/phoebe-voice.presets'

test('the bundled Phoebe recordings are ready without credentials or network and do not replace a custom voice', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phoebe-bundled-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let voice = PHOEBE_VOICE
  let credentialReads = 0
  const store = createPresets({
    getVoice: () => voice, directory, model: 's2.1-pro-free',
    resolveKey: () => { credentialReads++; return undefined },
    fetchAudio: () => assert.fail('unexpected synthesis'),
  })
  assert.deepEqual(await store.status(), { status: 'ready' })
  assert.deepEqual(await store.prepare('s2.1-pro'), { status: 'ready' })
  for (const [kind, text] of Object.entries(NOTICES)) {
    const path = await store.find(text)
    assert.equal(path, fileURLToPath(new URL(`../audio/${kind}.mp3`, import.meta.url)))
    assert.ok((await readFile(path)).length > 1000)
  }
  assert.equal(await store.find('动态正文'), undefined)
  assert.equal(credentialReads, 0)
  voice = 'custom-voice'
  assert.equal(await store.find(NOTICES.ask), undefined)
  assert.deepEqual(await store.status(), { status: 'missing-key' })
})

test('preset status never generates and POST requires an explicit free or paid model', async () => {
  let route, finish
  const generated = []
  registerPresetRoute({ connection: { fetch: { register: value => { route = value } } } }, {
    status: async () => ({ status: 'missing' }),
    prepare: model => { generated.push(model); return new Promise(resolve => { finish = resolve }) },
  })
  assert.deepEqual(route.methods, ['GET', 'POST'])
  const get = await route.fetch(new Request(url))
  assert.equal(get.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await get.json(), { status: 'missing' })
  const post = model => route.fetch(new Request(url, {
    method: 'POST', headers: model ? { 'x-phoebe-preset-model': model } : {},
  }))
  assert.equal((await post()).status, 400)
  assert.deepEqual(generated, [])
  const pending = post('s2.1-pro-free')
  assert.equal((await post('s2.1-pro')).status, 409)
  finish({ status: 'http-402' })
  assert.deepEqual(await (await pending).json(), { status: 'http-402' })
  assert.deepEqual(generated, ['s2.1-pro-free'])
  const paid = post('s2.1-pro')
  finish({ status: 'ready' })
  assert.deepEqual(await (await paid).json(), { status: 'ready' })
  assert.deepEqual(generated, ['s2.1-pro-free', 's2.1-pro'])
})

test('dock switches only the persisted playback mode and retains the accepted mode on failure', async () => {
  let plugin, slot, component, index = 0, finish
  const values = []
  const writes = []
  const modal = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  let effect
  let state = { status: 'ready', value: { mode: 'brief', reference_id: 'custom' }, revision: 7, writable: true }
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useId: () => 'summary-hint',
    useEffect: callback => { effect = callback },
    useRef(initial) { const i = index++; return values[i] ??= { current: initial } },
    useState(initial) { const i = index++; return [values[i] ??= initial, value => { values[i] = value }] },
  }
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => React) } } },
  })
  const form = {
    subscribe() { return () => {} },
    getSnapshot() { return state },
    mutate(ops, revision) {
      writes.push({ ops: JSON.parse(JSON.stringify(ops)), revision })
      return new Promise(resolve => { finish = resolve })
    },
  }
  plugin.apply({ effect() {}, configForms: { get(id) { assert.equal(id, 'phoebe-voice'); return form } }, slots: {
    inject(name, callback) { if (name === 'conversation.composer.dock') callback() },
    register(entry, Component) { slot = entry; component = Component },
  } })
  const view = component({ ...slot.inject(), t: key => key, useRemoteAccess: () => true }).children[1]
  const render = () => {
    index = 0
    const tree = view.tag(view.props)
    tree.children[1].props.ref.current = modal
    effect()
    return tree
  }
  const selection = () => render().children[0]
  const dialog = () => render().children[1]
  assert.equal(selection().props.value, 'brief')
  assert.equal(selection().children[0].map(item => item.props.value).join(','), 'off,notice,brief,summary')
  const change = selection().props.onChange({ currentTarget: { value: 'notice' } })
  assert.equal(selection().props.disabled, true)
  assert.deepEqual(writes, [{ ops: [{ op: 'set', path: ['mode'], value: 'notice' }], revision: 7 }])
  finish(false)
  await change
  assert.equal(selection().props.value, 'brief')
  assert.equal(render().children[2].children[0], 'saveFailed')
  state = { ...state, revision: 8, value: { ...state.value, mode: 'off' } }
  assert.equal(selection().props.value, 'off')
  const pickSummary = () => selection().props.onChange({ currentTarget: { value: 'summary' } })
  pickSummary()
  assert.equal(writes.length, 1, 'AI summary is not saved before confirmation')
  assert.equal(selection().props.value, 'off')
  assert.equal(dialog().tag, 'dialog')
  assert.equal(modal.open, true)
  assert.equal(dialog().props['aria-labelledby'], dialog().children[0].props.id)
  assert.equal(dialog().children[1].children[0], 'confirmSummaryData')
  assert.equal(dialog().children[3].children[0].props.autoFocus, true)
  dialog().children[3].children[0].props.onClick()
  dialog()
  assert.equal(modal.open, false)
  assert.equal(writes.length, 1)
  pickSummary()
  let prevented = false
  dialog().props.onCancel({ preventDefault: () => { prevented = true } })
  dialog()
  assert.equal(prevented, true)
  assert.equal(modal.open, false)
  assert.equal(writes.length, 1)
  pickSummary()
  dialog()
  assert.equal(modal.open, true)
  state = { ...state, revision: 9 }
  const staleConfirm = dialog().children[3].children[1].props.onClick
  assert.equal(modal.open, false, 'another settings revision invalidates confirmation')
  await staleConfirm()
  assert.equal(writes.length, 1)
  pickSummary()
  const enable = dialog().children[3].children[1].props.onClick()
  dialog()
  assert.equal(modal.open, false)
  assert.deepEqual(writes.at(-1), { ops: [{ op: 'set', path: ['mode'], value: 'summary' }], revision: 9 })
  state = { ...state, revision: 10, value: { ...state.value, mode: 'summary' } }
  finish(true)
  await enable
  assert.equal(selection().props.value, 'summary')
  const mute = selection().props.onChange({ currentTarget: { value: 'off' } })
  assert.deepEqual(writes.at(-1), { ops: [{ op: 'set', path: ['mode'], value: 'off' }], revision: 10 })
  finish(true)
  await mute
})
