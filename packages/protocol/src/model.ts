import { z } from 'zod'
import { NAME_RE } from './names.js'

/** Who is speaking. Only `human` messages are instructions (§4.7). */
export const Authority = z.enum(['bot', 'relayer', 'human'])
export type Authority = z.infer<typeof Authority>

/** Connection role (§5.7): one `control` per agent, at most one `tool`. */
export const Role = z.enum(['control', 'tool'])
export type Role = z.infer<typeof Role>

export const DriverKind = z.enum(['acp', 'cli', 'api'])

export const Capabilities = z.object({
  driver: z.object({ kind: DriverKind, recover: z.string().optional() }).optional(),
  inbox: z.boolean().default(false),
  push: z.boolean().default(false),
  /** push is wired through a research-preview channel (dev flag / allowlist); shown in the console. */
  push_preview: z.boolean().optional(),
  /**
   * This connection is the standby for the name: a hosted session that handles what the
   * interactive session leaves unread past `standby.delay_s`. One standby control (and one
   * standby tool) per name; it never takes rows a parked `wait` or a timely `inbox` read.
   */
  standby: z.boolean().optional(),
})
export type Capabilities = z.infer<typeof Capabilities>

export const AgentName = z.string().regex(NAME_RE, 'invalid agent name')
export const RoomName = z.string().min(1).max(140)

export const BlobRef = z.object({
  id: z.string().length(64), // sha256 hex
  name: z.string(),
  mime: z.string().optional(),
  size: z.number().int().nonnegative(),
})
export type BlobRef = z.infer<typeof BlobRef>

export const Message = z.object({
  id: z.number().int().positive(),
  room: RoomName,
  from: z.string(),
  authority: Authority,
  text: z.string(),
  payload: z.unknown().optional(),
  task_id: z.string().optional(),
  blobs: z.array(BlobRef).optional(),
  created_at: z.number().int(), // unix ms
})
export type Message = z.infer<typeof Message>

/** Delivery three-state (§4.2). */
export const DeliveryState = z.enum(['written', 'seen', 'handled'])
export type DeliveryState = z.infer<typeof DeliveryState>

export const DeliveryVia = z.enum([
  'driver',
  'push',
  'wait',
  'mailbox',
  'push->mailbox',
  'push->driver',
  /** Left unread by the interactive session past `standby.delay_s`; handed to the standby. */
  'standby',
])
export type DeliveryVia = z.infer<typeof DeliveryVia>

export const Delivery = z.object({
  message_id: z.number().int(),
  recipient: z.string(),
  state: DeliveryState,
  via: DeliveryVia,
  written_at: z.number().int(),
  seen_at: z.number().int().nullable(),
  handled_at: z.number().int().nullable(),
  attempts: z.number().int(),
  error: z.string().nullable(),
})
export type Delivery = z.infer<typeof Delivery>

export const PresenceState = z.enum(['working', 'idle', 'blocked', 'unknown'])
export type PresenceState = z.infer<typeof PresenceState>

export const AgentInfo = z.object({
  name: z.string(),
  backend: z.string().nullable(),
  authority: Authority,
  online: z.boolean(),
  state: PresenceState,
  capabilities: Capabilities,
  cwd: z.string().nullable(),
  last_seen: z.number().int().nullable(),
  /** A standby (hosted) connection is online for this name right now. */
  standby: z.boolean().optional(),
})
export type AgentInfo = z.infer<typeof AgentInfo>

/** Compact-table field order for message lists (§4.3). */
export const MESSAGE_TABLE_FIELDS = [
  'id',
  'from',
  'authority',
  'room',
  'ts',
  'text',
  'attachments',
] as const

export type MessageRow = Record<(typeof MESSAGE_TABLE_FIELDS)[number], string | number>

export function messageToRow(m: Message): MessageRow {
  return {
    id: m.id,
    from: m.from,
    authority: m.authority,
    room: m.room,
    ts: new Date(m.created_at).toISOString(),
    text: m.text,
    attachments: (m.blobs ?? []).map((b) => `${b.name}:${b.id.slice(0, 12)}`).join(','),
  }
}
