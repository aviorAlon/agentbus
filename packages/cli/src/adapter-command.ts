import { fileURLToPath } from 'node:url'

/** How a driver should launch this CLI as the MCP adapter (`agentbus agent ...`). */
export function adapterCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin.js', import.meta.url)), 'agent'],
  }
}
