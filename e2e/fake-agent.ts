#!/usr/bin/env node
/**
 * A deterministic ACP agent for end-to-end tests. It has no model: on every
 * prompt it parses the compact message table the driver rendered, connects to
 * the agentbus MCP server it was handed in `session/new`, and answers each
 * incoming message with `send` (text "echo: <original>"). This exercises the
 * full path driver → ACP → MCP adapter (tool role) → bus without an LLM.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { decodeTable } from '@agentbus/protocol'
import * as acp from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

interface Session {
  id: string
  cwd: string
  mcp: acp.McpServer[]
  client: Client | null
}

const sessions = new Map<string, Session>()
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content[0]?.text ?? ''
process.on('uncaughtException', (e) =>
  process.stderr.write(`[fake-agent] uncaught: ${(e as Error).stack ?? e}
`),
)
process.on('unhandledRejection', (e) =>
  process.stderr.write(`[fake-agent] unhandled: ${(e as Error).stack ?? e}
`),
)
let conn: acp.AgentConnection | null = null
// echo | silent | crash-once | permission | task (executor: works then completes with an artifact)
const MODE = process.env.FAKE_AGENT_MODE ?? 'echo'
// crash-once must survive the restart, so the marker lives on disk.
const CRASH_MARKER = process.env.FAKE_AGENT_CRASH_MARKER ?? ''

async function mcpClient(s: Session): Promise<Client> {
  if (s.client) return s.client
  const spec = s.mcp.find((m) => !('type' in m) || m.type === undefined) as
    | acp.McpServerStdio
    | undefined
  if (!spec) throw new Error('no stdio MCP server given')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const e of spec.env) env[e.name] = e.value
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'fake-agent', version: '0.0.0' })
  await client.connect(transport)
  s.client = client
  return client
}

function parsePrompt(
  text: string,
): { from: string; room: string; text: string; authority: string }[] {
  // Each room block: "## room <name> (<n> new)" then a compact table.
  const out: { from: string; room: string; text: string; authority: string }[] = []
  const blocks = text.split(/^## room .*$/m).slice(1)
  for (const b of blocks) {
    const lines = b.trim().split('\n')
    const start = lines.findIndex((l) => l.startsWith('id|from|'))
    if (start < 0) continue
    const table: string[] = []
    for (const l of lines.slice(start)) {
      if (l === '') break
      table.push(l)
    }
    for (const r of decodeTable(table.join('\n'))) {
      out.push({
        from: r.from ?? '',
        room: r.room ?? '',
        text: r.text ?? '',
        authority: r.authority ?? '',
      })
    }
  }
  return out
}

conn = acp
  .agent({ name: 'fake-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const id = randomUUID()
    sessions.set(id, { id, cwd: ctx.params.cwd, mcp: ctx.params.mcpServers, client: null })
    return { sessionId: id }
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const s = sessions.get(ctx.params.sessionId)
    if (!s) throw new Error('unknown session')
    if (MODE === 'crash-once' && CRASH_MARKER && !existsSync(CRASH_MARKER)) {
      writeFileSync(CRASH_MARKER, 'x')
      process.stderr.write('[fake-agent] crashing on purpose\n')
      process.exit(3)
    }
    const text = ctx.params.prompt.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    const incoming = parsePrompt(text)
    await conn?.client.notify(acp.methods.client.session.update, {
      sessionId: s.id,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `got ${incoming.length} message(s)` },
      },
    })
    if (MODE === 'task') {
      // Executor behaviour: for every new task, report working, attach an artifact, complete.
      const client = await mcpClient(s)
      const created = incoming.filter((m) => /\[task t_[a-z0-9]+\] \S+ → \S+: /.test(m.text))
      for (const m of created) {
        const id = /\[task (t_[a-z0-9]+)\]/.exec(m.text)?.[1] as string
        await client.callTool({
          name: 'task_update',
          arguments: { task_id: id, state: 'working', summary: 'looking' },
        })
        const file = join(s.cwd, `result-${id}.txt`) // the session's workspace, not the driver's cwd
        writeFileSync(file, `result for ${id}\n`)
        const row =
          textOf(await client.callTool({ name: 'put_file', arguments: { path: file } })).split(
            '\n',
          )[1] ?? ''
        const [blobId, blobName] = row.split('|')
        await client.callTool({
          name: 'task_update',
          arguments: {
            task_id: id,
            state: 'completed',
            summary: 'done',
            blobs: blobId ? [{ id: blobId, name: blobName }] : [],
          },
        })
        process.stderr.write(`[fake-agent] completed ${id}
`)
      }
      return { stopReason: 'end_turn' }
    }
    let suffix = ''
    if (MODE === 'permission' && conn) {
      // Ask the client (the driver) for permission before "acting".
      const res = await conn.client.request(acp.methods.client.session.requestPermission, {
        sessionId: s.id,
        toolCall: {
          toolCallId: 'tc-1',
          title: 'write secret.txt',
          kind: 'edit',
          rawInput: { path: 'secret.txt' },
        },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
        ],
      })
      suffix =
        res.outcome.outcome === 'selected' ? ` [perm:${res.outcome.optionId}]` : ' [perm:cancelled]'
    }
    if (MODE !== 'silent') {
      const client = await mcpClient(s)
      for (const m of incoming) {
        const isDm = m.room.startsWith('dm:')
        const args = isDm
          ? { to: m.from, text: `echo: ${m.text}${suffix}` }
          : { room: m.room, text: `echo: ${m.text}${suffix}` }
        const res = await client.callTool({ name: 'send', arguments: args })
        const first = (res.content as { type: string; text?: string }[])[0]
        process.stderr.write(`[fake-agent] send → ${first?.text ?? ''}\n`)
      }
    }
    return { stopReason: 'end_turn' }
  })
  .onNotification(acp.methods.agent.session.cancel, () => undefined)
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  )
