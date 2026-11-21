import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { MAX_AUDIO_BYTES, playLocal } from '../host/playback.js'
import { createPresets } from '../host/presets.js'
import { NOTICES } from '../host/speech.js'

const fixed = Object.values(NOTICES)
const audio = (body = Uint8Array.of(1, 2, 3)) => new Response(body, { headers: { 'content-type': 'audio/mpeg' } })

async function cacheDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'phoebe-presets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'notices')
}

function fixture(directory, overrides = {}) {
  return {
    resolveKey: async () => ' test-key ',
    getVoice: () => 'voice-a',
    model: 's2.1-pro-free',
    directory,
    fetchAudio: async () => assert.fail('unexpected network request'),
    ...overrides,
  }
}

test('prepares exactly three fixed notices, coalesces calls, and publishes no partial MP3', { timeout: 2_000 }, async (t) => {
  const directory = await cacheDirectory(t)
  let firstStarted
  const started = new Promise(resolve => { firstStarted = resolve })
  let keyReads = 0
  const calls = []
  const presets = createPresets(fixture(directory, {
    resolveKey: async () => { keyReads++; return ' test-key ' },
    fetchAudio: async (url, request) => {
      assert.equal(url, 'https://api.fish.audio/v1/tts')
      assert.equal(request.headers.model, 's2.1-pro-free')
      assert.equal(request.headers.authorization, 'Bearer test-key')
      assert.equal(request.redirect, 'error')
      calls.push(JSON.parse(request.body))
      if (calls.length !== 1) return audio()
      return audio(new ReadableStream({ start(controller) {
        controller.enqueue(Uint8Array.of(1, 2))
        firstStarted(controller)
      } }))
    },
  }))
  assert.deepEqual(await presets.status(), { status: 'missing' })
  assert.equal(await presets.find('private conversation text'), undefined)
  const work = [presets.prepare(), presets.prepare(), presets.prepare()]
  const producer = await started
  assert.equal(await presets.find(fixed[0]), undefined)
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.mp3')))
  producer.enqueue(Uint8Array.of(3)); producer.close()
  assert.deepEqual(await Promise.all(work), Array(3).fill({ status: 'ready' }))
  assert.equal(keyReads, 2)
  assert.deepEqual(calls, fixed.map(text => ({ text, reference_id: 'voice-a', format: 'mp3', latency: 'balanced' })))
  for (const text of fixed) {
    const file = await presets.find(text)
    assert.ok(isAbsolute(file))
    assert.deepEqual(await readFile(file), Buffer.from([1, 2, 3]))
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0)
  }
  assert.deepEqual((await readdir(directory)).length, 3)
})

test('disk cache survives a fresh instance and separates voices and models', async (t) => {
  const directory = await cacheDirectory(t)
  let voice = 'voice-a'
  let calls = 0
  const options = fixture(directory, { getVoice: () => voice, fetchAudio: async () => { calls++; return audio() } })
  const initial = createPresets(options)
  assert.deepEqual(await initial.prepare(), { status: 'ready' })
  const pathA = await initial.find(fixed[0])
  const fresh = createPresets(fixture(directory, {
    resolveKey: () => assert.fail('ready cache does not need a credential'),
  }))
  assert.equal(await fresh.find(fixed[0]), pathA)
  assert.deepEqual(await fresh.status(), { status: 'ready' })
  assert.deepEqual(await fresh.prepare(), { status: 'ready' })
  voice = 'voice-b'
  assert.equal(await initial.find(fixed[0]), undefined)
  assert.equal(await initial.find(fixed[0], 'voice-a'), pathA)
  assert.deepEqual(await initial.status(), { status: 'missing' })
  assert.deepEqual(await initial.prepare(), { status: 'ready' })
  const pathB = await initial.find(fixed[0])
  assert.notEqual(pathA, pathB)
  const otherModel = createPresets({ ...options, model: 's2.1-pro' })
  assert.equal(await otherModel.find(fixed[0]), undefined)
  assert.deepEqual(await otherModel.prepare(), { status: 'ready' })
  assert.notEqual(await otherModel.find(fixed[0]), pathB)
  assert.equal(calls, 9)
})

test('a provider failure leaves earlier files ready to reuse and does not retry or switch models', async (t) => {
  const directory = await cacheDirectory(t)
  let fail = true
  const calls = []
  const presets = createPresets(fixture(directory, {
    fetchAudio: async (_url, { body, headers }) => {
      const { text } = JSON.parse(body)
      calls.push([text, headers.model])
      if (fail && text === fixed[1]) return new Response('upstream private details', { status: 429 })
      return audio()
    },
  }))
  assert.deepEqual(await presets.prepare(), { status: 'http-429' })
  assert.ok(await presets.find(fixed[0]))
  assert.equal(await presets.find(fixed[1]), undefined)
  assert.equal((await readdir(directory)).length, 1)
  fail = false
  assert.deepEqual(await presets.prepare(), { status: 'ready' })
  assert.deepEqual(calls, [fixed[0], fixed[1], fixed[1], fixed[2]].map(text => [text, 's2.1-pro-free']))
})

test('missing credentials and invalid, empty, or oversized responses do not publish a preset', async (t) => {
  const directory = await cacheDirectory(t)
  const missing = createPresets(fixture(directory, { resolveKey: async () => ' ' }))
  assert.deepEqual(await missing.status(), { status: 'missing-key' })
  assert.deepEqual(await missing.prepare(), { status: 'missing-key' })
  await assert.rejects(readdir(directory), { code: 'ENOENT' })
  for (const nextResponse of [
    () => new Response('not audio'),
    () => audio(new Uint8Array(0)),
    () => audio(new Uint8Array(MAX_AUDIO_BYTES + 1)),
  ]) {
    const presets = createPresets(fixture(directory, { fetchAudio: async () => nextResponse() }))
    assert.deepEqual(await presets.prepare(), { status: 'unavailable' })
    assert.equal(await presets.find(fixed[0]), undefined)
    assert.deepEqual(await readdir(directory), [])
  }
})

test('an empty cached file is a miss and is replaced without generating the other notices again', async (t) => {
  const directory = await cacheDirectory(t)
  const calls = []
  const presets = createPresets(fixture(directory, {
    fetchAudio: async (_url, { body }) => { calls.push(JSON.parse(body).text); return audio() },
  }))
  assert.deepEqual(await presets.prepare(), { status: 'ready' })
  const file = await presets.find(fixed[0])
  await writeFile(file, '')
  assert.equal(await presets.find(fixed[0]), undefined)
  assert.deepEqual(await presets.status(), { status: 'missing' })
  assert.deepEqual(await presets.prepare(), { status: 'ready' })
  assert.equal(await presets.find(fixed[0]), file)
  assert.deepEqual(calls, [...fixed, fixed[0]])
})

test('a stalled audio stream is canceled and its staging data removed on timeout', { timeout: 2_000 }, async (t) => {
  // AbortSignal.timeout alone does not keep the test process alive.
  const keepAlive = setTimeout(() => {}, 2_000)
  t.after(() => clearTimeout(keepAlive))
  const directory = await cacheDirectory(t)
  let canceled = false
  const presets = createPresets(fixture(directory, {
    timeoutMs: 200,
    fetchAudio: async () => audio(new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1)) },
      cancel() { canceled = true },
    })),
  }))
  assert.deepEqual(await presets.prepare(), { status: 'unavailable' })
  assert.equal(canceled, true)
  assert.deepEqual(await readdir(directory), [])
})

function fakeLocalPlayer() {
  const child = new EventEmitter()
  child.pid = 123
  child.exit = (status) => { child.exitCode = status; child.emit('close', status) }
  child.kill = (signal) => { child.signalCode = signal; child.emit('close', null) }
  return child
}

test('local playback passes an absolute filename as a single argument without a shell or credential env', async () => {
  const child = fakeLocalPlayer()
  const path = join(tmpdir(), 'Phoebe notice ; untouched.mp3')
  const work = playLocal({ player: '/bin/ffplay', path, signal: new AbortController().signal }, {
    startPlayer(file, args, options) {
      assert.equal(file, '/bin/ffplay')
      assert.deepEqual(args.slice(-2), ['-i', path])
      assert.equal(options.shell, false)
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore'])
      assert.equal(options.env.FISH_API_KEY, undefined)
      return child
    },
  })
  child.exit(0)
  await work
  await assert.rejects(playLocal({ player: '/bin/ffplay', path: 'https://example.test/voice.mp3', signal: new AbortController().signal }, {
    startPlayer: () => assert.fail('invalid input must not start a player'),
  }), { code: 'invalid-audio' })
})

test('local playback suppresses pre-aborted work, kills on active abort, and reports failed players', async () => {
  const abort = new AbortController()
  const spec = { player: '/bin/ffplay', path: join(tmpdir(), 'notice.mp3'), signal: abort.signal }
  const child = fakeLocalPlayer()
  const work = playLocal(spec, { startPlayer: () => child })
  abort.abort()
  await assert.rejects(work, { name: 'AbortError' })
  assert.equal(child.signalCode, 'SIGKILL')
  await assert.rejects(playLocal(spec, { startPlayer: () => assert.fail('already aborted') }), { name: 'AbortError' })
  const failed = fakeLocalPlayer()
  const failedWork = playLocal({ ...spec, signal: new AbortController().signal }, { startPlayer: () => failed })
  failed.emit('error', new Error('private OS detail'))
  failed.exit(-1)
  await assert.rejects(failedWork, { code: 'player-failed', message: 'player-failed' })
})
