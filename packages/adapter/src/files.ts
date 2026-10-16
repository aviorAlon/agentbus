import { mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** `ws://host:port/ws` → `http://host:port` (the bus serves both on one port). */
export function httpBaseFromBus(busUrl: string): string {
  const u = new URL(busUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = ''
  u.search = ''
  return u.toString().replace(/\/$/, '')
}

export interface BlobHttp {
  base: string
  name: string
  token: string
}

const headers = (h: BlobHttp, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${h.token}`,
  'x-agentbus-name': h.name,
  ...extra,
})

/** Upload a local file; returns its content id (sha256). */
export async function putFile(
  h: BlobHttp,
  path: string,
): Promise<{ id: string; name: string; size: number }> {
  const abs = resolve(path)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`${path} is not a file`)
  const res = await fetch(`${h.base}/api/blobs?name=${encodeURIComponent(basename(abs))}`, {
    method: 'PUT',
    headers: headers(h, { 'content-type': 'application/octet-stream' }),
    // Buffered upload; blobs are capped (100MB default) so this stays simple.
    body: await readFile(abs),
  })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { id: string; size: number }
  return { id: body.id, name: basename(abs), size: body.size }
}

/**
 * Download a blob into the agent's inbox folder. The bus decides the location
 * (PRODUCT_DESIGN F-B4): `<cwd>/.agentbus/inbox/<sha12>/<name>`; the agent cannot pick a path.
 */
export async function getFile(
  h: BlobHttp,
  cwd: string,
  id: string,
  name?: string,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('blob id must be a 64-hex sha256')
  const res = await fetch(`${h.base}/api/blobs/${id}`, { headers: headers(h) })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${await res.text()}`)
  const safeName = (name ? basename(name) : id).replace(/[\\/:*?"<>|]/g, '_') || id
  const dir = join(cwd, '.agentbus', 'inbox', id.slice(0, 12))
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, safeName)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}
