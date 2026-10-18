/** Minimal typed client for the console endpoints (read-only). */

export type Authority = 'bot' | 'relayer' | 'human'
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface AgentInfo {
  name: string
  backend: string | null
  authority: Authority
  online: boolean
  state: 'working' | 'idle' | 'blocked' | 'unknown'
  capabilities: { driver?: { kind: string }; inbox: boolean; push: boolean }
  cwd: string | null
  last_seen: number | null
  /** A hosted session is on standby for this directory. */
  standby?: boolean
}
export interface BlobRef {
  id: string
  name: string
  size: number
  mime?: string
}
export interface Message {
  id: number
  room: string
  from: string
  authority: Authority
  text: string
  payload?: unknown
  task_id?: string
  blobs?: BlobRef[]
  created_at: number
}
export interface Delivery {
  message_id: number
  recipient: string
  state: 'written' | 'seen' | 'handled'
  via: string
  written_at: number
  seen_at: number | null
  handled_at: number | null
}
export interface Task {
  id: string
  room: string
  from: string
  to: string
  state: TaskState
  description: string
  context?: string
  deadline: number | null
  max_turns: number | null
  turns_used: number
  summary: string | null
  artifacts: BlobRef[]
  escalated: boolean
  created_at: number
  updated_at: number
}
export interface RoomInfo {
  name: string
  kind: 'dm' | 'room'
  paused: boolean
  members: string[]
  last: Message | null
}
export interface Turn {
  id: number
  agent: string
  session_id: string | null
  message_ids: number[]
  started_at: number
  ended_at: number | null
  tokens: number | null
  sent: boolean
  exit_reason: string | null
  recovered: boolean
}
export interface Snapshot {
  now: number
  agents: AgentInfo[]
  rooms: RoomInfo[]
  tasks: Task[]
  turns: Turn[]
  events: {
    id: number
    kind: string
    agent: string | null
    room: string | null
    detail: Record<string, unknown>
    at: number
  }[]
}

export interface Creds {
  name: string
  token: string
}

const headers = (c: Creds) => ({ authorization: `Bearer ${c.token}`, 'x-agentbus-name': c.name })

async function get<T>(c: Creds, path: string): Promise<T> {
  const r = await fetch(path, { headers: headers(c) })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()) as T
}

async function post<T>(c: Creds, path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { ...headers(c), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()) as T
}

export interface JoinResult {
  name: string
  dir: string
  host: 'claude' | 'codex'
  authority: 'bot' | 'relayer'
  tokenFile: string
  steps: string[]
  next: string
}

export const api = {
  /** Public addresses other machines should use. */
  info: (c: Creds) => get<{ bus: string; http: string }>(c, '/api/console/info'),
  /** One-time invite for another machine. */
  invite: (c: Creds, body: { name?: string; authority?: 'bot' | 'relayer'; ttl_hours?: number }) =>
    post<{ code: string; name: string | null; expires_at: number }>(
      c,
      '/api/console/invites',
      body,
    ),
  /** Same-machine join: the bus configures the host for that directory. */
  join: (c: Creds, body: { host: 'claude' | 'codex'; dir: string; name?: string }) =>
    post<JoinResult>(c, '/api/console/join', body),
  /** F-H5 operator actions: pause / resume a room, cancel a task, speak as the human. */
  pause: (c: Creds, room: string) =>
    post<{ paused: boolean }>(c, `/api/console/rooms/${encodeURIComponent(room)}/pause`),
  resume: (c: Creds, room: string) =>
    post<{ resumed: boolean }>(c, `/api/console/rooms/${encodeURIComponent(room)}/resume`),
  cancelTask: (c: Creds, id: string, reason?: string) =>
    post<{ task: Task }>(
      c,
      `/api/console/tasks/${encodeURIComponent(id)}/cancel`,
      reason ? { reason } : {},
    ),
  send: (c: Creds, room: string, text: string, task_id?: string) =>
    post<{ message: Message }>(
      c,
      `/api/console/rooms/${encodeURIComponent(room)}/send`,
      task_id ? { text, task_id } : { text },
    ),
  snapshot: (c: Creds) => get<Snapshot>(c, '/api/console/snapshot'),
  room: (c: Creds, room: string, limit = 200) =>
    get<{ messages: Message[]; deliveries: Record<string, Delivery[]> }>(
      c,
      `/api/console/rooms/${encodeURIComponent(room)}/messages?limit=${limit}`,
    ),
  task: (c: Creds, id: string) =>
    get<{
      task: Task
      events: {
        to_state: TaskState
        from_state: TaskState | null
        by: string
        summary: string | null
        at: number
      }[]
    }>(c, `/api/console/tasks/${encodeURIComponent(id)}`),
}

export type StreamEvent =
  | { type: 'hello'; agents: AgentInfo[]; now: number }
  | { type: 'event'; event: 'message'; message: Message; deliveries: Delivery[] }
  | { type: 'event'; event: 'delivery'; delivery: Delivery }
  | { type: 'event'; event: 'system'; kind: string; room?: string; detail: Record<string, unknown> }
  | { type: 'event'; event: 'task'; task: Task }
  | { type: 'event'; event: 'presence'; agents: AgentInfo[] }

export function openStream(
  c: Creds,
  onEvent: (e: StreamEvent) => void,
  onState: (s: 'open' | 'closed') => void,
): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const path = import.meta.env.DEV ? '/console-ws' : '/console'
  const ws = new WebSocket(
    `${proto}://${location.host}${path}?name=${encodeURIComponent(c.name)}&token=${encodeURIComponent(c.token)}`,
  )
  ws.onopen = () => onState('open')
  ws.onclose = () => onState('closed')
  ws.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data as string) as StreamEvent)
    } catch {
      // ignore malformed frames
    }
  }
  return () => ws.close()
}
