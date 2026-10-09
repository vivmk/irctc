create table train_runs (
  id serial primary key,
  train_id int not null references trains(id),
  journey_date date not null,
  unique (train_id, journey_date)
);

create table seat_segments (
  run_id int not null references train_runs(id),
  coach_code text not null,
  seat_number int not null,
  segment_no int not null check (segment_no >= 1),
  status text not null default 'free'
    check (status in ('free', 'held', 'booked')),
  booking_id uuid,
  held_until timestamptz,
  primary key (run_id, coach_code, seat_number, segment_no),
  check (status <> 'held' or held_until is not null)
);

create index seat_segments_lookup
  on seat_segments (run_id, segment_no, status);