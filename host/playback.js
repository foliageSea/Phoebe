import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isFullPath } from './paths.js'

const FISH_TTS = 'https://api.fish.audio/v1/tts'
export const PHOEBE_VOICE = '8e80c3dcdf894213a10b48e9b08ad8c6'
export const MAX_AUDIO_BYTES = 1_000_000
const MAX_WAIT_MS = { ask: 12_000, final: 20_000 }
const PLAY_TIMEOUT_MS = 30_000
const PLAYER_CANDIDATES = ['/opt/homebrew/bin/ffplay', '/usr/local/bin/ffplay', '/usr/bin/ffplay']

export class PlaybackError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function windowsPlayers(env) {
  const key = Object.keys(env).find(key => key.toUpperCase() === 'PATH')
  if (!key) return []
  return env[key].split(';')
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(entry => isFullPath(entry, 'win32'))
    .map(entry => win32.join(entry, 'ffplay.exe'))
}

function linuxPlayers(env) {
  const fromPath = (env.PATH ?? '').split(posix.delimiter)
    .filter(entry => isFullPath(entry, 'linux'))
    .map(entry => posix.join(entry, 'ffplay'))
  return new Set([...PLAYER_CANDIDATES, ...fromPath])
}

export function findPlayer(explicitPath, { platform = process.platform, env = process.env, probe = isExecutableFile } = {}) {
  const candidates = explicitPath !== undefined ? [explicitPath]
    : platform === 'win32' ? windowsPlayers(env)
    : platform === 'linux' ? linuxPlayers(env) : PLAYER_CANDIDATES
  for (const path of candidates) {
    if (isFullPath(path, platform) && probe(path)) return path
  }
}

// Priority mailbox: one active job, one pending job of each kind. No playback or
// network work runs on the Cordis callback stack, not even player/credential discovery.
export function createPlayback(play, report, now = Date.now) {
  const pending = new Map()
  let active
  let worker
  let disposed = false

  const detach = (job) => job.signal?.removeEventListener('abort', job.cancel)
  function discard(kind, job) {
    if (pending.get(kind) === job) pending.delete(kind)
    detach(job)
    job.controller.abort()
  }

  async function drain() {
    while (!disposed && pending.size) {
      const job = pending.get('ask') ?? pending.get('final')
      pending.delete(job.kind)
      const timeout = AbortSignal.timeout(PLAY_TIMEOUT_MS)
      const signal = AbortSignal.any([job.controller.signal, timeout])
      active = job
      try {
        if (!signal.aborted && job.isCurrent() && now() < job.expiresAt) await play(job, signal)
      } catch (error) {
        if (!job.controller.signal.aborted) report(timeout.aborted ? new PlaybackError('timeout') : error)
      } finally {
        detach(job)
        active = undefined
      }
    }
  }

  function cancelAll() {
    for (const [kind, job] of pending) discard(kind, job)
    active?.controller.abort()
  }

  function schedule() {
    if (worker || disposed) return
    worker = Promise.resolve().then(drain).finally(() => {
      worker = undefined
      if (pending.size) schedule()
    })
  }

  return {
    enqueue(spec) {
      if (disposed || spec.signal?.aborted) return
      const previous = pending.get(spec.kind)
      if (previous) discard(spec.kind, previous)
      const job = {
        ...spec, controller: new AbortController(), expiresAt: now() + MAX_WAIT_MS[spec.kind],
      }
      job.cancel = () => discard(job.kind, job)
      spec.signal?.addEventListener('abort', job.cancel, { once: true })
      pending.set(job.kind, job)
      if (spec.kind === 'ask' && active?.kind === 'final') active.controller.abort()
      schedule()
    },
    cancelOwner(owner) {
      for (const [kind, job] of pending) if (job.owner === owner) discard(kind, job)
      if (active?.owner === owner) active.controller.abort()
    },
    cancelAll,
    async dispose() {
      disposed = true
      cancelAll()
      await worker
    },
    // Wait for the current batch to settle (including any follow-up worker).
    async settled() {
      while (worker) await worker
    },
  }
}

async function* boundedAudio(body, onAudioStart) {
  let bytes = 0
  for await (const chunk of body) {
    if (!chunk.byteLength) continue
    const first = bytes === 0
    bytes += chunk.byteLength
    if (bytes > MAX_AUDIO_BYTES) throw new PlaybackError('audio-limit')
    if (first) onAudioStart?.()
    yield chunk
  }
  if (!bytes) throw new PlaybackError('empty-audio')
}

export async function withFishAudio({ key, text, model, referenceId = PHOEBE_VOICE, signal }, consume, { fetchAudio = fetch } = {}) {
  const receiving = new AbortController()
  const receiveSignal = AbortSignal.any([signal, receiving.signal])
  let body
  try {
    receiveSignal.throwIfAborted()
    const response = await fetchAudio(FISH_TTS, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model },
      body: JSON.stringify({ text, reference_id: referenceId, format: 'mp3', latency: 'balanced' }),
      redirect: 'error',
      signal: receiveSignal,
    })
    body = response.body
    receiveSignal.throwIfAborted()
    if (!response.ok) throw new PlaybackError(`http-${response.status}`)
    if (!body || !/^(?:audio\/[^;]+|application\/octet-stream)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new PlaybackError('invalid-audio')
    }
    const pipeAudio = (output, onAudioStart) => pipeline(Readable.fromWeb(body),
      source => boundedAudio(source, onAudioStart), output, { signal: receiveSignal })
    return await consume(pipeAudio)
  } finally {
    receiving.abort()
    if (body && !body.locked) void body.cancel().catch(() => {})
  }
}

function launchPlayer(player, input, stdin, signal, startPlayer) {
  signal.throwIfAborted()
  const env = { LANG: 'en_US.UTF-8' }
  // Preserve only the runtime settings needed to reach the Host audio session.
  const runtimeKeys = process.platform === 'win32' ? ['SystemRoot', 'WINDIR']
    : process.platform === 'linux' ? ['XDG_RUNTIME_DIR', 'PULSE_SERVER', 'PULSE_COOKIE', 'PIPEWIRE_RUNTIME_DIR'] : []
  for (const key of runtimeKeys) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const child = startPlayer(player, [
    '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-f', 'mp3',
    '-probesize', '1024', '-analyzeduration', '100000', '-volume', '70', '-i', input,
  ], { shell: false, stdio: [stdin, 'ignore', 'ignore'], env, windowsHide: true })
  const exited = new Promise((resolve, reject) => {
    let failed = false
    child.once('error', () => { failed = true })
    child.once('close', (status) => {
      if (!failed && status === 0) resolve()
      else reject(new PlaybackError('player-failed'))
    })
  })
  const stop = () => {
    if (child.pid != null && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  return { child, exited, stop, detach: () => signal.removeEventListener('abort', stop) }
}

export async function playLocal({ player, path, signal }, { startPlayer = spawn } = {}) {
  signal.throwIfAborted()
  if (!isFullPath(path)) throw new PlaybackError('invalid-audio')
  const { exited, detach } = launchPlayer(player, path, 'ignore', signal, startPlayer)
  try {
    await exited
  } finally {
    detach()
    signal.throwIfAborted()
  }
}

export async function playFish({ player, signal, onAudioStart, ...request }, { fetchAudio = fetch, startPlayer = spawn } = {}) {
  const playing = new AbortController()
  const stopSignal = AbortSignal.any([signal, playing.signal])
  return withFishAudio({ ...request, signal: stopSignal }, async (pipeAudio) => {
    const { child, exited, detach, stop } = launchPlayer(player, 'pipe:0', 'pipe', stopSignal, startPlayer)
    let pump
    try {
      if (!child.stdin) throw new PlaybackError('player-failed')
      pump = pipeAudio(child.stdin, onAudioStart)
      await Promise.all([pump, exited])
    } finally {
      detach()
      // Abort the upstream connection before awaiting stream teardown (a read may be parked at EOF).
      playing.abort()
      stop()
      await Promise.allSettled([pump, exited])
    }
  }, { fetchAudio })
}
