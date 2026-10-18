import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_NOTE_END, PROJECT_NOTE_START, projectNote } from './skill.js'

/**
 * `agentbus join` / `leave` (PRODUCT_DESIGN addendum, 2026-10-16): let an agent that
 * already runs in its own terminal take part without learning tokens or drivers.
 *
 * - The identity is the project directory (name = directory basename).
 * - The token lives in `~/.agentbus/agents/<name>.token`; the adapter reads it by name,
 *   so no secret goes into any host config.
 * - The host is configured through its own CLI (`claude mcp add` / `codex mcp add`), and
 *   for Claude Code a UserPromptSubmit hook is added so unread messages surface at every
 *   turn boundary.
 */

export type Host = 'claude' | 'codex'

export interface JoinRequest {
  host: Host
  /** Project directory of the agent (defaults to cwd). */
  dir?: string
  name?: string
  bus: string
  /** Interactive sessions carry a person: relayer by default. */
  authority?: 'bot' | 'relayer'
  /** Human credentials for the bus (owner token) — or an invite code from the bus operator. */
  owner?: { name: string; token: string }
  invite?: string
  /** How the bus is reached over HTTP for the token API (derived from `bus` when omitted). */
  http?: string
  /** Skip the hook (Claude only). */
  noHook?: boolean
  /** Skip the CLAUDE.md / AGENTS.md note. */
  noNote?: boolean
  /** Do not register the directory for standby hosting (`--no-standby`). */
  noStandby?: boolean
  /** Standby autonomy for permission requests; default full. */
  standbyAutonomy?: 'full' | 'ask'
}

export interface JoinResult {
  name: string
  dir: string
  host: Host
  authority: 'bot' | 'relayer'
  tokenFile: string
  /** The standby registration written (or null with --no-standby). */
  standbyFile: string | null
  steps: string[]
  /** What the user has to do now. */
  next: string
}

/**
 * Standby registration for a joined directory: `~/.agentbus/agents/<name>.standby`, JSON.
 * `agentbus up` on the bus machine starts one standby driver per file whose `bus` is this
 * bus; `agentbus join` asks a running `up` to reload them. The shape is a drivers.yaml entry
 * without `name` / `token` (the token is the directory's own token file).
 */
export interface StandbyFile {
  host: Host
  backend: string
  cwd: string
  autonomy: 'full' | 'ask'
  bus: string
  /** Optional ACP launch override (tests, custom adapters), same as drivers.yaml `acp:`. */
  acp?: { command: string; args?: string[]; env?: Record<string, string>; mode?: string }
  batch_window_ms?: number
  turn_timeout_s?: number
  joined_at: number
}

export function standbyFileFor(name: string): string {
  return join(agentbusHome(), 'agents', `${name}.standby`)
}

export function readStandbyFile(name: string): StandbyFile | null {
  const f = standbyFileFor(name)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as StandbyFile
  } catch {
    return null
  }
}

/** Every standby registration in `home` (default: this machine's agentbus home), by name. */
export function listStandbyFiles(home = agentbusHome()): { name: string; entry: StandbyFile }[] {
  const dir = join(home, 'agents')
  if (!existsSync(dir)) return []
  const out: { name: string; entry: StandbyFile }[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.standby')) continue
    try {
      out.push({
        name: f.slice(0, -'.standby'.length),
        entry: JSON.parse(readFileSync(join(dir, f), 'utf8')) as StandbyFile,
      })
    } catch {
      // unreadable registration: skipped, reported by `up`
    }
  }
  return out
}

export function removeStandbyFile(name: string): boolean {
  const f = standbyFileFor(name)
  if (!existsSync(f)) return false
  unlinkSync(f)
  return true
}

export function agentbusHome(): string {
  return process.env.AGENTBUS_HOME ?? join(homedir(), '.agentbus')
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

export function tokenFileFor(name: string): string {
  return join(agentbusHome(), 'agents', `${name}.token`)
}

/** Which bus `name` joined; the agent-side commands default to it, so `--bus` is not needed. */
export function busFileFor(name: string): string {
  return join(agentbusHome(), 'agents', `${name}.bus`)
}

export function readAgentBus(name: string): string | null {
  const f = busFileFor(name)
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf8').trim() || null
}

/** Token for `name` from the local token store, if any. */
export function readAgentToken(name: string): string | null {
  const f = tokenFileFor(name)
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf8').trim() || null
}

export function nameFromDir(dir: string): string {
  const base = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.slice(0, 64) || 'agent'
}

export function httpBaseFromBus(busUrl: string): string {
  const u = new URL(busUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = ''
  u.search = ''
  return u.toString().replace(/\/$/, '')
}

/** This CLI's entry point, for host configs. */
export function cliBin(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url))
}

// On Windows the host CLIs may be .cmd shims or .exe; let the shell resolve PATHEXT.
const hostCmd = (name: string) => name

function run(cmd: string, args: string[], cwd: string): string {
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }
  if (process.platform !== 'win32') return execFileSync(hostCmd(cmd), args, opts)
  // One quoted command line: node warns (DEP0190) when args are concatenated unescaped under `shell`.
  const q = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return execFileSync([hostCmd(cmd), ...args].map(q).join(' '), { ...opts, shell: true })
}

/** Mint (or rotate) the agent's token through the bus's human-only API and store it locally. */
export async function provisionToken(
  req: JoinRequest,
  name: string,
  backend: string,
): Promise<string> {
  const base = req.http ?? httpBaseFromBus(req.bus)
  let token: string
  if (req.invite) {
    const r = await fetch(`${base}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: req.invite, name, backend }),
    })
    if (!r.ok) throw new Error(`invite refused (${r.status}): ${(await r.text()).slice(0, 200)}`)
    token = ((await r.json()) as { token: string }).token
  } else if (req.owner) {
    const r = await fetch(`${base}/api/console/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.owner.token}`,
        'x-agentbus-name': req.owner.name,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, backend, authority: req.authority ?? 'relayer', rotate: true }),
    })
    if (!r.ok)
      throw new Error(
        `bus refused to issue a token (${r.status}): ${(await r.text()).slice(0, 200)}`,
      )
    token = ((await r.json()) as { token: string }).token
  } else throw new Error('need the owner token (same machine) or --invite <code> (another machine)')
  const f = tokenFileFor(name)
  mkdirSync(join(agentbusHome(), 'agents'), { recursive: true })
  writeFileSync(f, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(busFileFor(name), `${req.bus}\n`, 'utf8')
  try {
    chmodSync(f, 0o600)
  } catch {
    // Windows ignores POSIX modes
  }
  return f
}

export async function joinHost(req: JoinRequest): Promise<JoinResult> {
  const dir = resolve(req.dir ?? process.cwd())
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`)
  const name = req.name ?? nameFromDir(dir)
  const backend = req.host === 'claude' ? 'claude-code' : 'codex'
  const steps: string[] = []
  const tokenFile = await provisionToken(req, name, backend)
  steps.push(`token for "${name}" stored in ${tokenFile}`)
  const bin = cliBin()

  // Standby is the default: while nobody reads this directory's session, a hosted one answers.
  let standbyFile: string | null = null
  if (req.noStandby) {
    if (removeStandbyFile(name)) steps.push('standby registration removed (--no-standby)')
  } else {
    standbyFile = standbyFileFor(name)
    const entry: StandbyFile = {
      host: req.host,
      backend,
      cwd: dir,
      autonomy: req.standbyAutonomy ?? 'full',
      bus: req.bus,
      joined_at: Date.now(),
    }
    writeFileSync(standbyFile, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    steps.push(
      `standby registered in ${standbyFile} (a hosted ${backend} session answers for "${name}" when this one does not read in time)`,
    )
  }
  const standbyNote = standbyFile
    ? ` Standby: "agentbus up" must be running on this machine and ${req.host} logged in; it starts a hosted ${backend} session for this directory that answers when nobody reads here within standby.delay_s (default 60 s). Turn it off with "agentbus join --${req.host} --no-standby".`
    : ''

  const noteFile = join(dir, req.host === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')
  if (!req.noNote) {
    addProjectNote(noteFile, projectNote(name, req.bus, launcherFor(bin)))
    steps.push(`note added to ${noteFile} (the agent knows it is on the bus from its first turn)`)
  }

  if (req.host === 'claude') {
    // Project-local scope: this directory's sessions only.
    try {
      run('claude', ['mcp', 'remove', 'agentbus', '-s', 'local'], dir)
    } catch {
      // not configured yet
    }
    run(
      'claude',
      [
        'mcp',
        'add',
        'agentbus',
        '-s',
        'local',
        '--',
        'node',
        bin,
        'agent',
        '--bus',
        req.bus,
        '--name',
        name,
        '--backend',
        'claude-code',
      ],
      dir,
    )
    steps.push(`claude mcp add agentbus (scope local) in ${dir}`)
    if (!req.noHook) {
      addClaudeHook(dir, `node "${bin}" hook user-prompt-submit --bus ${req.bus} --name ${name}`)
      steps.push('UserPromptSubmit hook added to .claude/settings.local.json')
    }
    return {
      name,
      dir,
      host: req.host,
      authority: req.authority ?? 'relayer',
      tokenFile,
      standbyFile,
      steps,
      next: `In ${dir}: leave the running Claude Code session and come back with "claude --continue" (history is kept). Then tell it: 看看 agentbus 有没有人找我.${standbyNote}`,
    }
  }

  // Codex: one global entry; the adapter derives the agent name from the cwd at launch,
  // so every directory that has been joined resolves its own token file.
  try {
    run('codex', ['mcp', 'remove', 'agentbus'], dir)
  } catch {
    // not configured yet
  }
  run(
    'codex',
    ['mcp', 'add', 'agentbus', '--', 'node', bin, 'agent', '--bus', req.bus, '--backend', 'codex'],
    dir,
  )
  steps.push('codex mcp add agentbus (global; agent name = directory name at launch)')
  let next = `In ${dir}: leave the running Codex session and come back with "codex resume". Then tell it: 看看 agentbus 有没有人找我.`
  if (!req.noHook) {
    // Global too: the hook learns the directory (and so the agent) from the cwd Codex passes on stdin.
    const added = addCodexHook(codexHome(), `node "${bin}" hook user-prompt-submit`)
    const hooksFile = join(codexHome(), 'hooks.json')
    steps.push(
      added
        ? `UserPromptSubmit hook added to ${hooksFile} (unread messages appear at every prompt)`
        : `UserPromptSubmit hook already in ${hooksFile}`,
    )
    if (added)
      next +=
        ' Codex runs a new hook only after you trust it once: in the session type /hooks and trust the agentbus entry.'
  }
  return {
    name,
    dir,
    host: req.host,
    authority: req.authority ?? 'relayer',
    tokenFile,
    standbyFile,
    steps,
    next: next + standbyNote,
  }
}

export interface LeaveRequest {
  host: Host
  dir?: string
  name?: string
  /** Also delete the local token file. */
  purge?: boolean
}

export function leaveHost(req: LeaveRequest): { name: string; steps: string[] } {
  const dir = resolve(req.dir ?? process.cwd())
  const name = req.name ?? nameFromDir(dir)
  const steps: string[] = []
  if (req.host === 'claude') {
    try {
      run('claude', ['mcp', 'remove', 'agentbus', '-s', 'local'], dir)
      steps.push('claude mcp remove agentbus')
    } catch (e) {
      steps.push(`claude mcp remove: ${(e as Error).message.split('\n')[0]}`)
    }
    if (removeClaudeHook(dir)) steps.push('hook removed from .claude/settings.local.json')
  } else {
    try {
      run('codex', ['mcp', 'remove', 'agentbus'], dir)
      steps.push('codex mcp remove agentbus')
    } catch (e) {
      steps.push(`codex mcp remove: ${(e as Error).message.split('\n')[0]}`)
    }
    if (removeCodexHook(codexHome()))
      steps.push(`hook removed from ${join(codexHome(), 'hooks.json')}`)
  }
  for (const f of [join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md')])
    if (removeProjectNote(f)) steps.push(`note removed from ${f}`)
  if (removeStandbyFile(name))
    steps.push('standby registration removed (a running "agentbus up" stops it on its next reload)')
  if (req.purge) {
    for (const f of [tokenFileFor(name), busFileFor(name)])
      if (existsSync(f)) {
        unlinkSync(f)
        steps.push(`deleted ${f}`)
      }
  }
  return { name, steps }
}

// ---------------------------------------------------------------- project note

/** `agentbus` launcher for notes: the repo's bin/ shim when present, else node + bin.js. */
function launcherFor(bin: string): string {
  const cmd = resolve(
    bin,
    '..',
    '..',
    '..',
    '..',
    'bin',
    process.platform === 'win32' ? 'agentbus.cmd' : 'agentbus',
  )
  if (existsSync(cmd)) return cmd.includes(' ') ? `"${cmd}"` : cmd
  return `node "${bin}"`
}

export function addProjectNote(file: string, note: string): void {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const stripped = stripNote(current)
  const sep = stripped.length && !stripped.endsWith('\n') ? '\n\n' : stripped.length ? '\n' : ''
  writeFileSync(file, `${stripped}${sep}${note}`)
}

export function removeProjectNote(file: string): boolean {
  if (!existsSync(file)) return false
  const current = readFileSync(file, 'utf8')
  if (!current.includes(PROJECT_NOTE_START)) return false
  const stripped = stripNote(current).replace(/\n{3,}$/, '\n')
  if (stripped.trim() === '') unlinkSync(file)
  else writeFileSync(file, stripped)
  return true
}

function stripNote(text: string): string {
  const a = text.indexOf(PROJECT_NOTE_START)
  if (a < 0) return text
  const b = text.indexOf(PROJECT_NOTE_END, a)
  if (b < 0) return text
  return (
    (text.slice(0, a) + text.slice(b + PROJECT_NOTE_END.length))
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + (text.slice(0, a).trim() ? '\n' : '')
  )
}

// ---------------------------------------------------------------- Claude hook

interface HookEntry {
  type: 'command'
  command: string
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks: HookEntry[]
}
interface Settings {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

const HOOK_MARK = 'hook user-prompt-submit'

function settingsPath(dir: string): string {
  return join(dir, '.claude', 'settings.local.json')
}

function readSettings(dir: string): Settings {
  const p = settingsPath(dir)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Settings
  } catch {
    throw new Error(`${p} is not valid JSON; fix it or remove it`)
  }
}

function writeSettings(dir: string, s: Settings): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(settingsPath(dir), `${JSON.stringify(s, null, 2)}\n`)
}

export function addClaudeHook(dir: string, command: string): void {
  const s = readSettings(dir)
  s.hooks ??= {}
  s.hooks.UserPromptSubmit ??= []
  const groups = s.hooks.UserPromptSubmit
  for (const g of groups) g.hooks = g.hooks.filter((h) => !h.command.includes(HOOK_MARK))
  groups.push({ hooks: [{ type: 'command', command }] })
  s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length)
  writeSettings(dir, s)
}

/**
 * Codex: `$CODEX_HOME/hooks.json`, same shape as Claude's settings. One entry for all joined
 * directories; the command stays byte-identical across joins so Codex's hash-based trust
 * survives. Returns true when the file changed.
 */
export function addCodexHook(home: string, command: string): boolean {
  const p = join(home, 'hooks.json')
  let s: Settings = {}
  if (existsSync(p)) {
    try {
      s = JSON.parse(readFileSync(p, 'utf8')) as Settings
    } catch {
      throw new Error(`${p} is not valid JSON; fix it or remove it`)
    }
  }
  s.hooks ??= {}
  s.hooks.UserPromptSubmit ??= []
  const groups = s.hooks.UserPromptSubmit
  if (groups.some((g) => g.hooks.some((h) => h.command === command))) return false
  for (const g of groups) g.hooks = g.hooks.filter((h) => !h.command.includes(HOOK_MARK))
  groups.push({ hooks: [{ type: 'command', command, timeout: 20 }] })
  s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length)
  mkdirSync(home, { recursive: true })
  writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`)
  return true
}

export function removeCodexHook(home: string): boolean {
  const p = join(home, 'hooks.json')
  if (!existsSync(p)) return false
  let s: Settings
  try {
    s = JSON.parse(readFileSync(p, 'utf8')) as Settings
  } catch {
    return false
  }
  const groups = s.hooks?.UserPromptSubmit
  if (!groups) return false
  let removed = false
  for (const g of groups) {
    const before = g.hooks.length
    g.hooks = g.hooks.filter((h) => !h.command.includes(HOOK_MARK))
    if (g.hooks.length !== before) removed = true
  }
  if (s.hooks) s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length)
  if (removed) writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`)
  return removed
}

export function removeClaudeHook(dir: string): boolean {
  if (!existsSync(settingsPath(dir))) return false
  const s = readSettings(dir)
  const groups = s.hooks?.UserPromptSubmit
  if (!groups) return false
  let removed = false
  for (const g of groups) {
    const before = g.hooks.length
    g.hooks = g.hooks.filter((h) => !h.command.includes(HOOK_MARK))
    if (g.hooks.length !== before) removed = true
  }
  if (s.hooks) s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length)
  if (removed) writeSettings(dir, s)
  return removed
}
