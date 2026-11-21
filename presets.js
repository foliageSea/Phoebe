import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { MAX_AUDIO_BYTES, PlaybackError, withFishAudio } from './playback.js'
import { NOTICES } from './speech.js'

const FIXED_TEXTS = Object.values(NOTICES)
const PREPARE_TIMEOUT_MS = 25_000

async function statIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function usableFile(path) {
  const entry = await statIfPresent(path)
  return entry?.isFile() && entry.size > 0 && entry.size <= MAX_AUDIO_BYTES
}

export function createPresets({ resolveKey, getVoice, model, directory, fetchAudio, timeoutMs = PREPARE_TIMEOUT_MS }) {
  const pending = new Map()

  function pathFor(text, voice) {
    const digest = createHash('sha256').update(JSON.stringify([model, voice, text])).digest('hex')
    return join(directory, `${digest}.mp3`)
  }

  async function hasDirectory() {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('invalid preset directory')
    const entry = await statIfPresent(directory)
    if (entry && !entry.isDirectory()) throw new Error('invalid preset directory')
    return Boolean(entry)
  }

  async function missingTexts(voice) {
    if (typeof voice !== 'string' || !voice) throw new Error('invalid preset voice')
    if (!await hasDirectory()) return FIXED_TEXTS
    const present = await Promise.all(FIXED_TEXTS.map(text => usableFile(pathFor(text, voice))))
    return FIXED_TEXTS.filter((_, index) => !present[index])
  }

  const readKey = async () => (await resolveKey())?.trim()

  async function populate(voice) {
    try {
      const missing = await missingTexts(voice)
      if (!missing.length) return { status: 'ready' }
      const key = await readKey()
      if (!key) return { status: 'missing-key' }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await hasDirectory()
      const signal = AbortSignal.timeout(timeoutMs)
      // Stage on the same filesystem. Each rename makes only a complete, bounded file visible.
      const staging = await mkdtemp(join(directory, '.prepare-'))
      try {
        for (const text of missing) {
          signal.throwIfAborted()
          const path = pathFor(text, voice)
          if (await usableFile(path)) continue
          const part = join(staging, 'audio.part')
          await withFishAudio({ key, model, text, referenceId: voice, signal }, pipeAudio =>
            pipeAudio(createWriteStream(part, { flags: 'wx', mode: 0o600 })), { fetchAudio })
          signal.throwIfAborted()
          await rename(part, path)
        }
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      return { status: 'ready' }
    } catch (error) {
      const status = error instanceof PlaybackError && /^http-\d{3}$/.test(error.code) ? error.code : 'unavailable'
      return { status }
    }
  }

  return {
    async find(text, voice) {
      if (!FIXED_TEXTS.includes(text)) return undefined
      try {
        if (voice === undefined) voice = getVoice()
        if (typeof voice !== 'string' || !voice || !await hasDirectory()) return undefined
        const path = pathFor(text, voice)
        if (await usableFile(path)) return path
      } catch { /* A cache failure is a miss for playback. */ }
    },
    async prepare(voice) {
      try {
        if (voice === undefined) voice = getVoice()
        if (pending.has(voice)) return await pending.get(voice)
        const work = populate(voice).finally(() => pending.delete(voice))
        pending.set(voice, work)
        return await work
      } catch {
        return { status: 'unavailable' }
      }
    },
    async status(voice) {
      try {
        if (!(await missingTexts(voice ?? getVoice())).length) return { status: 'ready' }
        return { status: await readKey() ? 'missing' : 'missing-key' }
      } catch {
        return { status: 'unavailable' }
      }
    },
  }
}
