import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Backend, BackendSession, McpServerSpec, TurnResult } from './backend.js'

export interface CliBackendOptions {
  command: string
  /** Args for the first turn. Placeholders: {prompt} {cwd} {bus} {name} {adapter_command} {adapter_args}. */
  argsFirst: string[]
  /** Args for later turns; additionally {session}. */
  argsResume: string[]
  /** Regex with one capture group that extracts the session id from stdout of the first turn. */
  sessionIdRegex?: string
  env?: Record<string, string>
  log?: (line: string) => void
}

class CliSession implements BackendSession {
  readonly id = randomUUID()
  sessionId: string | null = null
  alive = true
  readonly closed: Promise<void>
  resolveClosed!: () => void
  constructor(
    readonly cwd: string,
    readonly mcpServers: McpServerSpec[],
  ) {
    this.closed = new Promise<void>((r) => {
      this.resolveClosed = r
    })
  }
}

/**
 * Fallback backend (PRODUCT_DESIGN T4.3): a CLI without ACP or a long-lived mode, run
 * once per turn (`exec` + `exec resume <id>` style). Cold start every turn is the price;
 * the agentbus adapter is handed over as an MCP server through the args template, e.g.
 * for Codex: `-c mcp_servers.agentbus.command={adapter_command} -c mcp_servers.agentbus.args=[...]`.
 * Nothing the CLI prints is ever treated as a reply (§4.3 step 3).
 */
export class CliBackend implements Backend {
  private readonly log: (line: string) => void

  constructor(private readonly opts: CliBackendOptions) {
    this.log = opts.log ?? ((l) => process.stderr.write(`${l}\n`))
  }

  async open(cwd: string, mcpServers: McpServerSpec[]): Promise<BackendSession> {
    return new CliSession(cwd, mcpServers)
  }

  async prompt(session: BackendSession, text: string, signal: AbortSignal): Promise<TurnResult> {
    const s = session as CliSession
    if (!s.alive) throw new Error('session closed')
    const template = s.sessionId ? this.opts.argsResume : this.opts.argsFirst
    const spec = s.mcpServers[0]
    const vars: Record<string, string> = {
      prompt: text,
      cwd: s.cwd,
      session: s.sessionId ?? '',
      adapter_command: spec?.command ?? '',
      adapter_args: (spec?.args ?? []).join(' '),
      bus: spec?.args[spec.args.indexOf('--bus') + 1] ?? '',
      name: spec?.args[spec.args.indexOf('--name') + 1] ?? '',
    }
    const args = template.map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ''))
    const env = {
      ...(process.env as Record<string, string>),
      ...(spec?.env ?? {}),
      ...(this.opts.env ?? {}),
    }
    const out = await run(this.opts.command, args, s.cwd, env, signal)
    if (!s.sessionId && this.opts.sessionIdRegex) {
      const m = new RegExp(this.opts.sessionIdRegex, 'm').exec(out.stdout)
      if (m?.[1]) s.sessionId = m[1]
      else this.log('[cli] could not extract a session id; next turn starts fresh')
    }
    if (out.code !== 0) throw new Error(`cli exited ${out.code}: ${out.stderr.slice(0, 300)}`)
    return { stopReason: signal.aborted ? 'cancelled' : 'end_turn', text: out.stdout }
  }

  async cancel(): Promise<void> {
    // handled through the AbortSignal (process kill)
  }

  async recover(
    _previous: BackendSession,
    cwd: string,
    mcpServers: McpServerSpec[],
  ): Promise<BackendSession> {
    // Nothing is long-lived here; a fresh session simply starts a new conversation.
    return this.open(cwd, mcpServers)
  }

  async close(session: BackendSession): Promise<void> {
    const s = session as CliSession
    s.alive = false
    s.resolveClosed()
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d
    })
    p.stderr.on('data', (d) => {
      stderr += d
    })
    const onAbort = () => p.kill()
    signal.addEventListener('abort', onAbort, { once: true })
    p.on('error', reject)
    p.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr })
    })
  })
}
