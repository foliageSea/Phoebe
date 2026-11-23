import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { registerBalanceRoute } from './host/balance.js'
import { createBrowserAudio, registerBrowserAudioRoute } from './host/browser-audio.js'
import { readBrowserAudio, synthesizeBrowserAudio } from './host/browser-render.js'
import { ALL_WORKSPACES, installHooks, isWithinWorkspace } from './host/hooks.js'
import { isFullPath } from './host/paths.js'
import { createPlayback, findPlayer, PHOEBE_VOICE, PlaybackError, playFish, playLocal } from './host/playback.js'
import { createPresets, registerPresetRoute } from './host/preset-route.js'
import { NOTICES } from './host/speech.js'
import { createSummary } from './host/summary.js'

export const name = 'phoebe-voice'
export const inject = ['agents', 'credentials', 'workingDirectory']
export const Config = z.object({
  mode: z.union(['off', 'notice', 'brief', 'summary']).default('off').volatile(),
  playbackTarget: z.union(['host', 'browser']).default('host').volatile(),
  reference_id: z.string().pattern(/^[A-Za-z0-9_-]{1,128}$/).default(PHOEBE_VOICE).volatile(),
  workspaceRoot: z.string().default(ALL_WORKSPACES),
  fishModel: z.union(['s2.1-pro-free', 's2.1-pro']).default('s2.1-pro-free'),
  playerPath: z.string(),
})

export function apply(ctx, config) {
  let mode = config.mode.get()
  const getTarget = () => config.playbackTarget.get()
  let target = getTarget()
  if (mode !== 'off' && config.workspaceRoot !== ALL_WORKSPACES && !isWithinWorkspace(config.workspaceRoot, config.workspaceRoot)) {
    throw new Error('phoebe-voice: workspaceRoot must be an existing absolute directory when enabled')
  }
  if (config.playerPath !== undefined && !isFullPath(config.playerPath)) {
    throw new Error('phoebe-voice: playerPath must be an absolute executable path')
  }

  const resolveKey = async () => (await ctx.credentials.resolve('FISH_API_KEY'))?.value
  const getVoice = () => config.reference_id.get()
  const presets = createPresets({
    resolveKey, getVoice, model: config.fishModel,
    directory: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cache', 'phoebe-voice'),
  })
  const fixedScripts = new Set(Object.values(NOTICES))
  let lastWarning = ''
  let lastWarningAt = 0
  const warn = (error) => {
    const code = error instanceof PlaybackError ? error.code : 'playback-failed'
    const now = Date.now()
    if (lastWarning === code && now - lastWarningAt < 60_000) return
    lastWarning = code
    lastWarningAt = now
    const hint = {
      'missing-key': 'Configure FISH_API_KEY in the host credential store.',
      'missing-preset': 'Prepare fixed audio in the Phoebe voice settings first.',
      'missing-player': 'Install ffplay or configure its absolute playerPath.',
      'http-401': 'Check the Fish Audio API key.',
      'http-402': 'Check Fish Audio billing or choose s2.1-pro-free.',
      'http-429': 'Fish Audio rate limited the request; no retry was attempted.',
    }[code]
    // Never log the upstream response, credentials, paths, or the script being read.
    console.warn(`[phoebe-voice] ${code}.${hint ? ` ${hint}` : ''}`)
  }

  async function render(job, signal, player) {
    let { text } = job
    let key
    if (job.summary) {
      key = (await resolveKey())?.trim()
      signal.throwIfAborted()
      if (!job.isCurrent()) return
      if (key) text = await createSummary(ctx.get?.('llm'), job.summary, signal) ?? text
      signal.throwIfAborted()
      if (!job.isCurrent()) return
    }
    if (fixedScripts.has(text)) {
      const path = await presets.find(text)
      signal.throwIfAborted()
      if (!job.isCurrent()) return
      if (!path) throw new PlaybackError('missing-preset')
      return player ? playLocal({ player, path, signal }) : readBrowserAudio(path, signal)
    }
    if (!job.summary) key = (await resolveKey())?.trim()
    signal.throwIfAborted()
    if (!key) throw new PlaybackError('missing-key')
    if (!job.isCurrent()) return
    const request = { key, text, model: config.fishModel, referenceId: getVoice(), signal }
    return player ? playFish({ ...request, player }) : synthesizeBrowserAudio(request)
  }
  const local = createPlayback(async (job, signal) => {
    const player = findPlayer(config.playerPath)
    if (!player) throw new PlaybackError('missing-player')
    await render(job, signal, player)
  }, warn)
  const browser = createBrowserAudio(render, warn)
  const playback = {
    enqueue(job) {
      const output = getTarget()
      const queue = output === 'browser' ? browser : local
      queue.enqueue({ ...job, isCurrent: () => getTarget() === output && job.isCurrent() })
    },
    cancelOwner(owner) {
      local.cancelOwner(owner)
      browser.cancelOwner(owner)
    },
  }
  ctx.effect(() => () => { browser.close(); return local.dispose() }, 'phoebe-voice: stop playback')
  const syncPlayback = () => {
    const nextMode = config.mode.get()
    const nextTarget = getTarget()
    if (mode !== nextMode || target !== nextTarget) {
      local.cancelAll()
      if (nextMode === 'off' || nextTarget !== 'browser') browser.close()
      else browser.cancelAll()
    }
    mode = nextMode
    target = nextTarget
  }
  ctx.on('settings/document-updated', syncPlayback)
  ctx.on('app-boot/config-reload', syncPlayback)
  ctx.inject(['connection'], (webCtx) => {
    registerBalanceRoute(webCtx)
    registerPresetRoute(webCtx, presets)
    registerBrowserAudioRoute(webCtx, browser, () => getTarget() === 'browser' && config.mode.get() !== 'off')
  })
  installHooks(ctx, { workspaceRoot: config.workspaceRoot, get mode() { return config.mode.get() } }, playback, warn)
}
