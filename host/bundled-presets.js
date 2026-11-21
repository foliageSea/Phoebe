import { lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import manifest from '../audio/presets.json' with { type: 'json' }
import { MAX_AUDIO_BYTES } from './playback.js'
import { NOTICES } from './speech.js'

const clips = new Map(Object.entries(NOTICES)
  // A changed script must not silently keep playing the old recording.
  .filter(([kind, text]) => manifest.texts[kind] === text)
  .map(([kind, text]) => [text, fileURLToPath(new URL(`../audio/${kind}.mp3`, import.meta.url))]))

export async function bundledPreset(text, voice) {
  if (voice !== manifest.referenceId) return undefined
  const path = clips.get(text)
  if (!path) return undefined
  try {
    const info = await lstat(path)
    if (info.isFile() && info.size > 0 && info.size <= MAX_AUDIO_BYTES) return path
  } catch { /* An incomplete install can still use a user-generated preset. */ }
}
