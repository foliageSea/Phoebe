import { bundledPreset } from './bundled-presets.js'
import { createPresets as createStore } from './presets.js'
import { NOTICES } from './speech.js'

const FREE = 's2.1-pro-free'
const PAID = 's2.1-pro'

// Paid synthesis is opt-in for the three presets, independently of the excerpt model.
export function createPresets(options) {
  const stores = new Map([FREE, PAID].map(model => [model, createStore({ ...options, model })]))
  const preferred = () => (options.getModel?.() ?? options.model) === PAID ? PAID : FREE
  const orderedStores = () => {
    const model = preferred()
    return [stores.get(model), stores.get(model === PAID ? FREE : PAID)]
  }
  const check = async (voice) => {
    const [first, second] = orderedStores()
    const bundled = await Promise.all(Object.values(NOTICES).map(text => bundledPreset(text, voice)))
    if (bundled.every(Boolean)) return { status: 'ready' }
    const result = await first.status(voice)
    return result.status === 'ready' ? result
      : (await second.status(voice)).status === 'ready' ? { status: 'ready' } : result
  }
  return {
    async find(text) {
      const voice = options.getVoice()
      const [first, second] = orderedStores()
      return await bundledPreset(text, voice) ?? await first.find(text, voice) ?? await second.find(text, voice)
    },
    async status() { return check(options.getVoice()) },
    async prepare(model) {
      const voice = options.getVoice()
      // Don't spend more quota when an intact set already exists in either model.
      const status = await check(voice)
      if (status.status === 'ready') return status
      return stores.get(model).prepare(voice)
    },
  }
}

export function registerPresetRoute(ctx, presets) {
  let pending
  ctx.connection.fetch.register({
    path: '/api/phoebe-voice.presets',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
      if (request.method === 'GET') return json(await presets.status())
      // A non-CORS-safelisted header also prevents a cross-site form from triggering synthesis.
      const model = request.headers.get('x-phoebe-preset-model')
      if (model !== FREE && model !== PAID) return json({ status: 'invalid-model' }, 400)
      if (pending) return json({ status: 'preparing' }, 409)
      try {
        pending = presets.prepare(model)
        return json(await pending)
      } finally {
        pending = undefined
      }
    },
  })
}
