import { createReadStream } from 'node:fs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_AUDIO_BYTES, PlaybackError, withFishAudio } from './playback.js'

async function collectAudio(pump) {
  let bytes = 0
  const parts = []
  await pump(new Writable({
    write(chunk, _encoding, done) {
      bytes += chunk.byteLength
      if (bytes > MAX_AUDIO_BYTES) return done(new PlaybackError('audio-limit'))
      parts.push(chunk)
      done()
    },
  }))
  if (!bytes) throw new PlaybackError('empty-audio')
  return Buffer.concat(parts, bytes)
}

export function readBrowserAudio(path, signal) {
  return collectAudio(output => pipeline(createReadStream(path), output, { signal }))
}

export function synthesizeBrowserAudio(options, dependencies) {
  return withFishAudio(options, collectAudio, dependencies)
}
