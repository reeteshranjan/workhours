CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 100),
  status     TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);
-- R1.2: unique across all projects, active and closed, ignoring case
CREATE UNIQUE INDEX uq_name ON projects(name COLLATE NOCASE);

-- One row per stretch of work
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,                         -- NULL = running now
  end_reason TEXT CHECK (end_reason IN
             ('switch','break','reset','close',                    -- user actions
              'tab_closed','sleep','stopped','locked','idle')),    -- automatic pauses
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_sessions_project ON sessions(project_id, started_at);
-- R2.1: the database itself allows at most ONE running session
CREATE UNIQUE INDEX one_running ON sessions((ended_at IS NULL)) WHERE ended_at IS NULL;

-- R3: billing checkpoints, kept forever
CREATE TABLE resets (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  reset_at   INTEGER NOT NULL,
  minutes    INTEGER NOT NULL CHECK (minutes >= 1)   -- whole minutes entered in the client's system
);
CREATE INDEX ix_resets_project ON resets(project_id, reset_at);

-- R4: manual corrections
CREATE TABLE adjustments (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  created_at INTEGER NOT NULL,
  minutes    INTEGER NOT NULL CHECK (minutes <> 0),  -- positive adds, negative removes
  reason     TEXT    NOT NULL CHECK (reason = trim(reason) AND length(reason) BETWEEN 1 AND 200)
);
CREATE INDEX ix_adjustments_project ON adjustments(project_id, created_at);

-- R6: automatic pauses waiting for the user's choice
CREATE TABLE auto_pauses (
  session_id  INTEGER PRIMARY KEY REFERENCES sessions(id),  -- the session that was ended
  detected_at INTEGER NOT NULL,     -- when the app noticed (sessions.ended_at holds the backdated time)
  returned_at INTEGER,              -- when the user came back ("away 45m")
  resolution  TEXT CHECK (resolution IN ('counted','resumed','dismissed','withdrawn')),
  resolved_at INTEGER
);

-- Key/value: last_action (backdate window), last_alive_at, checkin_minutes (5|10|15, default 10), volume
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
