import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { BusError } from '../bus/errors.js'
import type { Store } from '../store/store.js'

export interface BlobStoreOptions {
  maxBytes: number
  quotaBytes: number
}

/**
 * Content-addressed blob store (PRODUCT_DESIGN §2.5, F-B1–F-B3).
 * `id = sha256(content)`, path `<dir>/<sha[:2]>/<sha>`, one copy per content.
 * Per-blob cap and total quota are enforced while streaming, before anything is kept.
 */
export class BlobStore {
  constructor(
    readonly dir: string,
    private readonly store: Store,
    private readonly opts: BlobStoreOptions,
  ) {
    mkdirSync(join(dir, 'tmp'), { recursive: true })
  }

  path(id: string): string {
    return join(this.dir, id.slice(0, 2), id)
  }

  has(id: string): boolean {
    return existsSync(this.path(id))
  }

  /** Stream a body in, hashing as it goes. Rejects over-size / over-quota uploads. */
  async put(
    body: Readable,
    mime?: string,
  ): Promise<{ id: string; size: number; existed: boolean }> {
    const tmp = join(this.dir, 'tmp', randomBytes(8).toString('hex'))
    const hash = createHash('sha256')
    let size = 0
    const used = this.store.totalBlobBytes()
    const out = createWriteStream(tmp)
    try {
      await new Promise<void>((resolve, reject) => {
        // Over-limit uploads are drained (not destroyed) so the client still gets a 413
        // instead of a reset socket; the bytes are discarded.
        let rejected: BusError | null = null
        body.on('data', (chunk: Buffer) => {
          if (rejected) return
          size += chunk.length
          if (size > this.opts.maxBytes)
            rejected = new BusError('too_large', `blob exceeds ${this.opts.maxBytes} bytes`)
          else if (used + size > this.opts.quotaBytes)
            rejected = new BusError('too_large', 'blob quota exhausted')
          if (rejected) return
          hash.update(chunk)
          out.write(chunk)
        })
        body.on('end', () => {
          if (rejected) reject(rejected)
          else out.end(resolve)
        })
        body.on('error', reject)
        out.on('error', reject)
      })
      const id = hash.digest('hex')
      const dest = this.path(id)
      mkdirSync(join(this.dir, id.slice(0, 2)), { recursive: true })
      const existed = existsSync(dest)
      if (existed) await unlink(tmp)
      else await rename(tmp, dest)
      this.store.registerBlob(id, size, mime)
      return { id, size, existed }
    } catch (e) {
      out.destroy()
      await unlink(tmp).catch(() => undefined)
      throw e
    }
  }

  open(id: string): { stream: Readable; size: number } {
    const p = this.path(id)
    if (!existsSync(p)) throw new BusError('bad_request', `unknown blob ${id.slice(0, 12)}`)
    return { stream: createReadStream(p), size: statSync(p).size }
  }
}
