import type { Store } from '../store/store.js'

/**
 * Prometheus text exposition (PRODUCT_DESIGN F-O4). Everything is derived from the store
 * on request: no in-memory counters to drift from the durable record.
 */
export function renderMetrics(
  store: Store,
  extra: { consoleClients: number; online: number },
): string {
  const db = store.db
  const lines: string[] = []
  const gauge = (
    name: string,
    help: string,
    rows: { labels?: Record<string, string>; value: number }[],
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
    for (const r of rows) {
      const l = r.labels
        ? `{${Object.entries(r.labels)
            .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
            .join(',')}}`
        : ''
      lines.push(`${name}${l} ${r.value}`)
    }
  }
  const count = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...args) as { n: number }).n

  gauge('agentbus_agents_online', 'Agents with a live control connection', [
    { value: extra.online },
  ])
  gauge('agentbus_console_clients', 'Open console streams', [{ value: extra.consoleClients }])
  gauge('agentbus_messages_total', 'Messages stored', [
    { value: count('SELECT COUNT(*) AS n FROM messages') },
  ])

  const byVia = db
    .prepare(
      `SELECT via, CASE WHEN handled_at IS NOT NULL THEN 'handled' WHEN seen_at IS NOT NULL THEN 'seen' ELSE 'written' END AS state, COUNT(*) AS n
       FROM deliveries GROUP BY via, state`,
    )
    .all() as { via: string; state: string; n: number }[]
  gauge(
    'agentbus_deliveries_total',
    'Deliveries by path and state',
    byVia.map((r) => ({ labels: { via: r.via, state: r.state }, value: r.n })),
  )

  const pending = db
    .prepare(
      'SELECT recipient, COUNT(*) AS n FROM deliveries WHERE seen_at IS NULL AND error IS NULL GROUP BY recipient',
    )
    .all() as { recipient: string; n: number }[]
  gauge(
    'agentbus_mailbox_pending',
    'Unseen deliveries per recipient',
    pending.map((r) => ({ labels: { agent: r.recipient }, value: r.n })),
  )

  const dropped = db
    .prepare('SELECT error, COUNT(*) AS n FROM deliveries WHERE error IS NOT NULL GROUP BY error')
    .all() as { error: string; n: number }[]
  gauge(
    'agentbus_deliveries_dropped_total',
    'Deliveries dropped by reason',
    dropped.map((r) => ({ labels: { reason: r.error }, value: r.n })),
  )

  gauge('agentbus_push_degraded_total', 'Push deliveries that fell back to another path', [
    { value: count("SELECT COUNT(*) AS n FROM deliveries WHERE via LIKE 'push->%'") },
  ])

  const seenLat = db
    .prepare(
      `SELECT via, AVG(seen_at - written_at) AS avg_ms, MAX(seen_at - written_at) AS max_ms
       FROM deliveries WHERE seen_at IS NOT NULL GROUP BY via`,
    )
    .all() as { via: string; avg_ms: number; max_ms: number }[]
  gauge('agentbus_delivery_seen_latency_ms', 'written→seen latency by path', [
    ...seenLat.map((r) => ({ labels: { via: r.via, stat: 'avg' }, value: Math.round(r.avg_ms) })),
    ...seenLat.map((r) => ({ labels: { via: r.via, stat: 'max' }, value: r.max_ms })),
  ])

  const turns = db
    .prepare(
      `SELECT exit_reason, recovered, COUNT(*) AS n FROM driver_turns GROUP BY exit_reason, recovered`,
    )
    .all() as { exit_reason: string | null; recovered: number; n: number }[]
  gauge(
    'agentbus_driver_turns_total',
    'Driver turns by exit reason',
    turns.map((r) => ({
      labels: { exit: r.exit_reason ?? 'unknown', recovered: String(r.recovered === 1) },
      value: r.n,
    })),
  )

  const events = db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all() as {
    kind: string
    n: number
  }[]
  gauge(
    'agentbus_events_total',
    'Audit events by kind (paused, resumed, takeover, undeliverable, task_budget, ...)',
    events.map((r) => ({ labels: { kind: r.kind }, value: r.n })),
  )

  const tasks = db.prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state').all() as {
    state: string
    n: number
  }[]
  gauge(
    'agentbus_tasks_total',
    'Tasks by state',
    tasks.map((r) => ({ labels: { state: r.state }, value: r.n })),
  )
  gauge('agentbus_tasks_budget_failed_total', 'Tasks failed by budget (deadline / max_turns)', [
    {
      value: count(
        "SELECT COUNT(*) AS n FROM tasks WHERE state = 'failed' AND summary LIKE 'budget:%'",
      ),
    },
  ])
  gauge('agentbus_rooms_paused', 'Rooms currently paused by the exchange guard', [
    { value: count('SELECT COUNT(*) AS n FROM rooms WHERE paused = 1') },
  ])
  gauge('agentbus_blob_bytes', 'Bytes held in the blob store', [{ value: store.totalBlobBytes() }])
  return `${lines.join('\n')}\n`
}
