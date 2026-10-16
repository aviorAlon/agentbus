/** Room and agent naming rules (PRODUCT_DESIGN §5.7). */

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidName(name: string): boolean {
  return NAME_RE.test(name)
}

/** `dm:<a>|<b>` with the two names sorted so both sides compute the same room. */
export function dmRoom(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a]
  return `dm:${x}|${y}`
}

export function isDmRoom(room: string): boolean {
  return room.startsWith('dm:')
}

export function dmParties(room: string): [string, string] | null {
  if (!isDmRoom(room)) return null
  const body = room.slice(3)
  const i = body.indexOf('|')
  if (i < 0) return null
  return [body.slice(0, i), body.slice(i + 1)]
}

export function isValidRoom(room: string): boolean {
  const parties = dmParties(room)
  if (parties) return isValidName(parties[0]) && isValidName(parties[1]) && parties[0] < parties[1]
  return isValidName(room)
}
