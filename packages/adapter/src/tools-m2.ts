import type { BusClient } from '@agentbus/core'
import type { Task } from '@agentbus/protocol'
import { encodeRecords, TASK_TABLE_FIELDS, taskToRow } from '@agentbus/protocol'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] })
const fail = (e: unknown): ToolText => ({
  content: [{ type: 'text', text: `error: ${(e as Error).message}` }],
  isError: true,
})

const BlobRefs = z
  .array(z.object({ id: z.string().length(64), name: z.string().min(1) }))
  .optional()
  .describe('attachments previously uploaded with put_file')

const taskLine = (t: Task) =>
  `task ${t.id} [${t.state}] ${t.from} → ${t.to} in ${t.room}; turns ${t.turns_used}/${t.max_turns ?? '∞'}` +
  (t.deadline ? `; deadline ${new Date(t.deadline).toISOString()}` : '')

/** `task_create`, `task_update`, `task_cancel`, `tasks` (PRODUCT_DESIGN F-A9, §4.5). */
export function registerTaskTools(s: McpServer, client: BusClient): void {
  s.registerTool(
    'task_create',
    {
      description:
        'Hand a task to another agent. Creates a tracked task (state submitted) and posts it in your dm with them ' +
        '(or in `room`). Messages about it must carry its task_id. Budget: deadline_s and max_turns (bot messages in the thread).',
      inputSchema: {
        to: z.string(),
        description: z.string().min(1),
        context: z.string().optional(),
        room: z.string().optional(),
        blobs: BlobRefs,
        deadline_s: z.number().positive().nullable().optional(),
        max_turns: z.number().int().positive().nullable().optional(),
      },
    },
    async (args) => {
      try {
        const r = await client.request<{ task: Task }>({
          type: 'task_create',
          to: args.to,
          description: args.description,
          ...(args.context ? { context: args.context } : {}),
          ...(args.room ? { room: args.room } : {}),
          ...(args.blobs?.length ? { blobs: args.blobs } : {}),
          ...(args.deadline_s !== undefined ? { deadline_s: args.deadline_s } : {}),
          ...(args.max_turns !== undefined ? { max_turns: args.max_turns } : {}),
        })
        return text(`created ${taskLine(r.task)}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  s.registerTool(
    'task_update',
    {
      description:
        'Executor reports progress: working | input-required (you need an answer from the dispatcher) | completed | failed. ' +
        'Attach artifacts with blobs. Illegal transitions are rejected by the bus.',
      inputSchema: {
        task_id: z.string(),
        state: z.enum(['working', 'input-required', 'completed', 'failed']),
        summary: z.string().optional(),
        blobs: BlobRefs,
        escalate: z.boolean().optional().describe('input-required: also alert a human now'),
      },
    },
    async (args) => {
      try {
        const r = await client.request<{ task: Task }>({
          type: 'task_update',
          task_id: args.task_id,
          state: args.state,
          ...(args.summary ? { summary: args.summary } : {}),
          ...(args.blobs?.length ? { blobs: args.blobs } : {}),
          ...(args.escalate !== undefined ? { escalate: args.escalate } : {}),
        })
        return text(`updated ${taskLine(r.task)}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  s.registerTool(
    'task_cancel',
    {
      description: 'Dispatcher (or a human) cancels a task.',
      inputSchema: { task_id: z.string(), reason: z.string().optional() },
    },
    async (args) => {
      try {
        const r = await client.request<{ task: Task }>({
          type: 'task_cancel',
          task_id: args.task_id,
          ...(args.reason ? { reason: args.reason } : {}),
        })
        return text(`canceled ${taskLine(r.task)}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  s.registerTool(
    'tasks',
    {
      description: 'Tasks you dispatched or execute (humans: all). Open ones by default.',
      inputSchema: {
        state: z
          .enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'])
          .optional(),
        open_only: z.boolean().default(true),
      },
    },
    async (args) => {
      try {
        const r = await client.request<{ tasks: Task[] }>({
          type: 'tasks',
          open_only: args.open_only,
          ...(args.state ? { state: args.state } : {}),
        })
        return text(encodeRecords(TASK_TABLE_FIELDS, r.tasks.map(taskToRow)))
      } catch (e) {
        return fail(e)
      }
    },
  )
}
