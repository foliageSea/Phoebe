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
  const channels = new Map()
  let listeners = 0

  function open(id, signal) {
    if (listeners >= maxListeners) return new Response(null, { status: 429, headers: HEADERS })
    if (signal.aborted) return new Response(null, { status: 400, headers: HEADERS })
    let channel = channels.get(id)
    if (!channel) {
      const subscribers = new Set()
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
        const chunk = packet({ type: 'audio', audio: audio.toString('base64') })
        for (const tab of job.tabs) if (subscribers.has(tab)) tab.play(chunk, job)
      }, warn)
      channel = { subscribers, queue }
      channels.set(id, channel)
    }
    const { subscribers, queue } = channel
    let tab
    const stream = new ReadableStream({
      start(controller) {
        let playing, timer, closed = false
        const clear = () => {
          playing?.signal?.removeEventListener('abort', stopOnAbort)
          playing = undefined
        }
        const send = (chunk) => {
          if (closed) return false
          // Drop a slow connection instead of queuing stale audio indefinitely.
          if (controller.desiredSize <= 0) { tab.close(); return false }
          controller.enqueue(chunk)
          return true
        }
        const stopOnAbort = () => tab.stop()
        tab = {
          send,
          play(chunk, job) {
            clear()
            if (job.signal?.aborted || !send(chunk)) return
            playing = { owner: job.owner, kind: job.kind, signal: job.signal }
            job.signal?.addEventListener('abort', stopOnAbort, { once: true })
          },
          stop(owner, onlyKind) {
            if (!playing || (owner && playing.owner !== owner) || (onlyKind && playing.kind !== onlyKind)) return
            clear()
            send(STOP)
          },
          close(cancelled = false) {
            if (closed) return
            closed = true
            clear()
            clearInterval(timer)
            signal.removeEventListener('abort', disconnect)
            subscribers.delete(tab)
            listeners--
            if (!cancelled) controller.close()
            if (!subscribers.size) {
              channels.delete(id)
              void queue.dispose()
            }
          },
        }
        const disconnect = () => tab.close()
        subscribers.add(tab)
        listeners++
        signal.addEventListener('abort', disconnect, { once: true })
        send(READY)
        timer = setInterval(() => send(PING), heartbeatMs)
        timer.unref?.()
      },
      cancel() { tab.close(true) },
    }, { highWaterMark: 2 })
    return new Response(stream, { headers: HEADERS })
  }

  return {
    open,
    enqueue(job) {
      const channel = channels.get(job.owner.id)
      if (!channel || job.signal?.aborted) return
      const tabs = [...channel.subscribers]
      if (job.kind === 'ask') for (const tab of tabs) tab.stop(job.owner, 'final')
      channel.queue.enqueue({ ...job, tabs, isCurrent: () => tabs.some(tab => channel.subscribers.has(tab)) && job.isCurrent() })
    },
    cancelOwner(owner) {
      const channel = channels.get(owner.id)
      if (!channel) return
      channel.queue.cancelOwner(owner)
      for (const tab of channel.subscribers) tab.stop(owner)
    },
    cancelAll() {
      for (const { queue, subscribers } of channels.values()) {
        queue.cancelAll()
        for (const tab of subscribers) tab.stop()
      }
    },
    close() {
      for (const { subscribers } of channels.values()) for (const tab of subscribers) tab.close()
    },
  }
}

export function registerBrowserAudioRoute(ctx, browser, enabled) {
  // DSH Connection admits only authenticated owner peers to exact Fetch routes.
  ctx.connection.fetch.register({
    path: PATH, methods: ['GET'], requestBody: 'buffered',
    fetch(request) {
      const id = new URL(request.url).searchParams.get('session')
      const reject = (status) => new Response(null, { status, headers: HEADERS })
      if (request.headers.get('x-phoebe-browser-audio') !== '1') return reject(400)
      if (!id || id.length > 256 || /[\s\x00-\x1f\x7f]/u.test(id)) return reject(400)
      if (!enabled()) return reject(409)
      return browser.open(id, request.signal)
    },
  })
}
