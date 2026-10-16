import { z } from 'zod'

/** `drivers.yaml` (PRODUCT_DESIGN §5.6). */
export const AgentDriverConfig = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  backend: z
    .enum(['claude-code', 'codex', 'gemini-cli', 'kimi', 'acp', 'api', 'cli'])
    .default('acp'),
  token: z.string().optional(),
  token_env: z.string().optional(),
  cwd: z.string(),
  autonomy: z.enum(['full', 'ask']).default('full'),
  batch_window_ms: z.number().int().nonnegative().default(1500),
  turn_timeout_s: z.number().positive().default(600),
  max_attempts: z.number().int().positive().default(3),
  /** How long a human has to answer a permission request (autonomy: ask). */
  permission_timeout_s: z.number().positive().default(600),
  /** Override how the ACP agent process is launched. Required for backend `acp`. */
  acp: z
    .object({
      command: z.string(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string()).default({}),
      /** Session mode id to request (overrides the autonomy-based default). */
      mode: z.string().optional(),
    })
    .optional(),
  /** backend `api`: embedded agent on an OpenAI-compatible gateway (LiteLLM proxy etc.). */
  api: z
    .object({
      base_url: z.string().url(),
      api_key_env: z.string().optional(),
      model: z.string(),
      system_prompt: z.string().optional(),
      max_iterations: z.number().int().positive().default(8),
    })
    .optional(),
  /** backend `cli`: per-turn exec / exec resume fallback. */
  cli: z
    .object({
      command: z.string(),
      args_first: z.array(z.string()),
      args_resume: z.array(z.string()),
      session_id_regex: z.string().optional(),
      env: z.record(z.string()).default({}),
    })
    .optional(),
})
export type AgentDriverConfig = z.infer<typeof AgentDriverConfig>

export const DriversConfig = z.object({
  bus: z.string().default('ws://127.0.0.1:7777/ws'),
  agents: z.array(AgentDriverConfig).default([]),
})
export type DriversConfig = z.infer<typeof DriversConfig>

/** Default ACP launch commands per backend (all are on the ACP official agent list). */
export function defaultAcpCommand(backend: AgentDriverConfig['backend']): {
  command: string
  args: string[]
} | null {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  switch (backend) {
    case 'codex':
      return { command: npx, args: ['-y', '@agentclientprotocol/codex-acp'] }
    case 'claude-code':
      return { command: npx, args: ['-y', '@agentclientprotocol/claude-agent-acp'] }
    case 'gemini-cli':
      return {
        command: process.platform === 'win32' ? 'gemini.cmd' : 'gemini',
        args: ['--experimental-acp'],
      }
    case 'kimi':
      return { command: 'kimi', args: ['acp'] }
    default:
      return null
  }
}

/**
 * Which ACP session modes to ask for, in order. Unattended sessions must not sit in the
 * agent's interactive default: Codex "agent" routes every tool call through its auto
 * reviewer, Claude "default" asks a human who is not there.
 */
export function defaultModes(
  backend: AgentDriverConfig['backend'],
  autonomy: 'full' | 'ask',
): string[] {
  switch (backend) {
    case 'codex':
      return autonomy === 'full' ? ['agent-full-access'] : ['workspace-write', 'read-only']
    case 'claude-code':
      return autonomy === 'full' ? ['bypassPermissions', 'auto', 'acceptEdits'] : ['default']
    default:
      return autonomy === 'full'
        ? ['agent-full-access', 'bypassPermissions', 'auto', 'full-access']
        : ['default', 'workspace-write']
  }
}

export function resolveToken(a: AgentDriverConfig): string {
  if (a.token) return a.token
  if (a.token_env) {
    const v = process.env[a.token_env]
    if (!v) throw new Error(`agent ${a.name}: env ${a.token_env} is not set`)
    return v
  }
  throw new Error(`agent ${a.name}: token or token_env is required`)
}
