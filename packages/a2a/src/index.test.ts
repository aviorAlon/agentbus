import { Role, TaskState as SdkState } from '@a2a-js/sdk'
import type { Message, Task } from '@agentbus/protocol'
import { describe, expect, it } from 'vitest'
import {
  fromSdkMessage,
  fromSdkState,
  textPart,
  toSdkMessage,
  toSdkState,
  toSdkTask,
} from './map.js'

const o = { blobBase: 'http://bus:7777' }

describe('a2a mapping', () => {
  it('maps states both ways; rejected folds into failed, unknown is null', () => {
    expect(toSdkState('input-required')).toBe(SdkState.TASK_STATE_INPUT_REQUIRED)
    expect(fromSdkState(SdkState.TASK_STATE_WORKING)).toBe('working')
    expect(fromSdkState(SdkState.TASK_STATE_REJECTED)).toBe('failed')
    expect(fromSdkState(SdkState.TASK_STATE_UNSPECIFIED)).toBeNull()
  })

  it('maps a task with its thread and artifacts into the SDK shape', () => {
    const task: Task = {
      id: 't_1',
      room: 'dm:alpha|gamma',
      from: 'alpha',
      to: 'gamma',
      state: 'completed',
      description: 'fix the bug',
      deadline: null,
      max_turns: 30,
      turns_used: 3,
      summary: 'done',
      artifacts: [{ id: 'a'.repeat(64), name: 'patch.diff', size: 10, mime: 'text/x-diff' }],
      escalated: false,
      created_at: 1,
      updated_at: 5,
    }
    const thread: Message[] = [
      {
        id: 1,
        room: task.room,
        from: 'alpha',
        authority: 'bot',
        text: '[task t_1] fix the bug',
        task_id: 't_1',
        created_at: 1,
      },
      {
        id: 2,
        room: task.room,
        from: 'gamma',
        authority: 'bot',
        text: 'done',
        task_id: 't_1',
        payload: { k: 1 },
        created_at: 5,
      },
    ]
    const a = toSdkTask(task, thread, o, 'ext-9')
    expect(a.id).toBe('ext-9')
    expect(a.status?.state).toBe(SdkState.TASK_STATE_COMPLETED)
    expect(a.status?.message?.parts[0]).toEqual(textPart('done'))
    expect(a.history[0]?.role).toBe(Role.ROLE_USER)
    expect(a.history[1]?.role).toBe(Role.ROLE_AGENT)
    expect(a.history[1]?.parts).toHaveLength(2)
    expect(a.artifacts[0]?.parts[0]).toMatchObject({
      content: { $case: 'url', value: `http://bus:7777/api/blobs/${'a'.repeat(64)}` },
      filename: 'patch.diff',
      mediaType: 'text/x-diff',
    })
    expect(a.metadata).toMatchObject({
      agentbus_task_id: 't_1',
      from: 'alpha',
      to: 'gamma',
      turns_used: 3,
    })
  })

  it('turns an incoming SDK message into text and context', () => {
    const m = toSdkMessage(
      { id: 9, room: 'r', from: 'x', authority: 'human', text: 'please review', created_at: 0 },
      'gamma',
      o,
    )
    expect(fromSdkMessage(m)).toEqual({ text: 'please review' })
    m.parts.push({
      content: { $case: 'data', value: { pr: 12 } },
      metadata: undefined,
      filename: '',
      mediaType: 'application/json',
    })
    expect(fromSdkMessage(m)).toEqual({ text: 'please review', context: '{"pr":12}' })
  })
})
