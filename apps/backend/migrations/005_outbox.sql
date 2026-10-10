create table outbox (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  type text not null check (type in ('booking_confirmed', 'refund_issued')),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'sent', 'dead')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (booking_id, type)          -- one "confirmed" note per booking, ever
);

create index outbox_pending on outbox (created_at) where status = 'pending';

-- proof of what was actually sent, one row per message per channel
create table notification_log (
  outbox_id uuid not null references outbox(id),
  channel text not null check (channel in ('sms', 'email')),
  recipient text not null,
  body text not null,
  sent_at timestamptz not null default now(),
  primary key (outbox_id, channel)
);