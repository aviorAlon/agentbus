import { useCallback, useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

const dict = {
  // generic
  'app.name': ['agentbus', 'agentbus'],
  'app.tagline': ['agent 之间的消息总线', 'the message bus between your agents'],
  'nav.overview': ['总览', 'Overview'],
  'nav.tasks': ['任务', 'Tasks'],
  'nav.turns': ['回合', 'Turns'],
  'nav.join': ['加入 agent', 'Add agent'],
  'nav.logout': ['退出登录', 'Sign out'],
  'nav.theme': ['主题', 'Theme'],
  'nav.lang': ['语言', 'Language'],
  'stream.open': ['实时连接正常', 'Live connection up'],
  'stream.closed': ['实时连接断开，15 秒轮询中', 'Live connection down; polling every 15s'],
  loading: ['加载中…', 'Loading…'],
  'you.are': ['你是', 'You are'],
  ago: ['{0}前', '{0} ago'],
  'unit.s': ['{0} 秒', '{0}s'],
  'unit.m': ['{0} 分', '{0}m'],
  'unit.h': ['{0} 小时', '{0}h'],

  // login
  'login.help': [
    '用你的 owner token 登录。它在 ~/.agentbus/owner.token，是 agentbus up 第一次启动时生成的。',
    'Sign in with your owner token. It lives in ~/.agentbus/owner.token and was minted the first time agentbus up ran.',
  ],
  'login.name': ['名字', 'Name'],
  'login.token': ['token', 'Token'],
  'login.enter': ['进入', 'Enter'],

  // agents
  'agents.title': ['Agents', 'Agents'],
  'agents.online': ['{0}/{1} 在线', '{0}/{1} online'],
  'agents.empty': ['还没有 agent，点"加入 agent"', 'No agents yet. Use "Add agent".'],
  'agents.dm': ['私聊', 'DM'],
  'state.working': ['工作中', 'working'],
  'state.idle': ['空闲', 'idle'],
  'state.blocked': ['等人回答', 'waiting for a person'],
  'state.unknown': ['离线', 'offline'],
  'badge.driver': ['托管', 'hosted'],
  'badge.driver.tip': [
    '会话由总线托管，有消息就会被叫醒',
    'Session held by the bus; woken on every message',
  ],
  'badge.standby': ['待命', 'standby'],
  'badge.standby.tip': [
    '这个目录同时有一个托管会话待命：人没在约一分钟内读的消息和任务由它代答',
    'A hosted session is on standby for this directory: it answers what the person leaves unread for about a minute',
  ],
  'badge.relayer': ['人在用', 'in use'],
  'badge.relayer.tip': [
    '有人正在这个会话里工作，它在自己的回合里收发',
    'A person works in this session; it reads and replies in its own turns',
  ],
  'badge.human': ['人', 'human'],
  'badge.push': ['push', 'push'],

  // rooms
  'rooms.title': ['对话', 'Conversations'],
  'rooms.empty': [
    '还没有对话。点一个 agent 旁的"私聊"开始。',
    'No conversations yet. Click "DM" next to an agent.',
  ],
  'room.paused': ['已暂停', 'paused'],
  'room.pause': ['暂停', 'Pause'],
  'room.pause.tip': ['让 bot 停下，直到你说话或点恢复', 'Stop the bots until you speak or resume'],
  'room.resume': ['恢复', 'Resume'],
  'room.members': ['成员', 'Members'],
  'room.empty': ['还没有消息。', 'No messages yet.'],
  'msg.task': ['任务 {0}', 'task {0}'],
  'msg.replyInTask': ['在任务里回复', 'Reply in task'],
  'delivery.written': ['已送', 'sent'],
  'delivery.seen': ['已收', 'seen'],
  'delivery.handled': ['已处理', 'handled'],
  'delivery.tip': [
    '路径 {0}\n送达 {1}\n收到 {2}\n处理 {3}',
    'via {0}\nwritten {1}\nseen {2}\nhandled {3}',
  ],
  'reply.placeholder': [
    '以 {0} 的身份在这里说话（人类权威：能解除暂停、回答请求）',
    'Speak here as {0} (human authority: lifts pauses, answers requests)',
  ],
  'reply.send': ['发送', 'Send'],
  'reply.taskTag': ['任务 {0}', 'task {0}'],

  // overview
  'home.title': ['总览', 'Overview'],
  'home.agentsOnline': ['agent 在线', 'agents online'],
  'home.of': ['共 {0}', 'of {0}'],
  'home.openTasks': ['任务进行中', 'open tasks'],
  'home.waiting': ['等你回答', 'waiting for you'],
  'home.paused': ['房间已暂停', 'rooms paused'],
  'home.needYou': ['需要你回答', 'Needs your answer'],
  'home.waitingOn': ['{0} 在等 {1}', '{0} is waiting for {1}'],
  'home.pausedRooms': ['暂停的房间', 'Paused rooms'],
  'home.pausedHint': [
    'bot 之间说得太多了。你说一句，或点"恢复"。',
    'The bots talked too long. Say something, or click Resume.',
  ],
  'home.howto': ['怎么用', 'How to use'],
  'home.step1': [
    '左栏"加入 agent"把一个正在用的 Claude Code / Codex 目录接进来，或在那个目录里运行 agentbus join --claude。',
    'Use "Add agent" to bring in a directory where Claude Code / Codex already works, or run agentbus join --claude there.',
  ],
  'home.step2': [
    '点 agent 旁的"私聊"直接跟它说话。被托管的 agent 几秒到几十秒回复；人在用的会话在下一回合看到。',
    'Click "DM" to talk to an agent. Hosted agents answer within seconds; sessions in use see it in their next turn.',
  ],
  'home.step3': [
    '让一个 agent "用 task_create 给 xx 派活"，看板里会出现任务卡片；超过预算总线会自动关掉。',
    'Tell an agent to hand work to another with task_create; it shows up on the board and the bus closes it when the budget runs out.',
  ],
  'home.lastActivity': ['最近活动', 'Last activity'],
  none: ['无', 'none'],

  // join
  'join.title': ['加入一个正在用的 agent', 'Add an agent that already works'],
  'join.where': ['agent 在哪台机器', 'Where does the agent run'],
  'join.local': ['这台机器（总线所在）', 'This machine (where the bus runs)'],
  'join.remote': ['另一台机器', 'Another machine'],
  'join.remote.help': [
    '控制台碰不到别的机器的文件，所以给你一条一次性的加入命令：复制到那台机器、在 agent 的项目目录里运行。24 小时内有效，只能用一次。',
    "The console cannot reach another machine's files, so it gives you a one-time join command: copy it to that machine and run it inside the agent's project directory. Valid 24h, single use.",
  ],
  'join.remote.name': [
    '名字（可留空，由对方目录名决定）',
    'Name (optional; defaults to the directory name there)',
  ],
  'join.gen': ['生成加入命令', 'Generate join command'],
  'join.copy': ['复制', 'Copy'],
  'join.copied': ['已复制', 'Copied'],
  'join.validUntil': ['有效到 {0}，只能用一次', 'Valid until {0}, single use'],
  'join.remote.steps': [
    '那台机器要先装好 agentbus（克隆仓库、pnpm install、pnpm tsc -b），能访问 {0}。',
    'That machine needs agentbus installed (clone, pnpm install, pnpm tsc -b) and must reach {0}.',
  ],
  'join.help': [
    '把某个目录下的 Claude Code / Codex 会话接到总线上：总线给它一个身份和 token，再把 agentbus 的工具挂进那个会话。',
    'Connect the Claude Code / Codex session of a directory to the bus: the bus mints an identity and token, then adds the agentbus tools to that session.',
  ],
  'join.sameMachine': [
    '这里只对和总线同一台机器上的目录有效；别的机器在那个目录里运行',
    'This works for directories on the bus machine only; on another machine run, inside that directory,',
  ],
  'join.host': ['会话类型', 'Session'],
  'join.dir': ['项目目录', 'Project directory'],
  'join.name': ['名字', 'Name'],
  'join.nameHint': ['默认取目录名', 'defaults to the directory name'],
  'join.go': ['加入', 'Add'],
  'join.busy': ['加入中…', 'Adding…'],
  'join.done': ['已加入：{0}', 'Added: {0}'],
  'join.leave.title': ['退出', 'Leave'],
  'join.leave.help': [
    '在那个目录里运行 {0}；要连身份一起删加 --purge。只是暂时不想收某个房间的消息，直接让 agent "离开房间 xx"。',
    'Run {0} in that directory; add --purge to delete the identity too. To stop hearing one room, just tell the agent to leave it.',
  ],

  // tasks
  'tasks.title': ['任务看板', 'Task board'],
  'task.submitted': ['已派发', 'Submitted'],
  'task.working': ['进行中', 'Working'],
  'task.input-required': ['等待输入', 'Needs input'],
  'task.completed': ['完成', 'Completed'],
  'task.failed': ['失败', 'Failed'],
  'task.canceled': ['取消', 'Canceled'],
  'task.turns': ['轮次 {0}/{1}', 'turns {0}/{1}'],
  'task.left': ['剩 {0}', '{0} left'],
  'task.overdue': ['已超时', 'overdue'],
  'task.escalated': ['已升级给人', 'escalated'],
  'task.files': ['{0} 个文件', '{0} file(s)'],
  'task.cancel': ['取消任务', 'Cancel task'],
  'task.cancel.reason': ['从控制台取消', 'canceled from the console'],
  'task.waitHint': [
    '{0} 在等回答。到 {1} 里点消息旁的"在任务里回复"。',
    '{0} is waiting. Go to {1} and use "Reply in task" next to a message.',
  ],
  'task.id': ['编号', 'ID'],
  'task.route': ['路线', 'Route'],
  'task.in': ['在', 'in'],
  'task.context': ['背景', 'Context'],
  'task.budget': ['预算', 'Budget'],
  'task.budget.v': ['{0}/{1} 轮；截止 {2}', '{0}/{1} turns; deadline {2}'],
  'task.result': ['结果', 'Result'],
  'task.artifacts': ['产物', 'Artifacts'],
  'task.artifactHint': ['agent 用 get_file 取', 'agents fetch with get_file'],
  'task.events': ['事件', 'Events'],
  'task.noDeadline': ['无', 'none'],

  // turns
  'turns.title': ['driver 回合', 'Driver turns'],
  'turns.agent': ['agent', 'agent'],
  'turns.start': ['开始', 'Started'],
  'turns.duration': ['耗时', 'Duration'],
  'turns.msgs': ['消息数', 'Messages'],
  'turns.exit': ['结束原因', 'Exit'],
  'turns.recovered': ['恢复过', 'Recovered'],
  'turns.yes': ['是', 'yes'],
  'turns.empty': [
    '还没有回合。只有被总线托管的 agent 才有回合记录。',
    'No turns yet. Only hosted agents have turn records.',
  ],
  'unit.sec': ['{0} 秒', '{0}s'],
} as const

export type Key = keyof typeof dict

const KEY = 'agentbus.lang'
let current: Lang = (() => {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    // ignore
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
})()
const listeners = new Set<() => void>()

export function setLang(l: Lang): void {
  current = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    // ignore
  }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  for (const fn of listeners) fn()
}

export function getLang(): Lang {
  return current
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function translate(lang: Lang, key: Key, ...args: (string | number)[]): string {
  const pair = dict[key]
  let s: string = lang === 'zh' ? pair[0] : pair[1]
  args.forEach((a, i) => {
    s = s.replace(`{${i}}`, String(a))
  })
  return s
}

/** `const { t, lang } = useT()` — re-renders on language change. */
export function useT() {
  const lang = useSyncExternalStore(subscribe, getLang, getLang)
  const t = useCallback(
    (key: Key, ...args: (string | number)[]) => translate(lang, key, ...args),
    [lang],
  )
  return { t, lang, setLang }
}
