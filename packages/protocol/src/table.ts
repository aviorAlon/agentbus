/**
 * Compact pipe-delimited table (PRODUCT_DESIGN §4.3 step 1, F-A10).
 * One header line, one row per record. Pipe, newline and backslash are escaped.
 * Token-cheap alternative to JSON for lists of same-shaped records.
 */

export type Cell = string | number | boolean | null | undefined

export function escapeCell(v: Cell): string {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n')
}

export function unescapeCell(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      out += n === 'n' ? '\n' : n
      i++
    } else out += c
  }
  return out
}

export function encodeTable(fields: readonly string[], rows: Iterable<readonly Cell[]>): string {
  const lines = [fields.join('|')]
  for (const r of rows) lines.push(r.map(escapeCell).join('|'))
  return lines.join('\n')
}

/** Split one encoded line on unescaped pipes. */
function splitLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[i + 1]
      i++
    } else if (c === '|') {
      cells.push(cur)
      cur = ''
    } else cur += c
  }
  cells.push(cur)
  return cells
}

export function decodeTable(text: string): Record<string, string>[] {
  const lines = text.split('\n')
  const header = lines[0]
  if (!header) return []
  const fields = header.split('|')
  const out: Record<string, string>[] = []
  for (const line of lines.slice(1)) {
    if (line === '') continue
    const cells = splitLine(line)
    const rec: Record<string, string> = {}
    fields.forEach((f, i) => {
      rec[f] = unescapeCell(cells[i] ?? '')
    })
    out.push(rec)
  }
  return out
}

/** Encode an array of objects using the given field order. */
export function encodeRecords<T extends Record<string, Cell>>(
  fields: readonly (keyof T & string)[],
  records: Iterable<T>,
): string {
  const rows: Cell[][] = []
  for (const r of records) rows.push(fields.map((f) => r[f]))
  return encodeTable(fields, rows)
}
