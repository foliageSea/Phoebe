import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { isFullPath } from './paths.js'
import { finalSpeech, questionSpeech } from './speech.js'

// Keep existing configurations using "/" and make them span all drives on Windows.
export const ALL_WORKSPACES = '/'

export function isWithinWorkspace(root, cwd) {
  if (!isFullPath(cwd) || (root !== ALL_WORKSPACES && !isFullPath(root))) return false
  try {
    const cwdPath = realpathSync.native(cwd)
    if (!statSync(cwdPath).isDirectory()) return false
    if (root === ALL_WORKSPACES) return true
    const rootPath = realpathSync.native(root)
    if (!statSync(rootPath).isDirectory()) return false
    const path = relative(rootPath, cwdPath)
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  } catch {
    return false
  }
}

const GLOBAL = { global: true }

// Observe from the Host so installing the plugin also covers already-live sessions, without
// attaching anything to their Cordis fibers or replaying their durable log.
export function installHooks(ctx, config, playback, warn) {
  const turns = new WeakMap()
  const seenRequests = new WeakSet()
  const seenCalls = new WeakMap()
  const exactAgent = (session) => ctx.agents.get(session.id)
  const eligible = (agent, session = agent?.session) => Boolean(
    config.mode !== 'off' && session && agent?.session === session && session.header.origin !== 'subagent' &&
    exactAgent(session) === agent && isWithinWorkspace(config.workspaceRoot, ctx.workingDirectory.get(session)),
  )

  function safe(effect) {
    try { effect() } catch (error) { warn(error) }
  }

  ctx.on('user-questions/request', (request, next) => {
    let lifetime
    safe(() => {
      const agent = request.agent
      if (request.signal?.aborted || seenRequests.has(request) || !eligible(agent)) return
      const id = request.wait?.callId ?? request.questions?.[0]?.intent?.callId
      let calls = seenCalls.get(agent.session)
      if (id !== undefined && calls?.has(id)) return
      const mode = config.mode
      const text = questionSpeech(request.questions, mode)
      if (!text) return
      seenRequests.add(request)
      if (id !== undefined) {
        if (!calls) seenCalls.set(agent.session, calls = new Set())
        calls.add(id)
        if (calls.size > 128) calls.delete(calls.values().next().value)
      }
      lifetime = new AbortController()
      const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal
      playback.enqueue({
        kind: 'ask', owner: agent.session, text, signal,
        isCurrent: () => config.mode === mode && eligible(agent),
      })
    })
    if (!lifetime) return next()
    try {
      return Promise.resolve(next()).finally(() => lifetime.abort())
    } catch (error) {
      lifetime.abort()
      throw error
    }
  }, { ...GLOBAL, prepend: true })

  ctx.on('session/event', (session, event) => safe(() => {
    switch (event.type) {
      case 'turn/start': {
        playback.cancelOwner(session)
        turns.delete(session)
        const agent = exactAgent(session)
        if (event.seq >= session.firstLiveSeq && eligible(agent, session)) {
          turns.set(session, { agent, turn: event.data.turn, step: undefined, text: '' })
        }
        break
      }
      case 'step/start': {
        const state = turns.get(session)
        if (state?.turn !== event.data.turn) return
        state.step = event.data.step
        state.text = ''
        break
      }
      case 'assistant/message': {
        const state = turns.get(session)
        if (state?.turn !== event.data.turn || state.step !== event.data.step) return
        const { interrupted, message } = event.data
        const blocks = message.content
        state.text = ''
        if (event.surfaceOp !== 'append' || interrupted || blocks.some(block => block.type === 'tool-call')) return
        const visible = []
        let size = 0
        for (const block of blocks) {
          if (block.type !== 'text' || !block.text.trim()) continue
          visible.push(block.text.slice(0, 12_000 - size))
          size += visible.at(-1).length + 1
          if (size >= 12_000) break
        }
        state.text = visible.join('\n')
        break
      }
      case 'turn/end': {
        const state = turns.get(session)
        if (state?.turn !== event.data.turn) return
        turns.delete(session)
        if (event.data.reason.kind !== 'completed') {
          playback.cancelOwner(session)
          return
        }
        if (!state.text || !eligible(state.agent, session)) return
        const mode = config.mode
        playback.enqueue({
          kind: 'final', owner: session, text: finalSpeech(state.text, mode),
          isCurrent: () => config.mode === mode && eligible(state.agent, session),
        })
        break
      }
      case 'working-directory/change': {
        if (!eligible(exactAgent(session), session)) {
          turns.delete(session)
          playback.cancelOwner(session)
        }
        break
      }
    }
  }), GLOBAL)

  ctx.on('agent/disposed', ({ agent }) => safe(() => {
    const session = agent.session
    if (turns.get(session)?.agent === agent) turns.delete(session)
    // An old Agent teardown must not cancel the replacement Agent's jobs.
    if (session && (!exactAgent(session) || exactAgent(session) === agent)) playback.cancelOwner(session)
  }), GLOBAL)

  ctx.on('session/disposed', (session) => safe(() => playback.cancelOwner(session)), GLOBAL)
}
