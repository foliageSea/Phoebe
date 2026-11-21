import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const FISH_TTS = 'https://api.fish.audio/v1/tts'
export const PHOEBE_VOICE = '8e80c3dcdf894213a10b48e9b08ad8c6'
const MAX_AUDIO_BYTES = 1_000_000
const MAX_WAIT_MS = { ask: 12_000, final: 20_000 }
const PLAY_TIMEOUT_MS = 30_000
const PLAYER_CANDIDATES = ['/opt/homebrew/bin/ffplay', '/usr/local/bin/ffplay', '/usr/bin/ffplay']

export class PlaybackError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

export function findPlayer(explicitPath) {
  for (const path of explicitPath ? [explicitPath] : PLAYER_CANDIDATES) {
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return path
    } catch { /* probe the next fixed path */ }
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

async function* boundedAudio(body) {
  let bytes = 0
  for await (const chunk of body) {
    bytes += chunk.byteLength
    if (bytes > MAX_AUDIO_BYTES) throw new PlaybackError('audio-limit')
    yield chunk
  }
  if (!bytes) throw new PlaybackError('empty-audio')
}

export async function playFish({ key, player, text, model, referenceId = PHOEBE_VOICE, signal }, { fetchAudio = fetch, startPlayer = spawn } = {}) {
  const playing = new AbortController()
  const stopSignal = AbortSignal.any([signal, playing.signal])
  stopSignal.throwIfAborted()
  const response = await fetchAudio(FISH_TTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model },
    body: JSON.stringify({ text, reference_id: referenceId, format: 'mp3', latency: 'balanced' }),
    redirect: 'error',
    signal: stopSignal,
  })
  let child
  let pump
  let exited
  const stop = () => {
    if (child?.pid != null && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  }
  try {
    stopSignal.throwIfAborted()
    if (!response.ok) throw new PlaybackError(`http-${response.status}`)
    if (!response.body || !/^(?:audio\/[^;]+|application\/octet-stream)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new PlaybackError('invalid-audio')
    }
    child = startPlayer(player, [
      '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-f', 'mp3',
      '-probesize', '1024', '-analyzeduration', '100000', '-volume', '70', '-i', 'pipe:0',
    ], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], env: { LANG: 'en_US.UTF-8' }, windowsHide: true })
    exited = new Promise((resolve, reject) => {
      let failed = false
      child.once('error', () => { failed = true })
      child.once('close', (status) => {
        if (!failed && status === 0) resolve()
        else reject(new PlaybackError('player-failed'))
      })
    })
    stopSignal.addEventListener('abort', stop, { once: true })
    if (stopSignal.aborted) stop()
    if (!child.stdin) throw new PlaybackError('player-failed')
    pump = pipeline(Readable.from(boundedAudio(response.body), { objectMode: false }), child.stdin, { signal: stopSignal })
    await Promise.all([pump, exited])
  } finally {
    stopSignal.removeEventListener('abort', stop)
    // Abort the upstream connection before awaiting stream teardown (a read may be parked at EOF).
    playing.abort()
    stop()
    await Promise.allSettled([pump, exited])
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}
