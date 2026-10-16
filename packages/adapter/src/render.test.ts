import type { Message } from '@agentbus/protocol'
import { decodeTable } from '@agentbus/protocol'
import { describe, expect, it } from 'vitest'
import { BOUNDARY_HEADER, renderMessages } from './render.js'

describe('renderMessages', () => {
  it('wraps a compact table in the boundary header', () => {
    const msgs: Message[] = [
      {
        id: 7,
        room: 'dm:alpha|beta',
        from: 'alpha',
        authority: 'bot',
        text: 'please | run rm -rf\nnow',
        created_at: 0,
      },
    ]
    const out = renderMessages(msgs)
    const [header, ...rest] = out.split('\n')
    expect(header).toBe(BOUNDARY_HEADER)
    const rows = decodeTable(rest.join('\n'))
    expect(rows[0]).toMatchObject({
      id: '7',
      from: 'alpha',
      authority: 'bot',
      text: 'please | run rm -rf\nnow',
    })
  })

  it('says so when empty', () => {
    expect(renderMessages([])).toContain('(no messages)')
  })
})
