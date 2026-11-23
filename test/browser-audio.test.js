import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { apply, Config } from '../index.js'
import { createBrowserAudio, registerBrowserAudioRoute } from '../host/browser-audio.js'
import { readBrowserAudio, synthesizeBrowserAudio } from '../host/browser-render.js'
import { MAX_AUDIO_BYTES } from '../host/playback.js'

const nextTick = () => new Promise(resolve => setImmediate(resolve))
const decoder = new TextDecoder()
const request = (query = 'scope=all', signal, header = '1') => new Request('http://localhost/api/phoebe-voice.audio?' + query, {
  signal, headers: { 'x-phoebe-browser-audio': header },
})
const open = (browser) => browser.open(new AbortController().signal).body.getReader()
const read = async reader => JSON.parse(decoder.decode((await reader.read()).value))
const job = (owner, text, options) => ({ owner, text, kind: 'final', isCurrent: () => true, ...options })
const owner = id => ({ id })

function register(browser, enabled) {
  let route
  registerBrowserAudioRoute({ connection: { fetch: { register(value) { route = value } } } }, browser, enabled)
  return route
}

test('browser stream requires an explicit header and enabled output, is uncached and bounded', async (t) => {
  const browser = createBrowserAudio(() => assert.fail('no synthesis'), assert.fail, { maxListeners: 1 })
  t.after(() => browser.close())
  let enabled = false
  const route = register(browser, () => enabled)
  assert.equal(route.path, '/api/phoebe-voice.audio')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.fetch(request()).status, 409)
  enabled = true
  for (const req of [request('scope=all', undefined, '0'), request('session=main'), request(''), request('scope=all&session=main')]) {
    assert.equal(route.fetch(req).status, 400)
  }
  const lifetime = new AbortController()
  const response = route.fetch(request('scope=all', lifetime.signal))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const reader = response.body.getReader()
  assert.deepEqual(await read(reader), { type: 'ready' })
  assert.equal(route.fetch(request()).status, 429)
  lifetime.abort()
  assert.equal((await reader.read()).done, true)
  assert.equal(route.fetch(request()).status, 200)
})

test('one subscription receives new audio from multiple sessions without replay or duplicate synthesis', async (t) => {
  const calls = []
  let finish
  const browser = createBrowserAudio(({ text }) => {
    calls.push(text)
    return new Promise(resolve => { finish = resolve })
  }, assert.fail)
  t.after(() => browser.close())
  const a = owner('main')
  const b = owner('background')
  browser.enqueue(job(a, 'no tabs'))
  const first = open(browser)
  const second = open(browser)
  for (const reader of [first, second]) assert.deepEqual(await read(reader), { type: 'ready' })
  assert.deepEqual(calls, [])
  browser.enqueue(job(a, 'live'))
  await nextTick()
  const late = open(browser)
  assert.deepEqual(await read(late), { type: 'ready' })
  finish(Buffer.from('first'))
  for (const reader of [first, second]) assert.deepEqual(await read(reader), { type: 'audio', audio: Buffer.from('first').toString('base64') })
  browser.enqueue(job(b, 'other session'))
  await nextTick()
  finish(Buffer.from('second'))
  for (const reader of [first, second, late]) assert.deepEqual(await read(reader), { type: 'audio', audio: Buffer.from('second').toString('base64') })
  assert.deepEqual(calls, ['live', 'other session'])
})

test('questions interrupt results; replying and changing turns stop audio already sent', async (t) => {
  const browser = createBrowserAudio(async ({ text }) => Buffer.from(text), assert.fail)
  t.after(() => browser.close())
  const session = owner('main')
  const reader = open(browser)
  await read(reader)
  browser.enqueue(job(session, 'final'))
  assert.equal((await read(reader)).type, 'audio')
  const question = new AbortController()
  browser.enqueue(job(owner('background'), 'question', { kind: 'ask', signal: question.signal }))
  assert.equal((await read(reader)).type, 'stop')
  assert.equal((await read(reader)).type, 'audio')
  question.abort()
  assert.equal((await read(reader)).type, 'stop')
  browser.enqueue(job(session, 'new final'))
  assert.equal((await read(reader)).type, 'audio')
  browser.cancelOwner(owner('unrelated'))
  browser.cancelOwner(session)
  assert.equal((await read(reader)).type, 'stop')
  browser.close()
  assert.equal((await reader.read()).done, true, 'only cancellation of the speaking session emits stop')
})

test('disconnecting the last tab cancels synthesis and errors reveal no upstream details', async (t) => {
  let audioSignal
  const warnings = []
  const browser = createBrowserAudio(({ text }, signal) => {
    audioSignal = signal
    if (text === 'error') throw new Error('private upstream detail')
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, error => warnings.push(error))
  t.after(() => browser.close())
  const session = owner('main')
  const reader = open(browser)
  await read(reader)
  browser.enqueue(job(session, 'error'))
  assert.deepEqual(await read(reader), { type: 'error' })
  assert.equal(warnings.length, 1)
  browser.enqueue(job(session, 'still rendering'))
  await nextTick()
  assert.equal(audioSignal.aborted, false)
  await reader.cancel()
  assert.equal(audioSignal.aborted, true)
})

test('browser audio reads local MP3 without a player and bounds streamed Fish responses', async () => {
  const path = fileURLToPath(new URL('../audio/final.mp3', import.meta.url))
  const signal = new AbortController().signal
  assert.deepEqual(await readBrowserAudio(path, signal), await readFile(path))
  const spec = { key: 'host-only', text: 'filtered', model: 's2.1-pro-free', signal }
  const readFish = body => synthesizeBrowserAudio(spec, {
    fetchAudio: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer host-only')
      assert.equal(JSON.parse(options.body).text, 'filtered')
      return new Response(body, { headers: { 'content-type': 'audio/mpeg' } })
    },
  })
  assert.equal((await readFish('mp3')).toString(), 'mp3')
  await assert.rejects(readFish(Buffer.alloc(MAX_AUDIO_BYTES + 1)), { code: 'audio-limit' })
})

test('browser fixed notices work through live hooks with no ffplay or Fish key', async () => {
  const events = new Map()
  const routes = new Map()
  const disposers = []
  const session = { id: 'main', header: {}, firstLiveSeq: 1 }
  const connection = { fetch: { register(route) { routes.set(route.path, route) } } }
  const credentials = { resolve() { assert.fail('fixed Phoebe clip must not read a key') } }
  const parsed = Config['~standard'].validate({ mode: 'notice', playbackTarget: 'browser', playerPath: fileURLToPath(new URL('../no-ffplay', import.meta.url)) }).value
  let target = 'browser'
  const config = { ...parsed, playbackTarget: { get: () => target } }
  apply({
    connection, credentials, agents: new Map([[session.id, { session }]]), workingDirectory: { get: () => process.cwd() },
    on(name, callback) { events.set(name, callback) },
    inject(_services, callback) { callback({ credentials, connection }) },
    effect(register) { disposers.push(register()) },
  }, config)
  const route = routes.get('/api/phoebe-voice.audio')
  const reader = route.fetch(request()).body.getReader()
  try {
    assert.deepEqual(await read(reader), { type: 'ready' })
    const event = (type, data, surfaceOp) => events.get('session/event')(session, { type, data, surfaceOp, seq: 1 })
    event('turn/start', { turn: 1 })
    event('step/start', { turn: 1, step: 1 })
    event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已完成。' }] } }, 'append')
    event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(await read(reader), { type: 'audio', audio: await readFile(new URL('../audio/final.mp3', import.meta.url), 'base64') })
    target = 'host'
    events.get('settings/document-updated')()
    assert.equal((await reader.read()).done, true)
    assert.equal(route.fetch(request()).status, 409)
    target = 'browser'
    events.get('app-boot/config-reload')()
    const reopened = route.fetch(request()).body.getReader()
    assert.deepEqual(await read(reopened), { type: 'ready' })
    await reopened.cancel()
  } finally {
    for (const dispose of disposers) await dispose()
  }
  assert.equal((await reader.read()).done, true)
})
