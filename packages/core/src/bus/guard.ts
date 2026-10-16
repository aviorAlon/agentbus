import type { Authority } from '@agentbus/protocol'

/**
 * Exchange guard (PRODUCT_DESIGN §4.4, F-R2/F-R3). Semantics inherited from
 * claude-message-bus: count bot messages in a room since the last human message;
 * at `cap` the room pauses; a human message zeroes the counter and lifts the pause.
 * Per-agent minimum send interval is a separate rate limit that does not count.
 *
 * Counters are in memory; the durable pause flag lives in `rooms.paused` and is
 * reconciled by the caller through the verdict.
 */

export type GuardVerdict =
  | { kind: 'allow'; count: number; clearedPause: boolean; reachedCap: boolean }
  | { kind: 'paused'; count: number }
  | { kind: 'rate_limited'; retryInMs: number }

interface RoomState {
  exchanges: number
  lastSend: Map<string, number>
}

export class Guard {
  private rooms = new Map<string, RoomState>()

  constructor(
    readonly cap: number,
    readonly minIntervalMs: number,
  ) {}

  /** Call exactly once per message actually sent; a rejection mutates nothing. */
  check(
    room: string,
    agent: string,
    authority: Authority,
    now: number,
    opts: { exempt?: boolean; pausedInStore?: boolean } = {},
  ): GuardVerdict {
    let st = this.rooms.get(room)
    if (!st) {
      // Rehydrate a durable pause after restart: counter unknown, treat as at cap.
      st = { exchanges: opts.pausedInStore ? this.cap : 0, lastSend: new Map() }
      this.rooms.set(room, st)
    }

    if (authority === 'human' || authority === 'relayer') {
      // Humans (and relayers, who carry human authority) are what the guard waits for.
      const clearedPause = st.exchanges >= this.cap
      st.exchanges = 0
      st.lastSend.set(agent, now)
      return { kind: 'allow', count: 0, clearedPause, reachedCap: false }
    }

    if (st.exchanges >= this.cap) return { kind: 'paused', count: st.exchanges }

    const last = st.lastSend.get(agent)
    if (this.minIntervalMs > 0 && last !== undefined) {
      const elapsed = now - last
      if (elapsed < this.minIntervalMs)
        return { kind: 'rate_limited', retryInMs: this.minIntervalMs - elapsed }
    }

    if (!opts.exempt) st.exchanges += 1
    st.lastSend.set(agent, now)
    return {
      kind: 'allow',
      count: st.exchanges,
      clearedPause: false,
      reachedCap: st.exchanges >= this.cap,
    }
  }

  /** Operator action: put the room at the cap so bots are refused until a human speaks or resets. */
  forcePause(room: string): void {
    const st = this.rooms.get(room) ?? { exchanges: 0, lastSend: new Map<string, number>() }
    st.exchanges = this.cap
    this.rooms.set(room, st)
  }

  /** Operator action: clear the counter (and therefore the pause). Returns true if it was paused. */
  reset(room: string): boolean {
    const st = this.rooms.get(room)
    if (!st) return false
    const was = st.exchanges >= this.cap
    st.exchanges = 0
    return was
  }

  count(room: string): number {
    return this.rooms.get(room)?.exchanges ?? 0
  }
}
