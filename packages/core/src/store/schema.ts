/** SQLite schema (PRODUCT_DESIGN §5.4). All statements are idempotent. */
export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  name              TEXT PRIMARY KEY,
  backend           TEXT,
  authority         TEXT NOT NULL DEFAULT 'bot',
  token_hash        TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{"inbox":false,"push":false}',
  cwd               TEXT,
  session_id        TEXT,
  online            INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'unknown',
  status_text       TEXT,
  state_at          INTEGER,
  activity_at       INTEGER,
  last_seen         INTEGER,
  version           TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  name       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,              -- 'dm' | 'room'
  paused     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room       TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (room, agent_name)
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room         TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
  from_agent   TEXT NOT NULL,
  authority    TEXT NOT NULL,
  text         TEXT NOT NULL,
  payload_json TEXT,
  task_id      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room, id);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS blobs (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mime       TEXT,
  created_at INTEGER NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_blobs (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  blob_id    TEXT NOT NULL REFERENCES blobs(sha256),
  name       TEXT NOT NULL,
  PRIMARY KEY (message_id, blob_id)
);

CREATE TABLE IF NOT EXISTS cursors (
  agent_name   TEXT NOT NULL,
  room         TEXT NOT NULL,
  last_seen_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_name, room)
);

-- Newest via=standby row the interactive session has been shown, per room (shown once).
CREATE TABLE IF NOT EXISTS standby_cursors (
  agent_name   TEXT NOT NULL,
  room         TEXT NOT NULL,
  last_seen_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_name, room)
);

CREATE TABLE IF NOT EXISTS deliveries (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient  TEXT NOT NULL,
  via        TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  seen_at    INTEGER,
  handled_at INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  PRIMARY KEY (message_id, recipient)
);
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(recipient, message_id) WHERE seen_at IS NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  room           TEXT NOT NULL,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  state          TEXT NOT NULL,
  description    TEXT NOT NULL,
  context        TEXT,
  deadline       INTEGER,
  max_turns      INTEGER,
  turns_used     INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  escalated      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, updated_at);
CREATE INDEX IF NOT EXISTS tasks_to ON tasks(to_agent, state);

CREATE TABLE IF NOT EXISTS task_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  by_agent       TEXT NOT NULL,
  summary        TEXT,
  artifacts_json TEXT,
  at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_turns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent            TEXT NOT NULL,
  session_id       TEXT,
  message_ids_json TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  tokens           INTEGER,
  sent             INTEGER NOT NULL DEFAULT 0,
  exit_reason      TEXT,
  recovered        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invites (
  code_hash  TEXT PRIMARY KEY,
  name       TEXT,                      -- bound agent name, or NULL = redeemer picks
  authority  TEXT NOT NULL DEFAULT 'relayer',
  backend    TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  agent       TEXT,
  room        TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_room ON events(room, id);
`
