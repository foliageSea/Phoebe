import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSummary } from '../host/summary.js'

const signal = () => new AbortController().signal
const route = { provider: 'configured', model: 'selected' }
const input = { route, text: '已发布新版本。\n密钥不应发送。\n尚未验证实机音频。' }
const script = '漂泊者，新版已经发布啦。实机播报还要再确认。'

function model(chunks, inspect = () => {}) {
  return { async prepareCall(config, signal, configure) {
    const controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'low' }] } })
    return { config: { ...config, ...controls }, async *stream(options) {
      inspect(options)
      assert.equal(options.signal, signal)
      yield* chunks
    } }
  } }
}

const done = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const delta = text => ({ type: 'text-delta', index: 1, text })

test('single text-only model call uses filtered final text and the Phoebe persona', async () => {
  let calls = 0
  const llm = model([
    { type: 'reasoning-delta', index: 0, text: '不应朗读推理' }, delta(script),
    { type: 'block-end', index: 1, block: { type: 'text', text: script } }, done(),
  ], options => {
    calls++
    assert.equal(options.provider, route.provider)
    assert.equal(options.model, route.model)
    assert.equal(options.reasoningEffort, 'low')
    assert.equal(options.tools, undefined)
    assert.match(options.system, /温柔、有礼貌.*漂泊者/u)
    assert.match(options.system, /保留失败、限制和不确定性/u)
    assert.equal(options.messages.length, 1)
    assert.equal(JSON.parse(options.messages[0].content[0].text), '已发布新版本。\n尚未验证实机音频。')
  })
  assert.equal(await createSummary(llm, input, signal()), script)
  assert.equal(calls, 1)
})

test('unavailable model, filtered-out input, and unusable output signal excerpt fallback', async () => {
  assert.equal(await createSummary(undefined, input, signal()), undefined)
  const never = { prepareCall: () => assert.fail('no useful input') }
  assert.equal(await createSummary(never, { route, text: '密钥不应发送。' }, signal()), undefined)
  for (const chunks of [[], [delta(script)], [delta(script), done('max-tokens')],
    [delta('验证码是下列数字。'), done()], [delta('请访问 https://example.test 查看详情。'), done()],
    [delta('字'.repeat(121)), done()], [delta('完成了。也测试了。仍需确认。'), done()],
    [{ type: 'tool-call-delta' }, done()]]) {
    assert.equal(await createSummary(model(chunks), input, signal()), undefined)
  }
  assert.equal(await createSummary({ prepareCall() { throw Error('private upstream details') } }, input, signal()), undefined)
})

test('timeout releases the queue even if prepareCall ignores abort; parent cancellation prevents dispatch', async () => {
  let providerSignal
  const stalled = { prepareCall(_config, signal) { providerSignal = signal; return new Promise(() => {}) } }
  assert.equal(await createSummary(stalled, input, signal(), 10), undefined)
  assert.equal(providerSignal.aborted, true)
  const parent = new AbortController()
  const pending = createSummary(stalled, input, parent.signal)
  parent.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(createSummary({ prepareCall: () => assert.fail('already canceled') }, input, parent.signal), { name: 'AbortError' })
})
