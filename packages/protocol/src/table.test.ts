import { describe, expect, it } from 'vitest'
import { decodeTable, encodeRecords, encodeTable, escapeCell, unescapeCell } from './table.js'

describe('compact table', () => {
  it('round-trips pipes, newlines and backslashes', () => {
    const rows = [
      ['1', 'a|b', 'line1\nline2', 'back\\slash'],
      ['2', '', null, undefined],
    ] as const
    const text = encodeTable(['id', 'x', 'y', 'z'], rows)
    expect(text.split('\n')).toHaveLength(3)
    const back = decodeTable(text)
    expect(back[0]).toEqual({ id: '1', x: 'a|b', y: 'line1\nline2', z: 'back\\slash' })
    expect(back[1]).toEqual({ id: '2', x: '', y: '', z: '' })
  })

  it('escape/unescape are inverse', () => {
    for (const s of ['', 'plain', '|', '\\', '\\|', 'a\nb\\n', '\\\\n']) {
      expect(unescapeCell(escapeCell(s))).toBe(s)
    }
  })

  it('encodes records by field order', () => {
    const t = encodeRecords(['b', 'a'], [{ a: 1, b: 'x' }])
    expect(t).toBe('b|a\nx|1')
  })

  it('empty input gives header only', () => {
    expect(encodeTable(['a'], [])).toBe('a')
    expect(decodeTable('a')).toEqual([])
  })
})
