import { z } from 'zod'
import { BlobRef } from './model.js'

/**
 * Task model (PRODUCT_DESIGN §4.5, F-T1–F-T6). A task is a stateful message thread:
 * every transition is also a message in the room carrying `task_id`. State names are
 * the A2A 1.0 states in lowercase; the a2a package maps them to the wire enum.
 */
export const TaskState = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
])
export type TaskState = z.infer<typeof TaskState>

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed', 'canceled']

/** Legal transitions, validated by the bus. */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  submitted: ['working', 'canceled', 'failed'],
  working: ['input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'canceled', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

export const Task = z.object({
  id: z.string(),
  room: z.string(),
  from: z.string(),
  to: z.string(),
  state: TaskState,
  description: z.string(),
  context: z.string().optional(),
  deadline: z.number().int().nullable(),
  max_turns: z.number().int().nullable(),
  turns_used: z.number().int(),
  summary: z.string().nullable(),
  artifacts: z.array(BlobRef),
  escalated: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})
export type Task = z.infer<typeof Task>

export const TaskEvent = z.object({
  id: z.number().int(),
  task_id: z.string(),
  from_state: TaskState.nullable(),
  to_state: TaskState,
  by: z.string(),
  summary: z.string().nullable(),
  artifacts: z.array(BlobRef),
  at: z.number().int(),
})
export type TaskEvent = z.infer<typeof TaskEvent>

/** Payload attached to the message that records a task event. */
export const TaskEventPayload = z.object({
  kind: z.literal('task_event'),
  task_id: z.string(),
  state: TaskState,
  from_state: TaskState.nullable(),
  reason: z.string().optional(),
  escalated: z.boolean().optional(),
})
export type TaskEventPayload = z.infer<typeof TaskEventPayload>

export const TASK_TABLE_FIELDS = [
  'id',
  'state',
  'from',
  'to',
  'room',
  'turns',
  'deadline',
  'description',
] as const

export function taskToRow(t: Task): Record<(typeof TASK_TABLE_FIELDS)[number], string | number> {
  return {
    id: t.id,
    state: t.state,
    from: t.from,
    to: t.to,
    room: t.room,
    turns: `${t.turns_used}/${t.max_turns ?? '∞'}`,
    deadline: t.deadline ? new Date(t.deadline).toISOString() : '',
    description: t.description.length > 120 ? `${t.description.slice(0, 117)}...` : t.description,
  }
}
