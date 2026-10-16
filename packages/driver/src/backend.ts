/**
 * Backend interface the driver speaks (PRODUCT_DESIGN §5.5):
 * `open → prompt* → (recover)* → close`. `AcpBackend` is the main implementation.
 */

export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface PermissionDecision {
  /** Pick an option id, or `null` to cancel. */
  optionId: string | null
}

export interface PermissionAsk {
  title: string
  kind: string | null
  rawInput: unknown
  options: { optionId: string; name: string; kind: string }[]
}

export interface BackendSession {
  readonly id: string
  /** Resolves when the underlying process has gone away. */
  readonly closed: Promise<void>
  readonly alive: boolean
}

export interface TurnResult {
  stopReason: string
  /** Concatenated agent text chunks (for logs; never treated as a reply). */
  text: string
}

export interface Backend {
  open(cwd: string, mcpServers: McpServerSpec[]): Promise<BackendSession>
  prompt(session: BackendSession, text: string, signal: AbortSignal): Promise<TurnResult>
  cancel(session: BackendSession): Promise<void>
  /** Rebuild a session after a crash: `session/load` when supported, else a fresh one. */
  recover(
    previous: BackendSession,
    cwd: string,
    mcpServers: McpServerSpec[],
  ): Promise<BackendSession>
  close(session: BackendSession): Promise<void>
  /** Backends that can ask for permission route the question here (`autonomy: ask`). */
  setPermissionHandler?(handler: PermissionHandler): void
}

export type PermissionHandler = (ask: PermissionAsk) => Promise<PermissionDecision>
