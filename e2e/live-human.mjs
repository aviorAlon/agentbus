#!/usr/bin/env node
/**
 * Scripted human for live (real backend) verification. Not part of the test suite.
 *
 *   node e2e/live-human.mjs <busUrl> <ownerToken> dm <agent> "<text>" [timeoutS]
 *   node e2e/live-human.mjs <busUrl> <ownerToken> room <room> "<text>" [timeoutS] [expectFrom...]
 *
 * Sends one human message, then prints every message that arrives until the timeout
 * (dm: until the agent replies once; room: until timeout or the room pauses).
 */
import { BusClient } from '@agentbus/core'

const [busUrl, token, mode, target, text, timeoutS = '120'] = process.argv.slice(2)
if (!busUrl || !token || !mode || !target || !text) {
  console.error('usage: live-human.mjs <busUrl> <ownerToken> dm|room <target> "<text>" [timeoutS]')
  process.exit(2)
}

const c = new BusClient(busUrl)
await c.connect()
await c.request({
  type: 'register',
  name: 'owner',
  token,
  role: 'control',
  capabilities: { inbox: true, push: false },
})
c.on('event', (e) => {
  if (e.event === 'system')
    console.log(`[system] ${e.kind} ${e.room ?? ''} ${JSON.stringify(e.detail)}`)
})
if (mode === 'room') await c.request({ type: 'join', room: target })
await c.request({ type: 'inbox' })

const sent = await c.request({
  type: 'send',
  text,
  ...(mode === 'dm' ? { to: target } : { room: target }),
})
const room = sent.message.room
console.log(
  `[sent] #${sent.message.id} ${room} → ${sent.deliveries.map((d) => `${d.recipient}:${d.via}/${d.state}`).join(', ')}`,
)

const deadline = Date.now() + Number(timeoutS) * 1000
let replied = false
while (Date.now() < deadline) {
  const left = Math.max(1, Math.round((deadline - Date.now()) / 1000))
  const r = await c.request({ type: 'wait', timeout_s: Math.min(left, 60) })
  for (const m of r.messages) {
    if (m.room !== room) continue
    console.log(
      `[${new Date(m.created_at).toLocaleTimeString()}] ${m.from}(${m.authority}): ${m.text}`,
    )
    if (mode === 'dm' && m.from === target) replied = true
  }
  if (replied) break
}
if (!replied && mode === 'dm') console.log('[timeout] no reply')
c.close()
process.exit(replied || mode === 'room' ? 0 : 1)
