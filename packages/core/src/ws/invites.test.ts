import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken, hashToken } from '../auth/token.js'
import { Bus } from '../bus/bus.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { WsServer } from './server.js'

/** Invites: a human issues a one-time code, another machine redeems it for a token. */
describe('invites', () => {
  let server: WsServer
  let base: string
  let store: Store
  let now = 1_000_000
  let ownerToken: string

  beforeEach(async () => {
    now = 1_000_000
    store = new Store(':memory:', { clock: () => now })
    ownerToken = generateToken()
    store.createAgent({ name: 'owner', token_hash: hashToken(ownerToken), authority: 'human' })
    const bus = new Bus(store, loadConfig({}), () => now)
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 1000 })
    const { port } = await server.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await server.close()
  })

  // built per call: ownerToken is minted in beforeEach
  const human = () => ({
    authorization: `Bearer ${ownerToken}`,
    'x-agentbus-name': 'owner',
    'content-type': 'application/json',
  })
  const issue = (body: Record<string, unknown> = {}) =>
    fetch(`${base}/api/console/invites`, {
      method: 'POST',
      headers: human(),
      body: JSON.stringify(body),
    })
  const redeem = (body: Record<string, unknown>) =>
    fetch(`${base}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('only humans issue; anyone with the code redeems once; the joiner picks the name', async () => {
    expect(
      (
        await fetch(`${base}/api/console/invites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401)
    const inv = (await (await issue()).json()) as { code: string; name: null; expires_at: number }
    expect(inv.code.startsWith('inv_')).toBe(true)
    expect(inv.name).toBeNull()
    expect(inv.expires_at).toBe(now + 24 * 3_600_000)
    expect(
      (
        (await (await fetch(`${base}/api/console/invites`, { headers: human() })).json()) as {
          invites: unknown[]
        }
      ).invites,
    ).toHaveLength(1)

    expect((await redeem({ code: inv.code })).status).toBe(400) // unbound: a name is required
    const ok = (await (
      await redeem({ code: inv.code, name: 'laptop-fe', backend: 'claude-code' })
    ).json()) as { name: string; token: string; authority: string; created: boolean }
    expect(ok).toMatchObject({ name: 'laptop-fe', authority: 'relayer', created: true })
    expect(ok.token.startsWith('ab_')).toBe(true)
    expect(store.getAgent('laptop-fe')).toMatchObject({
      authority: 'relayer',
      backend: 'claude-code',
    })
    // single use
    expect((await redeem({ code: inv.code, name: 'again' })).status).toBe(401)
    expect((await redeem({ code: 'inv_nope', name: 'x' })).status).toBe(401)
  })

  it('a name-bound invite rotates an existing agent; an unbound one cannot steal a name; expiry is enforced', async () => {
    store.createAgent({ name: 'backend', token_hash: hashToken('old'), authority: 'bot' })
    const bound = (await (await issue({ name: 'backend', authority: 'bot' })).json()) as {
      code: string
    }
    const r = (await (await redeem({ code: bound.code })).json()) as {
      name: string
      created: boolean
    }
    expect(r).toMatchObject({ name: 'backend', created: false })
    const unbound = (await (await issue()).json()) as { code: string }
    expect((await redeem({ code: unbound.code, name: 'backend' })).status).toBe(400)
    expect((await redeem({ code: unbound.code, name: 'owner' })).status).toBe(400) // human
    // a rejected redeem does not burn the code
    expect((await redeem({ code: unbound.code, name: 'fresh' })).status).toBe(200)
    expect((await redeem({ code: unbound.code, name: 'fresh2' })).status).toBe(401)
    const short = (await (await issue({ ttl_hours: 1 })).json()) as { code: string }
    now += 2 * 3_600_000
    expect((await redeem({ code: short.code, name: 'late' })).status).toBe(401)
  })
})
