import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createBalanceLookup, registerBalanceRoute } from '../balance.js'

const wallet = (data, status = 200) => Response.json(data, { status })

test('wallet lookup uses the host key and returns only paid balance', async () => {
  const lookup = createBalanceLookup(async () => ' test-key ', {
    async fetchWallet(url, options) {
      assert.equal(url, 'https://api.fish.audio/wallet/self/api-credit')
      assert.equal(options.headers.authorization, 'Bearer test-key')
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
      return wallet({ credit: '0.0200', has_free_credit: true, user_id: 'private', cumulative_top_up: '42' })
    },
  })
  assert.deepEqual(await lookup(), { status: 'ok', credit: '0.0200' })
})

test('wallet cache coalesces requests, expires, and never reuses another key’s balance', async () => {
  let clock = 0
  let key = 'one'
  let calls = 0
  let finish
  const firstResponse = new Promise(resolve => { finish = resolve })
  const lookup = createBalanceLookup(async () => key, {
    now: () => clock,
    async fetchWallet(_url, { headers }) {
      calls++
      if (calls === 1) return firstResponse
      return wallet({ credit: headers.authorization === 'Bearer one' ? '3' : '4', has_free_credit: false })
    },
  })
  const pending = [lookup(), lookup()]
  finish(wallet({ credit: '1', has_free_credit: null }))
  assert.deepEqual(await Promise.all(pending), Array(2).fill({ status: 'ok', credit: '1' }))
  assert.equal((await lookup()).credit, '1')
  assert.equal(calls, 1)
  clock = 15_001
  assert.equal((await lookup()).credit, '3')
  key = 'two'
  assert.equal((await lookup()).credit, '4')
  key = undefined
  assert.deepEqual(await lookup(), { status: 'missing-key' })
  assert.equal(calls, 3)
})

test('wallet errors do not expose credentials, upstream details, or invalid credit values', async () => {
  for (const [upstream, status] of [
    [() => wallet({ message: 'private' }, 403), 'unauthorized'],
    [() => wallet({ message: 'private' }, 429), 'unavailable'],
    [() => wallet({ credit: 'not-a-balance' }), 'unavailable'],
    [() => { throw new Error('private') }, 'unavailable'],
  ]) {
    const lookup = createBalanceLookup(async () => 'test-key', { fetchWallet: upstream })
    assert.deepEqual(await lookup(), { status })
  }
  const lookup = createBalanceLookup(async () => { throw new Error('private') })
  assert.deepEqual(await lookup(), { status: 'not-ready' })
})

test('balance uses DSH’s exact Connection route and disables response caching', async () => {
  let route
  registerBalanceRoute({
    connection: { fetch: { register: value => { route = value } } },
    credentials: { resolve: async ref => { assert.equal(ref, 'FISH_API_KEY') } },
  })
  assert.equal(route.path, '/api/phoebe-voice.balance')
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.fetch()
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { status: 'missing-key' })
})

test('client mounts the balance in the composer dock, hides it without a key, and refreshes on click', async () => {
  const state = []
  let index = 0
  let effect
  let config
  let boundSlot
  let result = { status: 'missing-key' }
  let requests = 0
  let stopped = false
  let requestSignal
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState(initial) {
      const id = index++
      if (!(id in state)) state[id] = initial
      return [state[id], value => { state[id] = typeof value === 'function' ? value(state[id]) : value }]
    },
    useRef(initial) { const id = index++; return state[id] ??= { current: initial } },
    useEffect(fn) { effect = fn },
  }
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { config = factory(() => React) } } },
    AbortController,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setInterval: () => 1,
    clearInterval: () => { stopped = true },
    async fetch(path, options) {
      requests++
      assert.equal(path, 'api/phoebe-voice.balance')
      requestSignal = options.signal
      return { ok: true, json: async () => result }
    },
  })
  config.apply({ effect() {}, configForms: { get: () => ({ subscribe() {}, getSnapshot() {}, mutate() {} }) }, slots: {
    inject(name, fn) { if (name === 'conversation.composer.dock') fn() },
    register(entry, Component) { boundSlot = { entry, Component } },
  } })
  assert.equal(boundSlot.entry.id, 'phoebe-voice.dock')
  const badge = boundSlot.Component({ t: key => key }).children[2]
  const render = () => { index = 0; return badge.tag(badge.props) }
  assert.equal(render(), null)
  const disposeMissing = effect()
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await tick()
  assert.equal(render(), null)
  disposeMissing()
  assert.equal(requestSignal.aborted, true)
  result = { status: 'ok', credit: '12.50', hasFreeCredit: true }
  const dispose = effect()
  await tick()
  const button = render()
  assert.equal(button.tag, 'button')
  assert.equal(button.children[0], 'balance · 12.50')
  result = { status: 'ok', credit: '0', hasFreeCredit: false }
  button.props.onClick()
  await tick()
  assert.equal(render().children[0], 'balance · 0')
  assert.equal(requests, 3)
  dispose()
  assert.equal(stopped, true)
})
