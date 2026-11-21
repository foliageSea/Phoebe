const WALLET_URL = 'https://api.fish.audio/wallet/self/api-credit'
const CACHE_MS = 15_000

// Return only the paid balance; never relay upstream error bodies.
export function createBalanceLookup(resolveKey, { fetchWallet = fetch, now = Date.now } = {}) {
  let current
  return async function lookupBalance() {
    let key
    try {
      key = (await resolveKey())?.trim()
    } catch {
      current = undefined
      return { status: 'not-ready' }
    }
    if (!key) {
      current = undefined
      return { status: 'missing-key' }
    }
    if (current?.key === key && (current.pending || current.expiresAt > now())) return current.result

    const entry = { key, pending: true, expiresAt: 0 }
    current = entry
    entry.result = (async () => {
      try {
        const response = await fetchWallet(WALLET_URL, {
          headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          return { status: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable' }
        }
        const data = await response.json()
        if (typeof data?.credit !== 'string' || !/^-?\d{1,24}(?:\.\d{1,24})?$/.test(data.credit)) {
          return { status: 'unavailable' }
        }
        return { status: 'ok', credit: data.credit }
      } catch {
        return { status: 'unavailable' }
      } finally {
        entry.pending = false
        entry.expiresAt = now() + CACHE_MS
      }
    })()
    return entry.result
  }
}

export function registerBalanceRoute(ctx) {
  const lookup = createBalanceLookup(async () => (await ctx.credentials.resolve('FISH_API_KEY'))?.value)
  // Connection's exact Fetch routes enforce browser/API authentication and reject non-owner Peers.
  ctx.connection.fetch.register({
    path: '/api/phoebe-voice.balance',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json(await lookup(), { headers: { 'cache-control': 'no-store' } }),
  })
}
