import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken, hashToken } from '../auth/token.js'
import { BlobStore } from '../blobs/blob-store.js'
import { Bus } from '../bus/bus.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { WsServer } from './server.js'

describe('HTTP participants + blobs', () => {
  let server: WsServer
  let base: string
  let store: Store
  let dir: string
  const tokens: Record<string, string> = {}

  beforeEach(async () => {
    store = new Store(':memory:')
    for (const name of ['alpha', 'beta']) {
      tokens[name] = generateToken()
      store.createAgent({ name, token_hash: hashToken(tokens[name] as string) })
    }
    dir = mkdtempSync(join(tmpdir(), 'agentbus-blobs-'))
    const bus = new Bus(store, loadConfig({ guard: { min_interval_ms: 0 } }))
    const blobs = new BlobStore(dir, store, { maxBytes: 1000, quotaBytes: 2500 })
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 1000, blobs })
    const { port } = await server.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const headers = (name: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[name]}`,
    'x-agentbus-name': name,
    ...extra,
  })

  it('rejects missing or wrong credentials', async () => {
    expect((await fetch(`${base}/api/participants/inbox`)).status).toBe(401)
    const r = await fetch(`${base}/api/participants/inbox`, {
      headers: { authorization: 'Bearer nope', 'x-agentbus-name': 'alpha' },
    })
    expect(r.status).toBe(401)
  })

  it('send / receive / ack over HTTP without a WS connection', async () => {
    const sent = await fetch(`${base}/api/participants/send`, {
      method: 'POST',
      headers: headers('alpha', { 'content-type': 'application/json' }),
      body: JSON.stringify({ to: 'beta', text: 'over http' }),
    })
    expect(sent.status).toBe(200)
    const sentBody = (await sent.json()) as {
      message: { id: number }
      deliveries: { via: string }[]
    }
    expect(sentBody.deliveries[0]?.via).toBe('mailbox')

    const recv = (await (
      await fetch(`${base}/api/participants/receive?timeout_s=5`, { headers: headers('beta') })
    ).json()) as { messages: { text: string; id: number }[]; timed_out: boolean }
    expect(recv.timed_out).toBe(false)
    expect(recv.messages.map((m) => m.text)).toEqual(['over http'])
    expect(store.getDelivery(sentBody.message.id, 'beta')?.state).toBe('seen')

    const ack = await fetch(`${base}/api/participants/ack`, {
      method: 'POST',
      headers: headers('beta', { 'content-type': 'application/json' }),
      body: JSON.stringify({ message_ids: [sentBody.message.id] }),
    })
    expect(((await ack.json()) as { deliveries: { state: string }[] }).deliveries[0]?.state).toBe(
      'handled',
    )

    // long-poll times out cleanly when nothing arrives
    const empty = (await (
      await fetch(`${base}/api/participants/receive?timeout_s=0.3`, { headers: headers('beta') })
    ).json()) as { messages: unknown[]; timed_out: boolean }
    expect(empty).toEqual({ messages: [], timed_out: true })

    // bad body → 400 with a code
    const bad = await fetch(`${base}/api/participants/send`, {
      method: 'POST',
      headers: headers('alpha', { 'content-type': 'application/json' }),
      body: JSON.stringify({ text: 'no target' }),
    })
    expect(bad.status).toBe(400)
  })

  it('the console can open a dm by room name: first message creates it; outsiders cannot', async () => {
    const owner = generateToken()
    store.createAgent({ name: 'owner', token_hash: hashToken(owner), authority: 'human' })
    const human = { authorization: `Bearer ${owner}`, 'x-agentbus-name': 'owner' }
    const send = (room: string, text: string) =>
      fetch(`${base}/api/console/rooms/${encodeURIComponent(room)}/send`, {
        method: 'POST',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
    expect(store.getRoom('dm:alpha|owner')).toBeNull()
    expect((await send('dm:alpha|owner', 'hi')).status).toBe(200)
    expect(store.members('dm:alpha|owner').sort()).toEqual(['alpha', 'owner'])
    // a dm between two others is not the human's to open; a named room must still exist
    expect((await send('dm:alpha|beta', 'x')).status).toBe(400)
    expect((await send('dm:nobody|owner', 'x')).status).toBe(404)
    expect((await send('design', 'x')).status).toBe(404)
  })

  it('blobs are content addressed, capped and referenced from messages', async () => {
    const body = Buffer.from('hello blob world')
    const put = await fetch(`${base}/api/blobs?name=hello.txt`, {
      method: 'PUT',
      headers: headers('alpha', { 'content-type': 'text/plain' }),
      body,
    })
    expect(put.status).toBe(200)
    const b1 = (await put.json()) as { id: string; size: number; existed: boolean }
    expect(b1.size).toBe(body.length)
    expect(b1.existed).toBe(false)
    // same content again: deduplicated
    const again = (await (
      await fetch(`${base}/api/blobs`, { method: 'PUT', headers: headers('beta'), body })
    ).json()) as { id: string; existed: boolean }
    expect(again.id).toBe(b1.id)
    expect(again.existed).toBe(true)
    expect(store.totalBlobBytes()).toBe(body.length)

    // over per-blob cap → 413
    const big = await fetch(`${base}/api/blobs`, {
      method: 'PUT',
      headers: headers('alpha'),
      body: Buffer.alloc(1001, 1),
    })
    expect(big.status).toBe(413)

    // reference from a message, then fetch it back
    const sent = await fetch(`${base}/api/participants/send`, {
      method: 'POST',
      headers: headers('alpha', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        to: 'beta',
        text: 'file for you',
        blobs: [{ id: b1.id, name: 'hello.txt' }],
      }),
    })
    const msg = (await sent.json()) as {
      message: { blobs: { id: string; name: string; mime?: string }[] }
    }
    expect(msg.message.blobs).toEqual([
      { id: b1.id, name: 'hello.txt', size: body.length, mime: 'text/plain' },
    ])
    expect(store.getBlob(b1.id)?.refcount).toBe(1)
    expect(store.blobsInRoom('dm:alpha|beta')[0]).toMatchObject({
      name: 'hello.txt',
      from: 'alpha',
    })

    const get = await fetch(`${base}/api/blobs/${b1.id}`, { headers: headers('beta') })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('text/plain')
    expect(Buffer.from(await get.arrayBuffer()).toString()).toBe('hello blob world')

    // unknown blob reference is refused
    const bad = await fetch(`${base}/api/participants/send`, {
      method: 'POST',
      headers: headers('alpha', { 'content-type': 'application/json' }),
      body: JSON.stringify({ to: 'beta', text: 'x', blobs: [{ id: 'f'.repeat(64), name: 'x' }] }),
    })
    expect(bad.status).toBe(400)
  })
})
