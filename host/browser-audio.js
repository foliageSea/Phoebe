import { createPlayback } from './playback.js'

const PATH = '/api/phoebe-voice.audio'
const HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
  'x-accel-buffering': 'no',
}
const encoder = new TextEncoder()
const packet = (message) => encoder.encode(JSON.stringify(message) + '\n')
const READY = packet({ type: 'ready' })
const PING = packet({ type: 'ping' })
const STOP = packet({ type: 'stop' })
const ERROR = packet({ type: 'error' })

// No replay buffer: snapshots only include tabs listening when a live event arrived.
export function createBrowserAudio(render, warn, { maxListeners = 16, heartbeatMs = 10_000 } = {}) {
  const subscribers = new Set()
  let nextId = 0
  const queue = createPlayback(async (job, audioSignal) => {
    let audio
    try {
      audio = await render(job, audioSignal)
    } catch (error) {
      if ((!audioSignal.aborted || audioSignal.reason?.name === 'TimeoutError') && job.isCurrent()) {
        for (const tab of job.tabs) if (subscribers.has(tab)) tab.send(ERROR)
      }
      throw error
    }
    audioSignal.throwIfAborted()
    if (!audio || !job.isCurrent()) return
    const waitMs = Math.min(20_000, job.expiresAt - Date.now())
    if (waitMs <= 0) return
    const id = ++nextId
    const chunk = packet({ type: 'audio', id, waitMs, audio: audio.toString('base64') })
    for (const tab of job.tabs) if (subscribers.has(tab)) tab.deliver(chunk, job, id, waitMs)
  }, warn)

  function open(signal) {
    if (subscribers.size >= maxListeners) return new Response(null, { status: 429, headers: HEADERS })
    if (signal.aborted) return new Response(null, { status: 400, headers: HEADERS })
    let tab
    const stream = new ReadableStream({
      start(controller) {
        let timer, closed = false
        const delivered = new Map()
        const forget = (id) => {
          const clip = delivered.get(id)
          if (!clip) return false
          delivered.delete(id)
          clearTimeout(clip.timeout)
          clip.signal?.removeEventListener('abort', clip.cancel)
          return true
        }
        const clear = () => { for (const id of delivered.keys()) forget(id) }
        const send = (chunk) => {
          if (closed) return false
          // A live subscriber can absorb a burst, but cannot buffer audio indefinitely.
          if (controller.desiredSize <= 0) { tab.close('backpressure'); return false }
          controller.enqueue(chunk)
          return true
        }
        const cancelClip = (id) => {
          if (forget(id)) send(packet({ type: 'cancel', id }))
        }
        tab = {
          send,
          deliver(chunk, { owner, kind, signal }, id, waitMs) {
            if (signal?.aborted) return
            if (delivered.size >= 32) cancelClip(delivered.keys().next().value)
            if (!send(chunk)) return
            const cancel = () => cancelClip(id)
            const timeout = setTimeout(() => forget(id), waitMs + 30_000)
            timeout.unref()
            delivered.set(id, { owner, kind, signal, cancel, timeout })
            signal?.addEventListener('abort', cancel, { once: true })
          },
          cancelOwner(owner, onlyKind) {
            for (const [id, clip] of delivered) {
              if (clip.owner === owner && (!onlyKind || clip.kind === onlyKind)) cancelClip(id)
            }
          },
          stop() {
            clear()
            send(STOP)
          },
          close(reason) {
            if (closed) return
            closed = true
            clear()
            clearInterval(timer)
            signal.removeEventListener('abort', disconnect)
            subscribers.delete(tab)
            if (reason === 'backpressure') controller.error(new Error('Slow browser audio stream'))
            else if (reason !== 'canceled') controller.close()
            if (!subscribers.size) queue.cancelAll()
          },
        }
        const disconnect = () => tab.close()
        subscribers.add(tab)
        signal.addEventListener('abort', disconnect, { once: true })
        send(READY)
        timer = setInterval(() => send(PING), heartbeatMs)
        timer.unref?.()
      },
      cancel() { tab.close('canceled') },
    }, { highWaterMark: 16 })
    return new Response(stream, { headers: HEADERS })
  }

  return {
    open,
    enqueue(job) {
      if (!subscribers.size || job.signal?.aborted) return
      const tabs = [...subscribers]
      queue.enqueue({ ...job, tabs, isCurrent: () => tabs.some(tab => subscribers.has(tab)) && job.isCurrent() })
    },
    cancelOwner(owner, onlyKind) {
      queue.cancelOwner(owner, onlyKind)
      for (const tab of subscribers) tab.cancelOwner(owner, onlyKind)
    },
    cancelAll() {
      queue.cancelAll()
      for (const tab of subscribers) tab.stop()
    },
    close() {
      for (const tab of subscribers) tab.close()
    },
  }
}

export function registerBrowserAudioRoute(ctx, browser, enabled) {
  // DSH Connection admits only authenticated owner peers to exact Fetch routes.
  ctx.connection.fetch.register({
    path: PATH, methods: ['GET'], requestBody: 'buffered',
    fetch(request) {
      const query = new URL(request.url).searchParams
      const reject = (status) => new Response(null, { status, headers: HEADERS })
      if (request.headers.get('x-phoebe-browser-audio') !== '2') return reject(400)
      // Do not silently upgrade older clients that requested only one session.
      if (query.get('scope') !== 'all' || query.has('session')) return reject(400)
      if (!enabled()) return reject(409)
      return browser.open(request.signal)
    },
  })
}
