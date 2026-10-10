-- OUR record of each payment
create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  amount_paise int not null check (amount_paise > 0),
  status text not null check (status in
    ('initiated','succeeded','failed','refund_pending','refunded')),
  provider_ref text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The FAKE BANK's own books (in real life this lives at the bank, not with us)
create table fake_bank_transactions (
  ref text primary key,
  amount_paise int not null,
  status text not null default 'pending'
    check (status in ('pending','paid','failed','refunded')),
  created_at timestamptz not null default now()
);

-- The bouncer inside the database: only allowed stage moves get through
create function enforce_booking_stage() returns trigger as $$
begin
  if new.stage = old.stage then return new; end if;
  if (old.stage, new.stage) in (
    ('started','seats_held'),
    ('seats_held','payment_pending'), ('seats_held','expired'),
    ('payment_pending','confirmed'), ('payment_pending','waitlisted'),
    ('payment_pending','payment_failed'), ('payment_pending','expired'),
    ('confirmed','cancelled'),
    ('waitlisted','confirmed'), ('waitlisted','cancelled')
  ) then
    return new;
  end if;
  raise exception 'illegal booking stage move: % -> %', old.stage, new.stage;
end;
$$ language plpgsql;

create trigger booking_stage_guard
  before update of stage on bookings
  for each row execute function enforce_booking_stage();