create table stations (
  id serial primary key,
  code text not null unique,
  name text not null,
  city text not null
);

create table trains (
  id serial primary key,
  number text not null unique,
  name text not null
);

create table train_stops (
  train_id int not null references trains(id),
  stop_order int not null check (stop_order >= 1),
  station_id int not null references stations(id),
  arrival_time time,
  departure_time time,
  day_offset int not null default 0,
  primary key (train_id, stop_order),
  unique (train_id, station_id)
);

create table coaches (
  train_id int not null references trains(id),
  coach_code text not null,
  class text not null,
  seat_count int not null check (seat_count > 0),
  primary key (train_id, coach_code)
);