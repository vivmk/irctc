create table bookings (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  run_id int not null references train_runs(id),
  class text not null,
  first_segment int not null,
  last_segment int not null,
  stage text not null check (stage in (
    'started','seats_held','payment_pending','confirmed',
    'waitlisted','payment_failed','expired','cancelled')),
  hold_expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (last_segment >= first_segment)
);

create table booking_passengers (
  booking_id uuid not null references bookings(id),
  position int not null,
  name text not null,
  age int not null check (age between 0 and 120),
  gender text not null check (gender in ('male','female','other')),
  coach_code text not null,
  seat_number int not null,
  primary key (booking_id, position)
);

alter table seat_segments
  add constraint seat_segments_booking_fk
  foreign key (booking_id) references bookings(id);

create index seat_segments_booking on seat_segments (booking_id);