create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  created_at timestamptz default now()
);

create table if not exists daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  date date not null,
  habits jsonb default '{}'::jsonb,
  score integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, date)
);

create table if not exists wins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  date date not null,
  objectives jsonb default '{}'::jsonb,
  win text,
  lesson text,
  courage text,
  gratitude text,
  reflection text,
  created_at timestamptz default now(),
  unique(user_id, date)
);

create table if not exists missions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  label text not null,
  target numeric not null,
  current numeric default 0,
  unit text,
  domain text,
  color text,
  created_at timestamptz default now()
);

create table if not exists streaks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  habit_id text not null,
  current_streak integer default 0,
  longest_streak integer default 0,
  last_logged date,
  unique(user_id, habit_id)
);

create table if not exists wisdom (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  text text not null,
  source text,
  tags text[],
  created_at timestamptz default now()
);
