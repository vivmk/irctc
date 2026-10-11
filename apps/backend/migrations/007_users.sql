create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,          -- always stored lowercase
  phone text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,         -- fingerprint of the token, never the token itself
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user on sessions (user_id);

-- nullable so bookings made before accounts existed stay valid (nobody owns them)
alter table bookings add column user_id uuid references users(id);
create index bookings_user on bookings (user_id, created_at desc);