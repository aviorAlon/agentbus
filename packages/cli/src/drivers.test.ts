import { describe, expect, it } from 'vitest'
import { isThisBus, standbyEntry } from './drivers.js'
import type { StandbyFile } from './join.js'

describe('standby registrations', () => {
  it('a join-time bus URL is "this bus" by port and a local name', () => {
    const local = { port: 7777, hosts: ['10.0.0.5'] }
    expect(isThisBus(undefined, local)).toBe(true)
    expect(isThisBus('ws://127.0.0.1:7777/ws', local)).toBe(true)
    expect(isThisBus('ws://localhost:7777/ws', local)).toBe(true)
    expect(isThisBus('ws://10.0.0.5:7777/ws', local)).toBe(true)
    expect(isThisBus('ws://127.0.0.1:7778/ws', local)).toBe(false)
    expect(isThisBus('ws://10.0.0.9:7777/ws', local)).toBe(false)
    expect(isThisBus('not a url', local)).toBe(false)
  })

  it('turns a .standby file into a drivers.yaml entry with the backend from the host', () => {
    const base: StandbyFile = {
      host: 'claude',
      backend: 'claude-code',
      cwd: '/work/pipa',
      autonomy: 'full',
      bus: 'ws://127.0.0.1:7777/ws',
      joined_at: 1,
    }
    expect(standbyEntry('pipa', base)).toMatchObject({
      name: 'pipa',
      backend: 'claude-code',
      cwd: '/work/pipa',
      autonomy: 'full',
      standby: true,
    })
    expect(standbyEntry('tita', { ...base, host: 'codex', backend: 'weird' }).backend).toBe('codex')
    const custom = standbyEntry('fake', {
      ...base,
      backend: 'acp',
      acp: { command: 'node', args: ['fake.js'], env: { FAKE_AGENT_MODE: 'echo' } },
      batch_window_ms: 100,
    })
    expect(custom.acp).toEqual({
      command: 'node',
      args: ['fake.js'],
      env: { FAKE_AGENT_MODE: 'echo' },
    })
    expect(custom.batch_window_ms).toBe(100)
  })
})
