-- ============================================================
-- W.E.D.N.E.S.D.A.Y STUDY — Supabase schema
-- ============================================================
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- It is idempotent: safe to re-run after pulling changes.
--
-- The server connects with the SERVICE ROLE key, which bypasses Row Level
-- Security. RLS is still enabled below (with no policies) so that the public
-- anon key cannot read any of these tables directly from a browser.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
create table if not exists users (
  email             text primary key,
  password_hash     text not null,
  verified          boolean not null default false,
  username          text unique,
  avatar            text,
  code              text,
  code_expires_at   timestamptz,
  code_attempts     integer not null default 0,
  is_premium        boolean not null default false,
  premium_since     timestamptz,
  created_at        timestamptz not null default now()
);

-- Upgrade path for databases created by an earlier version of the app.
alter table users add column if not exists code_attempts  integer not null default 0;
alter table users add column if not exists is_premium     boolean not null default false;
alter table users add column if not exists premium_since  timestamptz;
alter table users add column if not exists created_at     timestamptz not null default now();

-- Case-insensitive username lookup (login accepts email OR username).
create unique index if not exists users_username_lower_idx on users (lower(username));

-- ------------------------------------------------------------
-- sessions (opaque auth tokens; stored hashed by the server)
-- ------------------------------------------------------------
create table if not exists sessions (
  token       text primary key,
  email       text not null references users(email) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists sessions_email_idx      on sessions (email);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

-- ------------------------------------------------------------
-- chat_sessions / chat_messages
-- ------------------------------------------------------------
create table if not exists chat_sessions (
  id          text primary key,
  user_email  text not null references users(email) on delete cascade,
  subject     text not null default 'General',
  title       text not null default 'New chat',
  updated_at  timestamptz not null default now()
);

create index if not exists chat_sessions_user_idx on chat_sessions (user_email, updated_at desc);

create table if not exists chat_messages (
  id          bigserial primary key,
  session_id  text references chat_sessions(id) on delete cascade,
  user_email  text not null references users(email) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  model       text,
  timestamp   bigint
);

create index if not exists chat_messages_session_idx on chat_messages (session_id, id);
create index if not exists chat_messages_user_idx    on chat_messages (user_email, id);

-- ------------------------------------------------------------
-- flashcards (SM-2 spaced repetition state)
-- ------------------------------------------------------------
create table if not exists flashcards (
  id               text primary key,
  user_email       text not null references users(email) on delete cascade,
  subject          text not null default 'General',
  front            text not null,
  back             text not null,
  ef               double precision not null default 2.5,
  repetitions      integer not null default 0,
  interval         integer not null default 1,
  next_review      timestamptz not null default now(),
  last_reviewed    timestamptz,
  correct_count    integer not null default 0,
  incorrect_count  integer not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists flashcards_user_idx    on flashcards (user_email);
create index if not exists flashcards_due_idx     on flashcards (user_email, next_review);

-- ------------------------------------------------------------
-- progress (one row per user)
-- ------------------------------------------------------------
create table if not exists progress (
  user_email        text primary key references users(email) on delete cascade,
  global_streak     integer not null default 0,
  last_study_date   date,
  subjects          jsonb not null default '{}'::jsonb,
  total_xp          integer not null default 0,
  updated_at        timestamptz not null default now()
);

create index if not exists progress_total_xp_idx on progress (total_xp desc);

-- ------------------------------------------------------------
-- quiz_attempts
-- Server-side quiz grading. The server generates the questions, keeps the
-- answer key here, and grades the submitted answers itself, so XP can no
-- longer be claimed by POSTing a fake score to the client.
-- ------------------------------------------------------------
create table if not exists quiz_attempts (
  id            text primary key,
  user_email    text not null references users(email) on delete cascade,
  subject       text not null default 'General',
  questions     jsonb not null,          -- full question objects incl. correctIndex
  created_at    timestamptz not null default now(),
  consumed_at   timestamptz,             -- set when graded; attempts are single-use
  score         integer,
  total         integer
);

create index if not exists quiz_attempts_user_idx    on quiz_attempts (user_email, created_at desc);
create index if not exists quiz_attempts_created_idx on quiz_attempts (created_at);

-- ------------------------------------------------------------
-- leaderboard_cache (single row, id = 'global')
-- ------------------------------------------------------------
create table if not exists leaderboard_cache (
  id            text primary key,
  entries       jsonb not null default '[]'::jsonb,
  generated_at  timestamptz not null default now()
);

-- ============================================================
-- Row Level Security
-- Enabled with no policies: the service role key the server uses bypasses RLS,
-- while the public anon key (if ever exposed) gets nothing.
-- ============================================================
alter table users             enable row level security;
alter table sessions          enable row level security;
alter table chat_sessions     enable row level security;
alter table chat_messages     enable row level security;
alter table flashcards        enable row level security;
alter table progress          enable row level security;
alter table quiz_attempts     enable row level security;
alter table leaderboard_cache enable row level security;

-- ============================================================
-- Storage: public bucket for profile pictures
-- ============================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Avatars are written by the server with the service role key, so no storage
-- policies are required for uploads. This policy only makes the objects
-- readable by URL, which the app needs to display them.
drop policy if exists "avatars are publicly readable" on storage.objects;
create policy "avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');
