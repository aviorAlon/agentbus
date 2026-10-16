import type { Artifact, Message, Part, Task as SdkTask, TaskStatus } from '@a2a-js/sdk'
import { Role, TaskState as SdkState } from '@a2a-js/sdk'
import type { BlobRef, Message as BusMessage, Task, TaskState } from '@agentbus/protocol'

/**
 * Internal model ↔ A2A 1.0 (PRODUCT_DESIGN §4.5 F-T6). The bus core never sees these
 * types; this package owns the mapping and the SDK's wire objects.
 */

const TO_SDK: Record<TaskState, SdkState> = {
  submitted: SdkState.TASK_STATE_SUBMITTED,
  working: SdkState.TASK_STATE_WORKING,
  'input-required': SdkState.TASK_STATE_INPUT_REQUIRED,
  completed: SdkState.TASK_STATE_COMPLETED,
  failed: SdkState.TASK_STATE_FAILED,
  canceled: SdkState.TASK_STATE_CANCELED,
}

const FROM_SDK: Partial<Record<SdkState, TaskState>> = {
  [SdkState.TASK_STATE_SUBMITTED]: 'submitted',
  [SdkState.TASK_STATE_WORKING]: 'working',
  [SdkState.TASK_STATE_INPUT_REQUIRED]: 'input-required',
  [SdkState.TASK_STATE_COMPLETED]: 'completed',
  [SdkState.TASK_STATE_FAILED]: 'failed',
  [SdkState.TASK_STATE_CANCELED]: 'canceled',
  // No internal equivalent: external agents that reject or need auth map to failed.
  [SdkState.TASK_STATE_REJECTED]: 'failed',
}

export function toSdkState(s: TaskState): SdkState {
  return TO_SDK[s]
}
export function fromSdkState(s: SdkState): TaskState | null {
  return FROM_SDK[s] ?? null
}

export interface MapOptions {
  /** Base URL used to turn blob ids into fetchable `url` parts. */
  blobBase: string
}

export const textPart = (text: string): Part => ({
  content: { $case: 'text', value: text },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
})

export const dataPart = (data: unknown): Part => ({
  content: { $case: 'data', value: data },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
})

export function blobPart(b: BlobRef, o: MapOptions): Part {
  return {
    content: { $case: 'url', value: `${o.blobBase}/api/blobs/${b.id}` },
    metadata: { sha256: b.id, size: b.size },
    filename: b.name,
    mediaType: b.mime ?? 'application/octet-stream',
  }
}

/** Room message → A2A Message. The task's executor speaks as ROLE_AGENT. */
export function toSdkMessage(m: BusMessage, executor: string, o: MapOptions): Message {
  const parts: Part[] = [textPart(m.text)]
  if (m.payload !== undefined && m.payload !== null) parts.push(dataPart(m.payload))
  for (const b of m.blobs ?? []) parts.push(blobPart(b, o))
  return {
    messageId: `m_${m.id}`,
    contextId: m.room,
    taskId: m.task_id ?? '',
    role: m.from === executor ? Role.ROLE_AGENT : Role.ROLE_USER,
    parts,
    metadata: { from: m.from, authority: m.authority, created_at: m.created_at },
    extensions: [],
    referenceTaskIds: [],
  }
}

export function toSdkArtifacts(task: Task, o: MapOptions): Artifact[] {
  return task.artifacts.map((b, i) => ({
    artifactId: `${task.id}_a${i + 1}`,
    name: b.name,
    description: '',
    parts: [blobPart(b, o)],
    metadata: undefined,
    extensions: [],
  }))
}

export function toSdkStatus(task: Task, at: number = task.updated_at): TaskStatus {
  return {
    state: toSdkState(task.state),
    message: task.summary
      ? {
          messageId: `${task.id}_status_${at}`,
          contextId: task.room,
          taskId: task.id,
          role: Role.ROLE_AGENT,
          parts: [textPart(task.summary)],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        }
      : undefined,
    timestamp: new Date(at).toISOString(),
  }
}

/** Internal Task (+ thread) → SDK Task. `id` may be overridden with the A2A-side id. */
export function toSdkTask(
  task: Task,
  thread: BusMessage[],
  o: MapOptions,
  idOverride?: string,
): SdkTask {
  return {
    id: idOverride ?? task.id,
    contextId: task.room,
    status: toSdkStatus(task),
    artifacts: toSdkArtifacts(task, o),
    history: thread.map((m) => toSdkMessage(m, task.to, o)),
    metadata: {
      agentbus_task_id: task.id,
      from: task.from,
      to: task.to,
      description: task.description,
      ...(task.context ? { context: task.context } : {}),
      deadline: task.deadline,
      max_turns: task.max_turns,
      turns_used: task.turns_used,
      escalated: task.escalated,
      created_at: task.created_at,
    },
  }
}

/** Incoming A2A message → text + optional context for `task_create` / thread `send`. */
export function fromSdkMessage(m: Message): { text: string; context?: string } {
  const texts: string[] = []
  const data: string[] = []
  for (const p of m.parts) {
    const c = p.content
    if (!c) continue
    if (c.$case === 'text') texts.push(c.value)
    else if (c.$case === 'data') data.push(JSON.stringify(c.value))
    else if (c.$case === 'url') texts.push(`[file ${p.filename || c.value}] ${c.value}`)
    else if (c.$case === 'raw')
      texts.push(`[inline file ${p.filename || 'blob'} ${c.value.length} bytes omitted]`)
  }
  const text = texts.join('\n').trim() || '(no text)'
  return data.length ? { text, context: data.join('\n') } : { text }
}
