import {
  AcpBackend,
  type AgentDriverConfig,
  ApiBackend,
  type Backend,
  CliBackend,
  Driver,
  defaultAcpCommand,
  defaultModes,
} from '@agentbus/driver'
import { adapterCommand } from './adapter-command.js'
import { listStandbyFiles, readAgentToken, type StandbyFile } from './join.js'
import { expandHome } from './paths.js'

type Log = (line: string) => void

/** Backend + Driver for one drivers.yaml entry (also used for standby registrations). */
export function makeDriver(a: AgentDriverConfig, busUrl: string, token: string, log: Log): Driver {
  let backend: Backend
  let kind: 'acp' | 'cli' | 'api' = 'acp'
  if (a.backend === 'api') {
    if (!a.api) throw new Error(`agent ${a.name}: backend api needs an api: block`)
    const apiKey = a.api.api_key_env ? process.env[a.api.api_key_env] : undefined
    backend = new ApiBackend({
      baseUrl: a.api.base_url,
      model: a.api.model,
      maxIterations: a.api.max_iterations,
      ...(apiKey ? { apiKey } : {}),
      ...(a.api.system_prompt ? { systemPrompt: a.api.system_prompt } : {}),
      log,
    })
    kind = 'api'
  } else if (a.backend === 'cli') {
    if (!a.cli) throw new Error(`agent ${a.name}: backend cli needs a cli: block`)
    backend = new CliBackend({
      command: a.cli.command,
      argsFirst: a.cli.args_first,
      argsResume: a.cli.args_resume,
      env: a.cli.env,
      ...(a.cli.session_id_regex ? { sessionIdRegex: a.cli.session_id_regex } : {}),
      log,
    })
    kind = 'cli'
  } else {
    const launch = a.acp ?? defaultAcpCommand(a.backend)
    if (!launch)
      throw new Error(`agent ${a.name}: backend ${a.backend} needs an explicit acp.command`)
    backend = new AcpBackend({
      command: launch.command,
      args: launch.args,
      ...(a.acp?.env ? { env: a.acp.env } : {}),
      autonomy: a.autonomy,
      modes: [...(a.acp?.mode ? [a.acp.mode] : []), ...defaultModes(a.backend, a.autonomy)],
      log,
    })
  }
  const tag = a.standby ? `standby ${a.name}` : `turn ${a.name}`
  return new Driver({
    bus: busUrl,
    name: a.name,
    token,
    backendName: a.backend,
    cwd: expandHome(a.cwd),
    backend,
    adapterCommand: adapterCommand(),
    kind,
    standby: a.standby,
    batchWindowMs: a.batch_window_ms,
    turnTimeoutMs: a.turn_timeout_s * 1000,
    maxAttempts: a.max_attempts,
    permissionTimeoutMs: a.permission_timeout_s * 1000,
    log,
    onTurn: (t) =>
      log(`[${tag}] ${t.messageIds.length} msg, ${t.endedAt - t.startedAt}ms, ${t.exitReason}`),
  })
}

/** A drivers.yaml-shaped entry for a standby registration file. */
export function standbyEntry(name: string, f: StandbyFile): AgentDriverConfig {
  const backend = (
    ['claude-code', 'codex', 'gemini-cli', 'kimi', 'acp', 'api', 'cli'].includes(f.backend)
      ? f.backend
      : f.host === 'claude'
        ? 'claude-code'
        : 'codex'
  ) as AgentDriverConfig['backend']
  return {
    name,
    backend,
    cwd: f.cwd,
    autonomy: f.autonomy ?? 'full',
    standby: true,
    batch_window_ms: f.batch_window_ms ?? 1500,
    turn_timeout_s: f.turn_timeout_s ?? 600,
    max_attempts: 3,
    permission_timeout_s: 600,
    ...(f.acp
      ? {
          acp: {
            command: f.acp.command,
            args: f.acp.args ?? [],
            env: f.acp.env ?? {},
            ...(f.acp.mode ? { mode: f.acp.mode } : {}),
          },
        }
      : {}),
  }
}

/** Does a join-time bus URL point at the bus this process runs (same port, a local name)? */
export function isThisBus(
  entryBus: string | undefined,
  local: { port: number; hosts: string[] },
): boolean {
  if (!entryBus) return true
  try {
    const u = new URL(entryBus)
    const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80))
    if (port !== local.port) return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return ['127.0.0.1', 'localhost', '::1', ...local.hosts].includes(host)
  } catch {
    return false
  }
}

export interface StandbyStatus {
  name: string
  cwd: string
  backend: string
  /** `starting`: the driver's backend is still coming up (npx fetch, login check). */
  state: 'running' | 'starting' | 'failed'
  error?: string
}

/**
 * The standby drivers `agentbus up` runs for joined directories: one per
 * `~/.agentbus/agents/<name>.standby` whose bus is this bus. `reload()` diffs the files
 * against what runs (start new, stop removed, restart changed) so `agentbus join` can add a
 * directory to a running `up` without a restart. A driver that fails to start (host CLI not
 * installed or not logged in) is reported, not fatal.
 */
export class StandbyManager {
  private running = new Map<string, { driver: Driver; key: string }>()
  private starting = new Map<string, { cwd: string; backend: string }>()
  private failed = new Map<string, { key: string; error: string; cwd: string; backend: string }>()
  private reloading: Promise<StandbyStatus[]> | null = null
  private again = false

  constructor(
    private readonly opts: {
      busUrl: string
      local: { port: number; hosts: string[] }
      home?: string
      log: Log
    },
  ) {}

  /**
   * Start / stop drivers to match the registration files. Serialised: a call during a pass
   * queues one more pass after it (so a `join` right behind another is not missed).
   */
  reload(): Promise<StandbyStatus[]> {
    if (this.reloading) {
      this.again = true
      return this.reloading
    }
    this.reloading = this.doReload().finally(() => {
      this.reloading = null
      if (this.again) {
        this.again = false
        void this.reload()
      }
    })
    return this.reloading
  }

  /** `reload()`, but answer within `maxWaitMs` with whatever is known (slow backends keep starting). */
  async reloadWithin(maxWaitMs: number): Promise<StandbyStatus[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), maxWaitMs)
    })
    const r = await Promise.race([this.reload(), wait])
    if (timer) clearTimeout(timer)
    return r ?? this.status()
  }

  private async doReload(): Promise<StandbyStatus[]> {
    const wanted = new Map<string, { entry: AgentDriverConfig; key: string }>()
    for (const { name, entry } of listStandbyFiles(this.opts.home)) {
      if (!isThisBus(entry.bus, this.opts.local)) continue
      const cfg = standbyEntry(name, entry)
      wanted.set(name, { entry: cfg, key: JSON.stringify(cfg) })
    }
    // stop what is gone or changed
    for (const [name, r] of [...this.running]) {
      const w = wanted.get(name)
      if (w && w.key === r.key) continue
      this.running.delete(name)
      this.opts.log(`[standby ${name}] stopping (${w ? 'changed' : 'unregistered'})`)
      await r.driver.stop().catch(() => undefined)
    }
    for (const name of [...this.failed.keys()]) if (!wanted.has(name)) this.failed.delete(name)
    // start what is new or changed
    for (const [name, w] of wanted) {
      if (this.running.has(name)) continue
      const token = readAgentToken(name)
      if (!token) {
        this.failed.set(name, {
          key: w.key,
          error: 'no token file; run agentbus join again',
          cwd: w.entry.cwd,
          backend: w.entry.backend,
        })
        this.opts.log(
          `[standby ${name}] no token file; run "agentbus join" again in ${w.entry.cwd}`,
        )
        continue
      }
      // A registration that failed before is retried on every reload: a login may have happened since.
      this.starting.set(name, { cwd: w.entry.cwd, backend: w.entry.backend })
      try {
        const driver = makeDriver(w.entry, this.opts.busUrl, token, this.opts.log)
        await driver.start()
        this.running.set(name, { driver, key: w.key })
        this.failed.delete(name)
        this.opts.log(`[standby ${name}] ready (${w.entry.backend}, ${w.entry.cwd})`)
      } catch (e) {
        const error = (e as Error).message.split('\n')[0] ?? 'failed'
        this.failed.set(name, { key: w.key, error, cwd: w.entry.cwd, backend: w.entry.backend })
        this.opts.log(
          `[standby ${name}] failed to start: ${error} (is ${w.entry.backend} installed and logged in?)`,
        )
      } finally {
        this.starting.delete(name)
      }
    }
    return this.status()
  }

  status(): StandbyStatus[] {
    const out: StandbyStatus[] = []
    for (const [name, r] of this.running)
      out.push({
        name,
        cwd: r.driver.cwd,
        backend: r.driver.backendName,
        state: 'running',
      })
    for (const [name, s] of this.starting)
      out.push({ name, cwd: s.cwd, backend: s.backend, state: 'starting' })
    for (const [name, f] of this.failed)
      if (!this.starting.has(name))
        out.push({ name, cwd: f.cwd, backend: f.backend, state: 'failed', error: f.error })
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async stopAll(): Promise<void> {
    const all = [...this.running.values()]
    this.running.clear()
    await Promise.all(all.map((r) => r.driver.stop().catch(() => undefined)))
  }
}
