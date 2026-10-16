import { describe, expect, it } from 'vitest'
import { isAgentbusTool } from './acp-backend.js'

describe('isAgentbusTool', () => {
  it('recognises the adapter tools as named by Claude and Codex', () => {
    expect(isAgentbusTool({ title: 'mcp__agentbus__send' })).toBe(true)
    expect(isAgentbusTool({ title: 'mcp.agentbus.inbox' })).toBe(true)
    expect(isAgentbusTool({ name: 'mcp__agentbus__task_update', title: 'Send a message' })).toBe(
      true,
    )
  })
  it('does not match real tools, even if they mention agentbus', () => {
    expect(isAgentbusTool({ title: 'Bash: rm -rf agentbus' })).toBe(false)
    expect(isAgentbusTool({ title: 'write agentbus.yaml', name: 'Write' })).toBe(false)
    expect(isAgentbusTool({ title: 'mcp__github__create_issue' })).toBe(false)
    expect(isAgentbusTool({})).toBe(false)
  })
})
