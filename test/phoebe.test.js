import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { apply, Config } from '../index.js'
import { installHooks, isWithinWorkspace } from '../host/hooks.js'
import { createPlayback, PHOEBE_VOICE, playFish } from '../host/playback.js'
import { finalSpeech, MAX_SPOKEN, questionSpeech } from '../host/speech.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeHost({ cwd = process.cwd(), origin, mode = 'brief', workspaceRoot = process.cwd() } = {}) {
  const hooks = new Map()
  const queued = []
  const canceled = []
  const warnings = []
  const session = { id: 'main', header: { origin }, firstLiveSeq: 10, cwd }
  const agent = { id: session.id, session }
  const agents = new Map([[session.id, agent]])
  const host = {
    on(name, fn, options) { hooks.set(name, { fn, options }) },
    agents,
    workingDirectory: { get: (session) => session.cwd },
  }
  const playback = { enqueue: (job) => queued.push(job), cancelOwner: (owner) => canceled.push(owner) }
  installHooks(host, { mode, workspaceRoot }, playback, (error) => warnings.push(error))
  let seq = 10
  const publish = (type, data, extra = {}) => hooks.get('session/event').fn(session, { type, data, seq: seq++, ...extra })
  const start = (turn, step = 1) => { publish('turn/start', { turn }); publish('step/start', { turn, step }) }
  const message = (turn, step, content, flags, surfaceOp = 'append') => publish('assistant/message', {
    turn, step, message: { content }, ...flags,
  }, { surfaceOp })
  const end = (turn, kind = 'completed') => publish('turn/end', { turn, reason: { kind } })
  const ask = (request, next) => hooks.get('user-questions/request').fn({ agent, ...request }, next)
  return { hooks, queued, canceled, warnings, host, session, agent, agents, publish, start, message, end, ask }
}

const text = (text) => ({ type: 'text', text })
const questions = [{ id: 'color', question: '你更喜欢蓝色还是绿色？' }]

// Config validation is exercised through the same Standard Schema entry Cordis uses.
const parse = (config) => Config['~standard'].validate(config)
test('configuration defaults to silence and all workspaces; explicit paths must be absolute', () => {
  const defaults = parse({}).value
  assert.equal(defaults.mode.get(), 'off')
  assert.equal(defaults.playbackTarget.get(), 'host')
  assert.equal(parse({ playbackTarget: 'browser' }).value.playbackTarget.get(), 'browser')
  assert.ok(parse({ playbackTarget: 'both' }).issues.length)
  assert.equal(defaults.workspaceRoot, '/')
  assert.doesNotThrow(() => apply({ on() {}, inject() {}, effect() {} }, parse({ mode: 'notice' }).value))
  assert.equal(defaults.reference_id.get(), PHOEBE_VOICE)
  assert.equal(parse({ reference_id: 'another_voice-42' }).value.reference_id.get(), 'another_voice-42')
  assert.ok(parse({ reference_id: 'https://fish.audio/m/abc' }).issues.length)
  assert.ok(parse({ mode: 'unknown' }).issues.length)
  assert.throws(() => apply({}, parse({ mode: 'brief', workspaceRoot: '.' }).value), /workspaceRoot/)
  assert.throws(() => apply({}, parse({ mode: 'brief', workspaceRoot: process.cwd(), playerPath: './ffplay' }).value), /playerPath/)
})

test('off mode ignores questions and final replies without blocking the agent', async () => {
  const h = fakeHost({ mode: 'off' })
  assert.equal(await h.ask({ questions }, async () => 'unchanged'), 'unchanged')
  h.start(1); h.message(1, 1, [text('不要播报。')]); h.end(1)
  assert.equal(h.queued.length, 0)
})

test('brief output speaks useful conclusions and excludes common sensitive or technical text', () => {
  const original = [
    '# 背景', '我先调查了相关选项。', '```bash', '隐藏的命令', '```',
    '    隐藏的缩进代码', 'curl https://example.test/private', '令牌是 pretend-secret',
    '已实现语音播报，见 [使用说明](https://example.test/deep/private) 和 `/tmp/private.txt`。',
    '仍需实际听验。', '- https://hidden.example/foo',
  ].join('\n')
  const script = finalSpeech(original, 'brief')
  assert.match(script, /我把这一轮的要点整理好了。已实现语音播报/)
  assert.match(script, /仍需实际听验/)
  assert.doesNotMatch(script, /调查|隐藏|curl|example|private|pretend/u)
  assert.ok(Array.from(script).length <= MAX_SPOKEN)
  assert.doesNotMatch(finalSpeech('密码为不该朗读的内容。\n你的取件码是 6048。', 'brief'), /密码|不该|6048/)
  assert.doesNotMatch(finalSpeech('## 测试结果\n已完成校验，两个用例都通过。', 'brief'), /测试结果。/)
  assert.doesNotMatch(finalSpeech('案'.repeat(150) + '。', 'brief'), /案案/)
})

test('notices are fixed; questions use only first question and do not read option details', () => {
  const batch = [{ ...questions[0], options: [{ label: '隐藏的选项' }], detail: '隐藏的详情' }, { question: '第二个问题？' }]
  const brief = questionSpeech(batch, 'brief')
  assert.match(brief, /漂泊者.*你更喜欢蓝色还是绿色/)
  assert.match(brief, /其他问题也在对话里/)
  assert.doesNotMatch(brief, /隐藏|第二个问题/)
  assert.equal(questionSpeech(batch, 'notice'), questionSpeech([{ question: '另一段文字' }], 'notice'))
  assert.equal(finalSpeech('结果甲', 'notice'), finalSpeech('结果乙', 'notice'))
  assert.match(questionSpeech([{ question: '私密计划', intent: { kind: 'plan-review' } }], 'brief'), /计划已写在对话里/)
  assert.equal(questionSpeech([{ question: '授权', intent: { kind: 'approval' } }], 'brief'), '')
})

test('question hook immediately delegates and cancels on settlement; timed requests are deduplicated', async () => {
  const h = fakeHost()
  const wait = deferred()
  const answer = { answers: [{ id: 'color', selected: ['蓝色'] }] }
  let calls = 0
  const timed = { questions, wait: { callId: 'call-1', timed: true } }
  const first = h.ask(timed, () => { calls++; return wait.promise })
  const second = h.ask(timed, () => { calls++; return wait.promise })
  assert.equal(calls, 2)
  assert.equal(h.queued.length, 1)
  assert.equal(h.hooks.get('user-questions/request').options.prepend, true)
  assert.equal(h.queued[0].signal.aborted, false)
  wait.resolve(answer)
  assert.equal(await first, answer)
  assert.equal(await second, answer)
  assert.equal(h.queued[0].signal.aborted, true)
})

test('legacy questions preserve sync throws and async rejection even if narration fails', async () => {
  const h = fakeHost()
  const failure = new Error('answerer failed')
  const request = { questions, signal: new AbortController().signal }
  assert.throws(() => h.ask(request, () => { throw failure }), (error) => error === failure)
  assert.equal(h.queued[0].signal.aborted, true)
  await assert.rejects(h.ask(request, () => Promise.reject(failure)), (error) => error === failure)
  assert.equal(h.queued[1].signal.aborted, true)
  h.host.workingDirectory.get = () => { throw new Error('unavailable') }
  assert.equal(await h.ask(request, async () => 'answer unchanged'), 'answer unchanged')
  assert.equal(h.warnings.length, 1)
})

test('only a completed turn with a final visible response speaks, once', () => {
  const h = fakeHost()
  h.start(1)
  h.message(1, 1, [text('我正在查看设置。'), { type: 'tool-call' }])
  h.publish('step/start', { turn: 1, step: 2 })
  h.message(1, 2, [{ type: 'reasoning', text: '推理不朗读' }, text('测试通过。')])
  assert.equal(h.queued.length, 0)
  h.end(1)
  h.end(1)
  assert.equal(h.queued.length, 1)
  assert.match(h.queued[0].text, /测试通过/)
  assert.doesNotMatch(h.queued[0].text, /推理|正在查看/)
})

test('only summary-mode completed replies carry text and the recorded model route for synthesis', async () => {
  for (const mode of ['notice', 'brief', 'summary']) {
    const h = fakeHost({ mode })
    h.session.requestHeader = () => ({ config: { provider: 'configured', model: 'selected', reasoningEffort: 'max' } })
    await h.ask({ questions }, async () => 'unchanged')
    assert.equal(h.queued[0].summary, undefined)
    assert.equal(h.queued[0].text, questionSpeech(questions, mode === 'summary' ? 'brief' : mode))
    h.start(1); h.message(1, 1, [text('尚未验证音频输出。')]); h.end(1)
    assert.equal(h.queued[1].text, finalSpeech('尚未验证音频输出。', mode === 'summary' ? 'brief' : mode))
    assert.deepEqual(h.queued[1].summary, mode === 'summary' ? {
      text: '尚未验证音频输出。', route: { provider: 'configured', model: 'selected' },
    } : undefined)
  }
})

test('replays, tool-only or empty final steps, compacted messages and aborted turns stay silent', () => {
  const h = fakeHost()
  h.publish('turn/start', { turn: 1 }, { seq: 3 })
  h.publish('step/start', { turn: 1, step: 1 })
  h.message(1, 1, [text('历史')])
  h.end(1)
  h.start(2)
  h.message(2, 1, [text('较早的进展。')])
  h.publish('step/start', { turn: 2, step: 2 })
  h.message(2, 2, [text('带调用的工具进展。'), { type: 'tool-call' }])
  h.end(2)
  for (const kind of ['aborted', 'error', 'max-tokens', 'interrupted', 'blocked', 'forked']) {
    h.start(3)
    h.message(3, 1, [text('不是最终输出。')])
    h.end(3, kind)
  }
  h.start(4)
  h.message(4, 1, [text('中断的文本。')], { interrupted: true })
  h.end(4)
  h.start(5)
  h.message(5, 1, [text('重新整理的历史。')], {}, { op: 'replace' })
  h.end(5)
  assert.equal(h.queued.length, 0)
})

test('all-workspaces scope queues fixed notices in separate workspaces and rejects non-directories', async () => {
  assert.equal(isWithinWorkspace('/', '.'), false)
  assert.equal(isWithinWorkspace('/', join(process.cwd(), 'package.json')), false)
  for (const cwd of [process.cwd(), tmpdir()]) {
    const h = fakeHost({ cwd, mode: 'notice', workspaceRoot: '/' })
    await h.ask({ questions }, async () => 'unchanged')
    h.start(1); h.message(1, 1, [text('测试通过。')]); h.end(1)
    assert.deepEqual(h.queued.map(job => [job.kind, job.text]), [
      ['ask', questionSpeech(questions, 'notice')],
      ['final', finalSpeech('测试通过。', 'notice')],
    ])
  }
})

test('working directory, delegated Agent and live identity restrict questions and results', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-phoebe-test-'))
  t.after(() => rm(dir, { recursive: true }))
  const root = join(dir, 'Phoebe')
  const nested = join(root, 'work')
  const sibling = join(dir, 'PhoebeOther')
  await mkdir(nested, { recursive: true }); await mkdir(sibling)
  await symlink(sibling, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(isWithinWorkspace(root, nested), true)
  assert.equal(isWithinWorkspace(root, sibling), false)
  assert.equal(isWithinWorkspace(root, join(root, 'escape')), false)
  for (const h of [fakeHost({ cwd: sibling }), fakeHost({ origin: 'subagent' })]) {
    await h.ask({ questions }, async () => 'unchanged')
    h.start(1); h.message(1, 1, [text('也不能播。')]); h.end(1)
    assert.equal(h.queued.length, 0)
  }
  const h = fakeHost()
  h.start(1); h.message(1, 1, [text('现在允许播。')]); h.end(1)
  assert.equal(h.queued[0].isCurrent(), true)
  h.session.cwd = sibling
  h.publish('working-directory/change', { cwd: sibling })
  assert.equal(h.queued[0].isCurrent(), false)
  assert.equal(h.canceled.at(-1), h.session)
  h.session.cwd = process.cwd()
  h.agents.set('main', { ...h.agent })
  assert.equal(h.queued[0].isCurrent(), false)
})

test('playback serializes jobs, replaces pending entries and preempts final with an ask', async () => {
  const started = deferred()
  const events = []
  const playback = createPlayback(async (job, signal) => {
    events.push(job.text)
    if (job.text === 'active') {
      started.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    }
  }, (error) => assert.fail(error))
  const enqueue = (kind, text) => playback.enqueue({ kind, text, isCurrent: () => true })
  enqueue('final', 'active')
  assert.deepEqual(events, [])
  await started.promise
  enqueue('final', 'obsolete final')
  enqueue('final', 'latest final')
  enqueue('ask', 'obsolete ask')
  enqueue('ask', 'latest ask')
  await playback.settled()
  assert.deepEqual(events, ['active', 'latest ask', 'latest final'])
})

test('stale, canceled, disposed or out-of-scope work never reaches Fish', async () => {
  const events = []
  let now = 0
  const owner = {}
  const abort = new AbortController()
  const playback = createPlayback(async (job) => events.push(job.text), () => {}, () => now)
  playback.enqueue({ kind: 'ask', text: 'canceled', signal: abort.signal, isCurrent: () => true })
  abort.abort()
  playback.enqueue({ kind: 'final', owner, text: 'closed owner', isCurrent: () => true })
  playback.cancelOwner(owner)
  playback.enqueue({ kind: 'ask', text: 'outside', isCurrent: () => false })
  await playback.settled()
  playback.enqueue({ kind: 'final', text: 'expired', isCurrent: () => true })
  now += 30_000
  await playback.settled()
  playback.enqueue({ kind: 'final', text: 'disposed', isCurrent: () => true })
  await playback.dispose()
  assert.deepEqual(events, [])
})

function fakePlayer(onChunk, onKill = () => {}) {
  const child = new EventEmitter()
  child.pid = 123
  child.stdin = new Writable({ write(chunk, _encoding, callback) { onChunk(Buffer.from(chunk)); callback() } })
  child.stdin.on('finish', () => { child.exitCode = 0; child.emit('close', 0) })
  child.kill = (signal) => { child.signalCode = signal; onKill(signal); child.emit('close', null) }
  return child
}

const fishOptions = (signal = new AbortController().signal) => ({
  key: 'not-a-real-secret', player: '/path/to/ffplay', text: '请慢慢看。', model: 's2.1-pro-free', signal,
})
const audioResponse = (body) => new Response(body, { headers: { 'content-type': 'audio/mpeg' } })

test('Fish uses the correct reference and streams to ffplay before HTTP finishes', { timeout: 2_000 }, async () => {
  let producer
  const received = []
  const firstChunk = deferred()
  const started = playFish(fishOptions(), {
    async fetchAudio(url, request) {
      assert.equal(url, 'https://api.fish.audio/v1/tts')
      assert.equal(request.headers.authorization, 'Bearer not-a-real-secret')
      assert.equal(request.headers.model, 's2.1-pro-free')
      assert.equal(request.redirect, 'error')
      assert.deepEqual(JSON.parse(request.body), {
        text: '请慢慢看。', reference_id: PHOEBE_VOICE, format: 'mp3', latency: 'balanced',
      })
      return audioResponse(new ReadableStream({ start(controller) {
        producer = controller
        producer.enqueue(Uint8Array.of(1, 2, 3))
      } }))
    },
    startPlayer(file, args, options) {
      assert.equal(file, '/path/to/ffplay')
      assert.equal(args.at(-1), 'pipe:0')
      assert.equal(options.shell, false)
      assert.equal(options.env.FISH_API_KEY, undefined)
      return fakePlayer((bytes) => { received.push(...bytes); firstChunk.resolve() })
    },
  })
  await firstChunk.promise
  assert.deepEqual(received, [1, 2, 3])
  producer.enqueue(Uint8Array.of(4)); producer.close()
  await started
  assert.deepEqual(received, [1, 2, 3, 4])
})

test('a configured voice ID replaces the Phoebe default in Fish requests', async () => {
  await playFish({ ...fishOptions(), referenceId: 'custom_voice-42' }, {
    fetchAudio: async (_url, { body }) => {
      assert.equal(JSON.parse(body).reference_id, 'custom_voice-42')
      return audioResponse(Uint8Array.of(1))
    },
    startPlayer: () => fakePlayer(() => {}),
  })
})

test('Fish HTTP failure and invalid audio never start the player', async () => {
  for (const [response, code] of [
    [new Response('sensitive provider detail', { status: 401 }), 'http-401'],
    [new Response('sensitive provider detail'), 'invalid-audio'],
  ]) {
    await assert.rejects(playFish(fishOptions(), {
      fetchAudio: async () => response,
      startPlayer: () => assert.fail('not audio'),
    }), (error) => error.code === code && error.message === code)
  }
})

test('canceling playback stops ffplay and aborts a live audio connection', { timeout: 2_000 }, async () => {
  const first = deferred()
  const abort = new AbortController()
  let killSignal
  const work = playFish(fishOptions(abort.signal), {
    async fetchAudio(_url, { signal }) {
      return audioResponse(new ReadableStream({ start(controller) {
        controller.enqueue(Uint8Array.of(1, 2))
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      } }))
    },
    startPlayer() { return fakePlayer(() => first.resolve(), (signal) => { killSignal = signal }) },
  })
  await first.promise
  abort.abort()
  await assert.rejects(work)
  assert.equal(killSignal, 'SIGKILL')
})

test('oversize audio fails closed', { timeout: 2_000 }, async () => {
  let killed = false
  await assert.rejects(playFish(fishOptions(), {
    fetchAudio: async () => audioResponse(new Uint8Array(1_000_001)),
    startPlayer: () => fakePlayer(() => assert.fail('oversize'), () => { killed = true }),
  }), { code: 'audio-limit' })
  assert.equal(killed, true)
})
