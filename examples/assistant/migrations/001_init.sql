-- The app's tables, in the schema the connection's search_path names (`assistant`, or a test schema).
-- Sessions and entries are `json`, not `jsonb`, so each object keeps its key order, as docs/spec/sessions.md asks.

create table sessions (
  agent text not null,
  id text not null,
  header json not null,
  primary key (agent, id)
);

create table entries (
  agent text not null,
  session text not null,
  seq bigint generated always as identity,
  entry json not null,
  primary key (agent, session, seq),
  foreign key (agent, session) references sessions (agent, id)
);

create table docs (
  agent text not null,
  name text not null,
  version int not null,
  body text not null,
  summary text not null,
  pinned boolean not null,
  written_at timestamptz not null,
  written_by text not null,
  primary key (agent, name, version)
);

-- What an agent proposes to send, and what the person decided.
create table proposals (
  id text primary key,
  agent text not null,
  kind text not null,
  input json not null,
  reason text not null,
  session text not null,
  call_id text not null,
  status text not null default 'pending',
  decided_input json,
  note text,
  result text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- In demo mode, an accepted proposal lands here instead of in Gmail or Calendar.
create table outbox (
  id bigint generated always as identity primary key,
  agent text not null,
  kind text not null,
  input json not null,
  sent_at timestamptz not null default now()
);

-- Who may sign in. In demo mode, the two invented people; with Google, each allowed address that
-- has signed in, with the token that lets the app read their mail and calendar.
create table people (
  id text primary key,
  email text not null unique,
  name text not null,
  google_token json
);

-- Signed-in browsers: a random token in a cookie, pointing at a person.
create table logins (
  token text primary key,
  person text not null references people (id),
  created_at timestamptz not null default now()
);
