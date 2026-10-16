import { z } from 'zod'
import { AgentName, Capabilities, Delivery, Message, Role, RoomName } from './model.js'
import { Task, TaskState } from './tasks.js'

/**
 * WS /ws frames (§5.5). Every client request carries a correlation `id`;
 * the server answers with exactly one `response`. Server-initiated frames are `event`s.
 */

const base = { id: z.string().min(1) }

export const RegisterFrame = z.object({
  ...base,
  type: z.literal('register'),
  name: AgentName,
  token: z.string().min(1),
  role: Role.default('control'),
  capabilities: Capabilities.default({ inbox: false, push: false }),
  backend: z.string().optional(),
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  version: z.string().optional(),
})

export const JoinFrame = z.object({ ...base, type: z.literal('join'), room: RoomName })
export const LeaveFrame = z.object({ ...base, type: z.literal('leave'), room: RoomName })

export const SendFrame = z.object({
  ...base,
  type: z.literal('send'),
  room: RoomName.optional(),
  to: AgentName.optional(),
  text: z.string(),
  payload: z.unknown().optional(),
  task_id: z.string().optional(),
  blobs: z.array(z.object({ id: z.string().length(64), name: z.string().min(1) })).optional(),
})

export const HistoryFrame = z.object({
  ...base,
  type: z.literal('history'),
  room: RoomName,
  limit: z.number().int().min(1).max(500).default(50),
  before: z.number().int().optional(),
})

/** `peek`: return unread rows without marking them seen (hooks use it, so the agent's own `inbox` still shows them). */
export const InboxFrame = z.object({
  ...base,
  type: z.literal('inbox'),
  peek: z.boolean().optional(),
})
/** `from`: return only when a message from that sender arrives; others stay unread in the mailbox. */
export const WaitFrame = z.object({
  ...base,
  type: z.literal('wait'),
  timeout_s: z.number().min(0).max(3600),
  from: AgentName.optional(),
})
export const AckFrame = z.object({
  ...base,
  type: z.literal('ack'),
  message_ids: z.array(z.number().int()).min(1),
})
export const StatusFrame = z.object({
  ...base,
  type: z.literal('status'),
  text: z.string().max(200).optional(),
  state: z.enum(['working', 'idle', 'blocked']).optional(),
})
export const AgentsFrame = z.object({ ...base, type: z.literal('agents') })
export const RoomsFrame = z.object({ ...base, type: z.literal('rooms') })
export const HeartbeatFrame = z.object({ ...base, type: z.literal('heartbeat') })

// ---- tasks (M2)
export const TaskCreateFrame = z.object({
  ...base,
  type: z.literal('task_create'),
  to: AgentName,
  description: z.string().min(1),
  context: z.string().optional(),
  /** Room to run the task in; defaults to the dm between dispatcher and executor. */
  room: RoomName.optional(),
  blobs: z.array(z.object({ id: z.string().length(64), name: z.string().min(1) })).optional(),
  /** Seconds from now; null disables. Default from bus config. */
  deadline_s: z.number().positive().nullable().optional(),
  /** Bot messages allowed in the thread; null disables. Default from bus config. */
  max_turns: z.number().int().positive().nullable().optional(),
})
export const TaskUpdateFrame = z.object({
  ...base,
  type: z.literal('task_update'),
  task_id: z.string(),
  state: z.enum(['working', 'input-required', 'completed', 'failed']),
  summary: z.string().optional(),
  blobs: z.array(z.object({ id: z.string().length(64), name: z.string().min(1) })).optional(),
  /** input-required only: also notify a human even if the dispatcher is a bot. */
  escalate: z.boolean().optional(),
})
export const TaskCancelFrame = z.object({
  ...base,
  type: z.literal('task_cancel'),
  task_id: z.string(),
  reason: z.string().optional(),
})
export const TasksFrame = z.object({
  ...base,
  type: z.literal('tasks'),
  /** Default: tasks I dispatched or execute; humans see all. */
  state: TaskState.optional(),
  open_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(500).default(100),
})
/** Driver → bus: one record per backend turn (F-O2). */
export const TurnReportFrame = z.object({
  ...base,
  type: z.literal('turn_report'),
  session_id: z.string().nullable(),
  message_ids: z.array(z.number().int()),
  started_at: z.number().int(),
  ended_at: z.number().int(),
  tokens: z.number().int().nullable().optional(),
  sent: z.boolean(),
  exit_reason: z.string(),
  recovered: z.boolean(),
})

export const ClientFrame = z.discriminatedUnion('type', [
  RegisterFrame,
  JoinFrame,
  LeaveFrame,
  SendFrame,
  HistoryFrame,
  InboxFrame,
  WaitFrame,
  AckFrame,
  StatusFrame,
  AgentsFrame,
  RoomsFrame,
  HeartbeatFrame,
  TaskCreateFrame,
  TaskUpdateFrame,
  TaskCancelFrame,
  TasksFrame,
  TurnReportFrame,
])
export type ClientFrame = z.infer<typeof ClientFrame>
/** What a client may send (defaults such as `role` still optional). */
export type ClientFrameInput = z.input<typeof ClientFrame>
/** `Omit` that distributes over a union instead of collapsing it. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type ClientRequest = DistributiveOmit<ClientFrameInput, 'id'>

/** Parse plus the cross-field rule that a discriminated union cannot carry. */
export function parseClientFrame(raw: unknown): ClientFrame {
  const f = ClientFrame.parse(raw)
  if (f.type === 'send' && (f.room ? 1 : 0) + (f.to ? 1 : 0) !== 1) {
    throw new z.ZodError([
      { code: 'custom', path: ['room'], message: 'exactly one of room/to is required' },
    ])
  }
  return f
}

export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'name_taken',
  'not_registered',
  'not_member',
  'unknown_agent',
  'unknown_room',
  'rate_limited',
  'paused',
  'too_large',
  'not_implemented',
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ResponseFrame = z.union([
  z.object({
    type: z.literal('response'),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({
      code: ErrorCode,
      message: z.string(),
      retry_in_ms: z.number().optional(),
    }),
  }),
])
export type ResponseFrame = z.infer<typeof ResponseFrame>

export const SystemKind = z.enum([
  'paused',
  'resumed',
  'undeliverable',
  'takeover',
  'rate_limited',
  'task_budget',
])
export type SystemKind = z.infer<typeof SystemKind>

export const EventFrame = z.discriminatedUnion('event', [
  z.object({ type: z.literal('event'), event: z.literal('message'), message: Message }),
  z.object({ type: z.literal('event'), event: z.literal('delivery'), delivery: Delivery }),
  z.object({ type: z.literal('event'), event: z.literal('task'), task: Task }),
  z.object({
    type: z.literal('event'),
    event: z.literal('system'),
    kind: SystemKind,
    room: RoomName.optional(),
    detail: z.record(z.unknown()).default({}),
  }),
])
export type EventFrame = z.infer<typeof EventFrame>

export const ServerFrame = z.union([ResponseFrame, EventFrame])
export type ServerFrame = z.infer<typeof ServerFrame>

/** Results of specific requests, for typed clients. */
export type RegisterResult = {
  name: string
  role: Role
  authority: 'bot' | 'relayer' | 'human'
  took_over: boolean
}
export type SendResult = { message: Message; deliveries: Delivery[] }
export type InboxResult = { messages: Message[] }
