import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { registerBalanceRoute } from './host/balance.js'
import { installHooks, isWithinWorkspace } from './host/hooks.js'
import { createPlayback, findPlayer, PHOEBE_VOICE, PlaybackError, playFish, playLocal } from './host/playback.js'
import { createPresets, registerPresetRoute } from './host/preset-route.js'
import { NOTICES } from './host/speech.js'

export const name = 'phoebe-voice'
export const inject = ['agents', 'credentials', 'workingDirectory']
export const Config = z.object({
  mode: z.union(['off', 'notice', 'brief']).default('off').volatile(),
  reference_id: z.string().pattern(/^[A-Za-z0-9_-]{1,128}$/).default(PHOEBE_VOICE).volatile(),
  workspaceRoot: z.string(),
  fishModel: z.union(['s2.1-pro-free', 's2.1-pro']).default('s2.1-pro-free'),
  playerPath: z.string(),
})

export function apply(ctx, config) {
  let mode = config.mode.get()
  if (mode !== 'off' && !isWithinWorkspace(config.workspaceRoot, config.workspaceRoot)) {
    throw new Error('phoebe-voice: workspaceRoot must be an existing absolute directory when enabled')
  }
  if (config.playerPath !== undefined && !isAbsolute(config.playerPath)) {
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

  const playback = createPlayback(async (job, signal) => {
    const player = findPlayer(config.playerPath)
    if (!player) throw new PlaybackError('missing-player')
    if (fixedScripts.has(job.text)) {
      const path = await presets.find(job.text)
      signal.throwIfAborted()
      if (!job.isCurrent()) return
      if (!path) throw new PlaybackError('missing-preset')
      await playLocal({ player, path, signal })
      return
    }
    const key = (await resolveKey())?.trim()
    signal.throwIfAborted()
    if (!key) throw new PlaybackError('missing-key')
    if (!job.isCurrent()) return
    await playFish({
      key, player, text: job.text, model: config.fishModel, referenceId: config.reference_id.get(), signal,
    })
  }, warn)
  ctx.effect(() => () => playback.dispose(), 'phoebe-voice: stop local playback')
  const syncMode = () => {
    const nextMode = config.mode.get()
    if (mode !== nextMode) playback.cancelAll()
    mode = nextMode
  }
  ctx.on('settings/document-updated', syncMode)
  ctx.on('app-boot/config-reload', syncMode)
  ctx.inject(['connection'], (webCtx) => {
    registerBalanceRoute(webCtx)
    registerPresetRoute(webCtx, presets)
  })
  installHooks(ctx, { workspaceRoot: config.workspaceRoot, get mode() { return config.mode.get() } }, playback, warn)
}
