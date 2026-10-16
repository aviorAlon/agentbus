import type { ErrorCode } from '@agentbus/protocol'

export class BusError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryInMs?: number,
  ) {
    super(message)
    this.name = 'BusError'
  }
}
