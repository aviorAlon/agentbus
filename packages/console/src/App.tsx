import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type AgentInfo,
  api,
  type Creds,
  type Delivery,
  type Message,
  openStream,
  type RoomInfo,
  type Snapshot,
  type StreamEvent,
  type Task,
  type TaskState,
} from './api'
import { type Key, useT } from './i18n'
import { useTheme } from './theme'

const TASK_COLUMNS: TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]
const CLOSED = ['completed', 'failed', 'canceled']
const taskKey = (s: TaskState): Key => `task.${s}` as Key
const stateKey = (s: AgentInfo['state']): Key => `state.${s}` as Key
const deliveryKey = (s: Delivery['state']): Key => `delivery.${s}` as Key

const fmtTime = (t: number | null | undefined) =>
  t
    ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—'
const roomTitle = (name: string) =>
  name.startsWith('dm:') ? name.slice(3).replace('|', '  ↔  ') : `# ${name}`
const dmName = (a: string, b: string) => {
  const [x, y] = [a, b].sort()
  return `dm:${x}|${y}`
}

function useAge() {
  const { t } = useT()
  return (from: number, now: number) => {
    const s = Math.max(0, Math.round((now - from) / 1000))
    const v =
      s < 60
        ? t('unit.s', s)
        : s < 3600
          ? t('unit.m', Math.round(s / 60))
          : t('unit.h', Math.round(s / 3600))
    return t('ago', v)
  }
}

function useCreds(): [Creds | null, (c: Creds | null) => void] {
  const [creds, setCreds] = useState<Creds | null>(() => {
    try {
      const raw = localStorage.getItem('agentbus.creds')
      return raw ? (JSON.parse(raw) as Creds) : null
    } catch {
      return null
    }
  })
  const set = (c: Creds | null) => {
    setCreds(c)
    try {
      if (c) localStorage.setItem('agentbus.creds', JSON.stringify(c))
      else localStorage.removeItem('agentbus.creds')
    } catch {
      // storage unavailable; session-only
    }
  }
  return [creds, set]
}

export function App() {
  const [creds, setCreds] = useCreds()
  if (!creds) return <Login onLogin={setCreds} />
  return <Console creds={creds} onLogout={() => setCreds(null)} />
}

// ----------------------------------------------------------------- chrome

function Switches() {
  const { lang, setLang, t } = useT()
  const { theme, toggle } = useTheme()
  return (
    <div className="switches">
      <button
        type="button"
        className="chip"
        onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
        title={t('nav.lang')}
      >
        {lang === 'zh' ? 'EN' : '中文'}
      </button>
      <button type="button" className="chip" onClick={toggle} title={t('nav.theme')}>
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </div>
  )
}

function Login({ onLogin }: { onLogin: (c: Creds) => void }) {
  const { t } = useT()
  const [name, setName] = useState('owner')
  const [token, setToken] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.snapshot({ name, token })
      onLogin({ name, token })
    } catch (ex) {
      setErr((ex as Error).message)
    }
  }
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="login-head">
          <span className="logo" />
          <div>
            <h1>{t('app.name')}</h1>
            <div className="muted">{t('app.tagline')}</div>
          </div>
          <Switches />
        </div>
        <p className="muted">{t('login.help')}</p>
        <label>
          <span>{t('login.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t('login.token')}</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        {err && <div className="err">{err}</div>}
        <button type="submit" className="btn primary">
          {t('login.enter')}
        </button>
      </form>
    </div>
  )
}

type View =
  | { kind: 'home' }
  | { kind: 'room'; room: string }
  | { kind: 'tasks' }
  | { kind: 'task'; id: string }
  | { kind: 'turns' }
  | { kind: 'join' }

function Console({ creds, onLogout }: { creds: Creds; onLogout: () => void }) {
  const { t } = useT()
  const age = useAge()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [stream, setStream] = useState<'open' | 'closed'>('closed')
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.snapshot(creds))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [creds])

  useEffect(() => {
    void refresh()
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => void refresh(), 15_000)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [refresh])

  useEffect(() => {
    return openStream(
      creds,
      (e: StreamEvent) => {
        if (e.type === 'hello') return
        setSnap((s) => {
          if (!s) return s
          if (e.event === 'presence') return { ...s, agents: e.agents }
          if (e.event === 'task') {
            const tasks = s.tasks.some((x) => x.id === e.task.id)
              ? s.tasks.map((x) => (x.id === e.task.id ? e.task : x))
              : [e.task, ...s.tasks]
            return { ...s, tasks }
          }
          if (e.event === 'message') {
            const rooms = s.rooms.some((r) => r.name === e.message.room)
              ? s.rooms.map((r) => (r.name === e.message.room ? { ...r, last: e.message } : r))
              : [
                  ...s.rooms,
                  {
                    name: e.message.room,
                    kind: e.message.room.startsWith('dm:') ? 'dm' : 'room',
                    paused: false,
                    members: [],
                    last: e.message,
                  } as RoomInfo,
                ]
            return { ...s, rooms }
          }
          if (e.event === 'system' && e.room && (e.kind === 'paused' || e.kind === 'resumed')) {
            return {
              ...s,
              rooms: s.rooms.map((r) =>
                r.name === e.room ? { ...r, paused: e.kind === 'paused' } : r,
              ),
            }
          }
          return s
        })
      },
      setStream,
    )
  }, [creds])

  const bots = useMemo(() => snap?.agents.filter((a) => a.authority !== 'human') ?? [], [snap])
  const humans = useMemo(() => snap?.agents.filter((a) => a.authority === 'human') ?? [], [snap])
  const openTasks = useMemo(
    () => snap?.tasks.filter((x) => !CLOSED.includes(x.state)) ?? [],
    [snap],
  )
  const rooms = useMemo(
    () =>
      [...(snap?.rooms ?? [])].sort(
        (a, b) => (b.last?.created_at ?? 0) - (a.last?.created_at ?? 0),
      ),
    [snap],
  )

  const title =
    view.kind === 'home'
      ? t('home.title')
      : view.kind === 'tasks'
        ? t('tasks.title')
        : view.kind === 'turns'
          ? t('turns.title')
          : view.kind === 'join'
            ? t('join.title')
            : view.kind === 'room'
              ? roomTitle(view.room)
              : view.id

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <button type="button" className="brand-btn" onClick={() => setView({ kind: 'home' })}>
            <span className="logo" />
            <span className="brand-name">{t('app.name')}</span>
          </button>
          <span
            className={`dot ${stream}`}
            title={stream === 'open' ? t('stream.open') : t('stream.closed')}
          />
        </div>

        <nav className="nav">
          <NavItem
            active={view.kind === 'home'}
            onClick={() => setView({ kind: 'home' })}
            icon="◎"
            label={t('nav.overview')}
          />
          <NavItem
            active={view.kind === 'tasks'}
            onClick={() => setView({ kind: 'tasks' })}
            icon="▤"
            label={t('nav.tasks')}
            count={openTasks.length}
          />
          <NavItem
            active={view.kind === 'turns'}
            onClick={() => setView({ kind: 'turns' })}
            icon="↻"
            label={t('nav.turns')}
          />
          <NavItem
            active={view.kind === 'join'}
            onClick={() => setView({ kind: 'join' })}
            icon="+"
            label={t('nav.join')}
            accent
          />
        </nav>

        <h3 className="side-h">
          {t('agents.title')}{' '}
          <span className="muted">
            {t('agents.online', bots.filter((a) => a.online).length, bots.length)}
          </span>
        </h3>
        <ul className="agents">
          {bots.map((a) => (
            <AgentRow
              key={a.name}
              a={a}
              onChat={() => setView({ kind: 'room', room: dmName(creds.name, a.name) })}
            />
          ))}
          {bots.length === 0 && <li className="muted empty">{t('agents.empty')}</li>}
          {humans.map((a) => (
            <AgentRow key={a.name} a={a} />
          ))}
        </ul>

        <h3 className="side-h">{t('rooms.title')}</h3>
        <ul className="rooms">
          {rooms.map((r) => (
            <li key={r.name}>
              <button
                type="button"
                className={`room ${view.kind === 'room' && view.room === r.name ? 'active' : ''}`}
                onClick={() => setView({ kind: 'room', room: r.name })}
              >
                <span className="room-line">
                  <span className="room-name">{roomTitle(r.name)}</span>
                  {r.paused && <span className="badge warn">{t('room.paused')}</span>}
                </span>
                {r.last && (
                  <span className="muted small preview">
                    <b>{r.last.from}</b> {r.last.text.replace(/\s+/g, ' ').slice(0, 48)} ·{' '}
                    {age(r.last.created_at, now)}
                  </span>
                )}
              </button>
            </li>
          ))}
          {rooms.length === 0 && <li className="muted empty">{t('rooms.empty')}</li>}
        </ul>

        <div className="side-foot">
          <span className="muted small">
            {t('you.are')} <b>{creds.name}</b>
          </span>
          <Switches />
          <button type="button" className="chip" onClick={onLogout} title={t('nav.logout')}>
            ⏻
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{title}</h2>
          {view.kind === 'room' && (
            <RoomActions creds={creds} room={view.room} snap={snap} onChanged={refresh} />
          )}
        </header>
        {error && <div className="err">{error}</div>}
        <div className="content">
          {view.kind === 'home' && snap && <Home snap={snap} now={now} onView={setView} />}
          {view.kind === 'join' && <JoinPanel creds={creds} onDone={refresh} />}
          {view.kind === 'tasks' && snap && (
            <TaskBoard
              tasks={snap.tasks}
              now={now}
              onOpen={(id) => setView({ kind: 'task', id })}
            />
          )}
          {view.kind === 'task' && (
            <TaskDetail
              creds={creds}
              id={view.id}
              onRoom={(room) => setView({ kind: 'room', room })}
            />
          )}
          {view.kind === 'room' && (
            <RoomView
              creds={creds}
              room={view.room}
              snap={snap}
              onTask={(id) => setView({ kind: 'task', id })}
            />
          )}
          {view.kind === 'turns' && snap && <Turns turns={snap.turns} />}
        </div>
      </main>
    </div>
  )
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  accent,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  count?: number
  accent?: boolean
}) {
  return (
    <button
      type="button"
      className={`nav-item ${active ? 'active' : ''} ${accent ? 'accent' : ''}`}
      onClick={onClick}
    >
      <span className="nav-icon">{icon}</span>
      <span>{label}</span>
      {count !== undefined && count > 0 && <span className="count">{count}</span>}
    </button>
  )
}

function AgentRow({ a, onChat }: { a: AgentInfo; onChat?: () => void }) {
  const { t } = useT()
  const state = a.online ? a.state : 'unknown'
  return (
    <li className={`agent ${a.online ? '' : 'offline'}`}>
      <span className={`state ${state}`} title={t(stateKey(state))} />
      <span className="name">{a.name}</span>
      <span className="muted small backend">{a.backend ?? a.authority}</span>
      {a.capabilities.driver && (
        <span className="badge" title={t('badge.driver.tip')}>
          {t('badge.driver')}
        </span>
      )}
      {a.authority === 'relayer' && (
        <span className="badge human" title={t('badge.relayer.tip')}>
          {t('badge.relayer')}
        </span>
      )}
      {a.authority === 'human' && <span className="badge human">{t('badge.human')}</span>}
      {a.capabilities.push && <span className="badge preview">{t('badge.push')}</span>}
      {onChat && (
        <button type="button" className="chip ghost" onClick={onChat}>
          {t('agents.dm')}
        </button>
      )}
    </li>
  )
}

// ----------------------------------------------------------------- views

function Home({ snap, now, onView }: { snap: Snapshot; now: number; onView: (v: View) => void }) {
  const { t } = useT()
  const age = useAge()
  const bots = snap.agents.filter((a) => a.authority !== 'human')
  const open = snap.tasks.filter((x) => !CLOSED.includes(x.state))
  const waiting = open.filter((x) => x.state === 'input-required')
  const paused = snap.rooms.filter((r) => r.paused)
  const last = snap.events.at(-1)
  return (
    <div className="home">
      <div className="tiles">
        <div className="tile">
          <div className="tile-n">{bots.filter((a) => a.online).length}</div>
          <div className="muted">
            {t('home.agentsOnline')} <span className="dim">· {t('home.of', bots.length)}</span>
          </div>
        </div>
        <button type="button" className="tile clickable" onClick={() => onView({ kind: 'tasks' })}>
          <div className="tile-n">{open.length}</div>
          <div className="muted">{t('home.openTasks')}</div>
        </button>
        <div className={`tile ${waiting.length ? 'warn' : ''}`}>
          <div className="tile-n">{waiting.length}</div>
          <div className="muted">{t('home.waiting')}</div>
        </div>
        <div className={`tile ${paused.length ? 'warn' : ''}`}>
          <div className="tile-n">{paused.length}</div>
          <div className="muted">{t('home.paused')}</div>
        </div>
      </div>

      {waiting.length > 0 && (
        <section className="panel">
          <h3>{t('home.needYou')}</h3>
          {waiting.map((x) => (
            <button
              type="button"
              key={x.id}
              className="card"
              onClick={() => onView({ kind: 'task', id: x.id })}
            >
              <div className="card-title">{x.description}</div>
              <div className="muted small">
                {t('home.waitingOn', x.to, x.from)} · {roomTitle(x.room)}
              </div>
            </button>
          ))}
        </section>
      )}
      {paused.length > 0 && (
        <section className="panel">
          <h3>{t('home.pausedRooms')}</h3>
          {paused.map((r) => (
            <button
              type="button"
              key={r.name}
              className="card"
              onClick={() => onView({ kind: 'room', room: r.name })}
            >
              <div className="card-title">{roomTitle(r.name)}</div>
              <div className="muted small">{t('home.pausedHint')}</div>
            </button>
          ))}
        </section>
      )}
      <section className="panel">
        <h3>{t('home.howto')}</h3>
        <ol className="howto">
          <li>{t('home.step1')}</li>
          <li>{t('home.step2')}</li>
          <li>{t('home.step3')}</li>
        </ol>
        <div className="muted small">
          {t('home.lastActivity')}: {last ? `${last.kind} · ${age(last.at, now)}` : t('none')}
        </div>
      </section>
    </div>
  )
}

function JoinPanel({ creds, onDone }: { creds: Creds; onDone: () => void }) {
  const { t } = useT()
  const [where, setWhere] = useState<'local' | 'remote'>('local')
  const [host, setHost] = useState<'claude' | 'codex'>('claude')
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ name: string; steps: string[]; next: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      setResult(
        await api.join(creds, {
          host,
          dir: dir.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      )
      onDone()
    } catch (ex) {
      setErr((ex as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const cmd = `agentbus join --${host}${name.trim() ? ` --name ${name.trim()}` : ''}`
  return (
    <div className="join">
      <p className="muted">{t('join.help')}</p>
      <div className="seg where">
        <button
          type="button"
          className={where === 'local' ? 'on' : ''}
          onClick={() => setWhere('local')}
        >
          {t('join.local')}
        </button>
        <button
          type="button"
          className={where === 'remote' ? 'on' : ''}
          onClick={() => setWhere('remote')}
        >
          {t('join.remote')}
        </button>
      </div>
      {where === 'remote' && <RemoteJoin creds={creds} host={host} setHost={setHost} />}
      {where === 'local' && (
        <>
          <p className="muted small">
            {t('join.sameMachine')} <code>{cmd}</code>
          </p>
          <form onSubmit={submit} className="form panel">
            <label>
              <span>{t('join.host')}</span>
              <div className="seg">
                <button
                  type="button"
                  className={host === 'claude' ? 'on' : ''}
                  onClick={() => setHost('claude')}
                >
                  Claude Code
                </button>
                <button
                  type="button"
                  className={host === 'codex' ? 'on' : ''}
                  onClick={() => setHost('codex')}
                >
                  Codex
                </button>
              </div>
            </label>
            <label>
              <span>{t('join.dir')}</span>
              <input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="D:\work\frontend"
                required
              />
            </label>
            <label>
              <span>
                {t('join.name')} <span className="muted small">({t('join.nameHint')})</span>
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="frontend"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn primary" disabled={busy || !dir.trim()}>
                {busy ? t('join.busy') : t('join.go')}
              </button>
            </div>
          </form>
          {err && <div className="err">{err}</div>}
          {result && (
            <div className="panel ok">
              <h3>{t('join.done', result.name)}</h3>
              <ul className="steps">
                {result.steps.map((s) => (
                  <li key={s} className="muted small">
                    {s}
                  </li>
                ))}
              </ul>
              <div className="hint">{result.next}</div>
            </div>
          )}
        </>
      )}
      <h3>{t('join.leave.title')}</h3>
      <p className="muted small">{t('join.leave.help', `agentbus leave --${host}`)}</p>
    </div>
  )
}

/** Another machine: the console cannot touch its files, so it hands out a one-time command. */
function RemoteJoin({
  creds,
  host,
  setHost,
}: {
  creds: Creds
  host: 'claude' | 'codex'
  setHost: (h: 'claude' | 'codex') => void
}) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [info, setInfo] = useState<{ bus: string; http: string } | null>(null)
  const [cmd, setCmd] = useState<{ text: string; expires: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    api.info(creds).then(setInfo, (e) => setErr((e as Error).message))
  }, [creds])
  const gen = async () => {
    setErr(null)
    try {
      const inv = await api.invite(creds, name.trim() ? { name: name.trim() } : {})
      const bus = info?.bus ?? 'ws://<bus-host>:7777/ws'
      setCmd({
        text: `agentbus join --${host} --bus ${bus} --invite ${inv.code}${inv.name ? ` --name ${inv.name}` : ''}`,
        expires: inv.expires_at,
      })
      setCopied(false)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const copy = async () => {
    if (!cmd) return
    try {
      await navigator.clipboard.writeText(cmd.text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="panel remote">
      <p className="muted small">{t('join.remote.help')}</p>
      <div className="form">
        <label>
          <span>{t('join.host')}</span>
          <div className="seg">
            <button
              type="button"
              className={host === 'claude' ? 'on' : ''}
              onClick={() => setHost('claude')}
            >
              Claude Code
            </button>
            <button
              type="button"
              className={host === 'codex' ? 'on' : ''}
              onClick={() => setHost('codex')}
            >
              Codex
            </button>
          </div>
        </label>
        <label>
          <span>{t('join.remote.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="backend" />
        </label>
        <div className="form-actions">
          <button type="button" className="btn primary" onClick={() => void gen()}>
            {t('join.gen')}
          </button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {cmd && (
        <div className="cmdbox">
          <code className="cmd">{cmd.text}</code>
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? t('join.copied') : t('join.copy')}
          </button>
          <div className="muted small">
            {t('join.validUntil', new Date(cmd.expires).toLocaleString())}
          </div>
          <div className="muted small">{t('join.remote.steps', info?.http ?? '')}</div>
        </div>
      )}
    </div>
  )
}

function TaskBoard({
  tasks,
  now,
  onOpen,
}: {
  tasks: Task[]
  now: number
  onOpen: (id: string) => void
}) {
  const { t } = useT()
  const age = useAge()
  return (
    <div className="board">
      {TASK_COLUMNS.map((col) => (
        <section key={col} className={`col ${col}`}>
          <h4>
            {t(taskKey(col))}{' '}
            <span className="count">{tasks.filter((x) => x.state === col).length}</span>
          </h4>
          {tasks
            .filter((x) => x.state === col)
            .sort((a, b) => b.updated_at - a.updated_at)
            .map((x) => (
              <button type="button" key={x.id} className="card" onClick={() => onOpen(x.id)}>
                <div className="card-title">{x.description}</div>
                <div className="muted small">
                  {x.from} → {x.to} · {roomTitle(x.room)}
                </div>
                <div className="muted small">
                  {t('task.turns', x.turns_used, x.max_turns ?? '∞')}
                  {x.deadline && !CLOSED.includes(x.state) && (
                    <>
                      {' '}
                      ·{' '}
                      {x.deadline > now
                        ? t('task.left', age(now, x.deadline).replace(/前$| ago$/, ''))
                        : t('task.overdue')}
                    </>
                  )}
                  {x.artifacts.length > 0 && <> · {t('task.files', x.artifacts.length)}</>}
                </div>
                {x.escalated && <span className="badge warn">{t('task.escalated')}</span>}
                {x.summary && <div className="summary">{x.summary}</div>}
              </button>
            ))}
        </section>
      ))}
    </div>
  )
}

function TaskDetail({
  creds,
  id,
  onRoom,
}: {
  creds: Creds
  id: string
  onRoom: (room: string) => void
}) {
  const { t } = useT()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.task>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(
    () => api.task(creds, id).then(setData, (e) => setErr((e as Error).message)),
    [creds, id],
  )
  useEffect(() => {
    void load()
  }, [load])
  if (err) return <div className="err">{err}</div>
  if (!data) return <div className="muted">{t('loading')}</div>
  const x = data.task
  return (
    <div className="detail">
      <div className="detail-head">
        <span className={`pill ${x.state}`}>{t(taskKey(x.state))}</span>
        <span className="detail-title">{x.description}</span>
        {!CLOSED.includes(x.state) && (
          <button
            type="button"
            className="btn danger"
            onClick={() => void api.cancelTask(creds, x.id, t('task.cancel.reason')).then(load)}
          >
            {t('task.cancel')}
          </button>
        )}
      </div>
      {x.state === 'input-required' && (
        <div className="hint">
          {t('task.waitHint', x.to, '')}
          <button type="button" className="link" onClick={() => onRoom(x.room)}>
            {roomTitle(x.room)}
          </button>
        </div>
      )}
      <dl className="panel">
        <dt>{t('task.id')}</dt>
        <dd>
          <code>{x.id}</code>
        </dd>
        <dt>{t('task.route')}</dt>
        <dd>
          {x.from} → {x.to} {t('task.in')}{' '}
          <button type="button" className="link" onClick={() => onRoom(x.room)}>
            {roomTitle(x.room)}
          </button>
        </dd>
        {x.context && (
          <>
            <dt>{t('task.context')}</dt>
            <dd>{x.context}</dd>
          </>
        )}
        <dt>{t('task.budget')}</dt>
        <dd>
          {t(
            'task.budget.v',
            x.turns_used,
            x.max_turns ?? '∞',
            x.deadline ? new Date(x.deadline).toLocaleString() : t('task.noDeadline'),
          )}
        </dd>
        {x.summary && (
          <>
            <dt>{t('task.result')}</dt>
            <dd>{x.summary}</dd>
          </>
        )}
        {x.artifacts.length > 0 && (
          <>
            <dt>{t('task.artifacts')}</dt>
            <dd>
              {x.artifacts.map((b) => (
                <div key={b.id}>
                  📎 {b.name}{' '}
                  <span className="muted small">
                    {b.size} B · {b.id.slice(0, 12)} · {t('task.artifactHint')}
                  </span>
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
      <h3>{t('task.events')}</h3>
      <table className="table">
        <tbody>
          {data.events.map((e) => (
            <tr key={`${e.at}-${e.to_state}`}>
              <td className="muted">{fmtTime(e.at)}</td>
              <td>
                {e.from_state ? t(taskKey(e.from_state)) : '·'} → <b>{t(taskKey(e.to_state))}</b>
              </td>
              <td>{e.by}</td>
              <td>{e.summary ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RoomActions({
  creds,
  room,
  snap,
  onChanged,
}: {
  creds: Creds
  room: string
  snap: Snapshot | null
  onChanged: () => void
}) {
  const { t } = useT()
  const info = snap?.rooms.find((r) => r.name === room)
  if (!info) return null
  return (
    <div className="topbar-actions">
      <span className="muted small">
        {t('room.members')}: {info.members.join(', ')}
      </span>
      {info.paused ? (
        <button
          type="button"
          className="btn primary"
          onClick={() => void api.resume(creds, room).then(onChanged)}
        >
          {t('room.resume')}
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => void api.pause(creds, room).then(onChanged)}
          title={t('room.pause.tip')}
        >
          {t('room.pause')}
        </button>
      )}
    </div>
  )
}

function RoomView({
  creds,
  room,
  snap,
  onTask,
}: {
  creds: Creds
  room: string
  snap: Snapshot | null
  onTask: (id: string) => void
}) {
  const { t } = useT()
  const [messages, setMessages] = useState<Message[]>([])
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({})
  const [err, setErr] = useState<string | null>(null)
  const [replyTask, setReplyTask] = useState<string | null>(null)
  const load = useCallback(() => {
    api.room(creds, room).then(
      (r) => {
        setMessages(r.messages)
        setDeliveries(r.deliveries)
        setErr(null)
      },
      (e) => setErr((e as Error).message),
    )
  }, [creds, room])
  useEffect(load, [load])
  const last = snap?.rooms.find((r) => r.name === room)?.last?.id
  useEffect(() => {
    if (last && !messages.some((m) => m.id === last)) load()
  }, [last, messages, load])
  const info = snap?.rooms.find((r) => r.name === room)
  const agentByName = new Map((snap?.agents ?? []).map((a) => [a.name, a]))

  return (
    <div className="room-view">
      {info?.paused && <div className="hint">{t('home.pausedHint')}</div>}
      {err && <div className="err">{err}</div>}
      <ol className="messages">
        {messages.map((m) => {
          const mine = m.from === creds.name
          const a = agentByName.get(m.from)
          return (
            <li key={m.id} className={`msg ${m.authority} ${mine ? 'mine' : ''}`}>
              <div className="meta">
                <b className="from">{m.from}</b>
                {m.authority === 'human' && <span className="badge human">{t('badge.human')}</span>}
                {m.authority === 'relayer' && (
                  <span className="badge human">{t('badge.relayer')}</span>
                )}
                {a?.capabilities.driver && <span className="badge">{t('badge.driver')}</span>}
                <span className="muted small">
                  #{m.id} · {fmtTime(m.created_at)}
                </span>
                {m.task_id && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => onTask(m.task_id as string)}
                  >
                    {t('msg.task', m.task_id)}
                  </button>
                )}
              </div>
              <div className="text">{m.text}</div>
              {m.blobs?.map((b) => (
                <div key={b.id} className="muted small">
                  📎 {b.name} ({b.size} B)
                </div>
              ))}
              <div className="deliveries">
                {(deliveries[String(m.id)] ?? []).map((d) => (
                  <span
                    key={d.recipient}
                    className={`dl ${d.state}`}
                    title={t(
                      'delivery.tip',
                      d.via,
                      fmtTime(d.written_at),
                      fmtTime(d.seen_at),
                      fmtTime(d.handled_at),
                    )}
                  >
                    {d.recipient} · {t(deliveryKey(d.state))}
                  </span>
                ))}
                {m.task_id && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => setReplyTask(m.task_id as string)}
                  >
                    {t('msg.replyInTask')}
                  </button>
                )}
              </div>
            </li>
          )
        })}
        {messages.length === 0 && <li className="muted empty">{t('room.empty')}</li>}
      </ol>
      <ReplyBox
        creds={creds}
        room={room}
        taskId={replyTask}
        onClearTask={() => setReplyTask(null)}
        onSent={load}
      />
    </div>
  )
}

/** Speak as the signed-in human: for a driver-held agent this is its terminal (§4.6). */
function ReplyBox({
  creds,
  room,
  taskId,
  onClearTask,
  onSent,
}: {
  creds: Creds
  room: string
  taskId: string | null
  onClearTask: () => void
  onSent: () => void
}) {
  const { t } = useT()
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    try {
      await api.send(creds, room, text.trim(), taskId ?? undefined)
      setText('')
      setErr(null)
      onSent()
    } catch (ex) {
      setErr((ex as Error).message)
    }
  }
  return (
    <form className="reply" onSubmit={submit}>
      {taskId && (
        <span className="badge">
          {t('reply.taskTag', taskId)}{' '}
          <button type="button" className="link small" onClick={onClearTask}>
            ×
          </button>
        </span>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('reply.placeholder', creds.name)}
      />
      <button type="submit" className="btn primary">
        {t('reply.send')}
      </button>
      {err && <span className="err inline">{err}</span>}
    </form>
  )
}

function Turns({ turns }: { turns: Snapshot['turns'] }) {
  const { t } = useT()
  return (
    <table className="table panel">
      <thead>
        <tr>
          <th>{t('turns.agent')}</th>
          <th>{t('turns.start')}</th>
          <th>{t('turns.duration')}</th>
          <th>{t('turns.msgs')}</th>
          <th>{t('turns.exit')}</th>
          <th>{t('turns.recovered')}</th>
        </tr>
      </thead>
      <tbody>
        {turns.map((x) => (
          <tr key={x.id}>
            <td>{x.agent}</td>
            <td>{fmtTime(x.started_at)}</td>
            <td>
              {x.ended_at ? t('unit.sec', ((x.ended_at - x.started_at) / 1000).toFixed(1)) : '…'}
            </td>
            <td>{x.message_ids.length}</td>
            <td>{x.exit_reason}</td>
            <td>{x.recovered ? t('turns.yes') : ''}</td>
          </tr>
        ))}
        {turns.length === 0 && (
          <tr>
            <td colSpan={6} className="muted">
              {t('turns.empty')}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
