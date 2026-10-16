import type { BusClient } from '@agentbus/core'
import type { Message } from '@agentbus/protocol'
import { encodeRecords } from '@agentbus/protocol'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type BlobHttp, getFile, putFile } from './files.js'
import { renderMessages } from './render.js'

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] })
const fail = (e: unknown): ToolText => ({
  content: [{ type: 'text', text: `error: ${(e as Error).message}` }],
  isError: true,
})

export interface M1ToolOptions {
  client: BusClient
  http: BlobHttp
  cwd: string
  /**
   * Longest single wait the host tolerates. MCP hosts time tool calls out (Claude Code:
   * MCP_TOOL_TIMEOUT); the adapter cannot extend that, so it caps each call below it and
   * tells the model to call again. Env AGENTBUS_MAX_WAIT_S overrides.
   */
  maxWaitS?: number
}

/** `wait_for_message`, `put_file`, `get_file`, `list_files` (PRODUCT_DESIGN F-A6, F-A8). */
export function registerM1Tools(s: McpServer, o: M1ToolOptions): void {
  const maxWait = o.maxWaitS ?? (Number(process.env.AGENTBUS_MAX_WAIT_S ?? '') || 55)

  s.registerTool(
    'wait_for_message',
    {
      description:
        `Block until a message arrives or the timeout passes (max ${maxWait}s per call; call again to keep waiting). ` +
        'Use it only when you have nothing else to do but wait for a reply, e.g. after handing someone a task. ' +
        'Each call costs a model turn; prefer `inbox` at the start of a turn.',
      inputSchema: { timeout_s: z.number().min(0).max(3600).default(maxWait) },
    },
    async ({ timeout_s }) => {
      try {
        const t = Math.min(timeout_s, maxWait)
        const r = await o.client.request<{ messages: Message[]; timed_out: boolean }>({
          type: 'wait',
          timeout_s: t,
        })
        if (r.timed_out)
          return text(
            `no message within ${t}s${timeout_s > t ? ` (capped from ${timeout_s}s; call again to continue waiting)` : ''}`,
          )
        return text(renderMessages(r.messages))
      } catch (e) {
        return fail(e)
      }
    },
  )

  s.registerTool(
    'put_file',
    {
      description:
        'Upload a local file to the bus blob store. Returns id|name|size; pass {id,name} in `send` blobs to attach it.',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      try {
        const r = await putFile(o.http, path)
        return text(encodeRecords(['id', 'name', 'size'], [r]))
      } catch (e) {
        return fail(e)
      }
    },
  )

  s.registerTool(
    'get_file',
    {
      description:
        'Download a blob attached to a message into this workspace. The bus chooses the location (.agentbus/inbox/<id>/<name>) and returns the local path.',
      inputSchema: { blob_id: z.string(), name: z.string().optional() },
    },
    async ({ blob_id, name }) => {
      try {
        const dest = await getFile(o.http, o.cwd, blob_id, name)
        return text(dest)
      } catch (e) {
        return fail(e)
      }
    },
  )

  s.registerTool(
    'list_files',
    {
      description: 'Files attached to messages in a room (newest first).',
      inputSchema: { room: z.string(), limit: z.number().int().min(1).max(500).default(100) },
    },
    async ({ room, limit }) => {
      try {
        const r = await o.client.request<{ messages: Message[] }>({ type: 'history', room, limit })
        const rows: { message_id: number; from: string; id: string; name: string; size: number }[] =
          []
        for (const m of r.messages)
          for (const b of m.blobs ?? [])
            rows.push({ message_id: m.id, from: m.from, id: b.id, name: b.name, size: b.size })
        rows.reverse()
        return text(encodeRecords(['message_id', 'from', 'id', 'name', 'size'], rows))
      } catch (e) {
        return fail(e)
      }
    },
  )
}
