import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isFullPath } from '../host/paths.js'
import { findPlayer } from '../host/playback.js'

const win = 'win32'

test('Windows paths require a drive or UNC share, not just a root separator', () => {
  for (const path of ['C:\\', 'D:/媒体/工作区', '\\\\server\\share\\folder']) {
    assert.equal(isFullPath(path, win), true, path)
  }
  for (const path of ['/', '\\folder', 'C:relative', '.\\bin', '\\\\server', '']) {
    assert.equal(isFullPath(path, win), false, path)
  }
})

test('Windows lookup searches only absolute PATH entries in order for ffplay.exe', () => {
  const expected = 'D:\\音频 工具\\bin\\ffplay.exe'
  const visited = []
  const options = {
    platform: win,
    env: { Path: ';.;relative;\\bin;C:bin;C:\\missing;  "D:\\音频 工具\\bin" ;E:\\later' },
    probe(path) { visited.push(path); return path === expected },
  }
  assert.equal(findPlayer(undefined, options), expected)
  assert.deepEqual(visited, ['C:\\missing\\ffplay.exe', expected])
  assert.equal(findPlayer(undefined, { ...options, env: {} }), undefined)
})

test('Linux lookup falls back to absolute Host PATH entries in order', () => {
  const visited = []
  const expected = '/opt/audio tools/bin/ffplay'
  const options = {
    platform: 'linux',
    env: { PATH: ':.::relative:/usr/bin:/opt/missing:/opt/audio tools/bin:/opt/later' },
    probe(path) { visited.push(path); return path === expected },
  }
  assert.equal(findPlayer(undefined, options), expected)
  assert.deepEqual(visited, [
    '/opt/homebrew/bin/ffplay', '/usr/local/bin/ffplay', '/usr/bin/ffplay', '/opt/missing/ffplay', expected,
  ])
  visited.length = 0
  assert.equal(findPlayer('/configured/ffplay', options), undefined)
  assert.deepEqual(visited, ['/configured/ffplay'])
  assert.equal(findPlayer(undefined, { ...options, env: {} }), undefined)
})

test('explicit paths take precedence without falling back, and macOS keeps its fixed candidates', () => {
  const options = {
    platform: win,
    env: { PATH: 'C:\\installed' },
    probe: (path) => ['D:\\Other Tools\\ffplay.exe', 'C:\\installed\\ffplay.exe'].includes(path),
  }
  assert.equal(findPlayer('D:\\Other Tools\\ffplay.exe', options), 'D:\\Other Tools\\ffplay.exe')
  assert.equal(findPlayer('C:\\missing\\ffplay.exe', options), undefined)
  assert.equal(findPlayer('ffplay.exe', options), undefined)
  assert.equal(findPlayer(undefined, {
    platform: 'darwin', probe: (path) => path === '/usr/local/bin/ffplay',
  }), '/usr/local/bin/ffplay')
})

test('native Windows lookup skips a directory named ffplay.exe and finds a file', { skip: process.platform !== win }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'phoebe-players-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = join(dir, 'first')
  const second = join(dir, '音频 工具')
  const player = join(second, 'ffplay.exe')
  await mkdir(join(first, 'ffplay.exe'), { recursive: true })
  await mkdir(second)
  await writeFile(player, 'fixture for file discovery; not executed')
  assert.equal(findPlayer(undefined, { env: { Path: [first, second].join(';') } }), player)
})
