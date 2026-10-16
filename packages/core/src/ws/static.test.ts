import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../bus/bus.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { WsServer } from './server.js'

describe('console static files', () => {
  let server: WsServer
  let base: string
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentbus-static-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>console</title>')
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    const bus = new Bus(new Store(':memory:'), loadConfig({}))
    // trailing separator on purpose: that is what fileURLToPath(new URL('.../dist/')) yields
    server = new WsServer(bus, {
      bind: '127.0.0.1',
      port: 0,
      tickMs: 1000,
      staticDir: `${dir}${process.platform === 'win32' ? '\\' : '/'}`,
    })
    const { port } = await server.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves index, assets, SPA fallback and redirects /', async () => {
    expect(await (await fetch(`${base}/console/`)).text()).toContain('<title>console</title>')
    expect(await (await fetch(`${base}/console`)).text()).toContain('<title>console</title>')
    const js = await fetch(`${base}/console/assets/app.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript')
    expect(await js.text()).toBe('console.log(1)')
    // unknown path → SPA index
    expect(await (await fetch(`${base}/console/tasks/t_1`)).text()).toContain(
      '<title>console</title>',
    )
    // traversal stays inside the directory
    const esc = await fetch(`${base}/console/..%2F..%2Fpackage.json`)
    expect(await esc.text()).toContain('<title>console</title>')
    const root = await fetch(`${base}/`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/console/')
  })
})
