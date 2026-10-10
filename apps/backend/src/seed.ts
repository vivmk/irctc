import { pool } from "./db";

const DATES = ["2026-12-25", "2026-12-26", "2026-12-27"];

async function main() {
  await pool.query(`
    insert into stations (code, name, city) values
      ('NDLS', 'New Delhi', 'Delhi'),
      ('CNB', 'Kanpur Central', 'Kanpur'),
      ('PRYJ', 'Prayagraj Junction', 'Prayagraj'),
      ('PNBE', 'Patna Junction', 'Patna')
    on conflict (code) do nothing`);

  await pool.query(`
    insert into trains (number, name) values ('12345', 'Demo Express')
    on conflict (number) do nothing`);

  await pool.query(`
    insert into train_stops (train_id, stop_order, station_id, departure_time, day_offset)
    select t.id, v.ord, s.id, v.dep::time, v.off
    from trains t
    join (values (1,'NDLS','16:00',0), (2,'CNB','22:00',0), (3,'PRYJ','01:00',1), (4,'PNBE','06:00',1))
      as v(ord, code, dep, off) on true
    join stations s on s.code = v.code
    where t.number = '12345'
    on conflict (train_id, stop_order) do update
      set departure_time = excluded.departure_time, day_offset = excluded.day_offset`);

  await pool.query(`
    insert into coaches (train_id, coach_code, class, seat_count)
    select t.id, v.code, v.class, 8
    from trains t
    join (values ('S1','SL'), ('B1','3A')) as v(code, class) on true
    where t.number = '12345'
    on conflict do nothing`);

  for (const date of DATES) {
    await pool.query(
      `insert into train_runs (train_id, journey_date)
       select id, $1 from trains where number = '12345'
       on conflict do nothing`,
      [date],
    );
    // one row per seat per segment, all free
    await pool.query(
      `insert into seat_segments (run_id, coach_code, seat_number, segment_no)
       select r.id, c.coach_code, seat.n, seg.n
       from train_runs r
       join trains t on t.id = r.train_id
       join coaches c on c.train_id = r.train_id
       cross join lateral generate_series(1, c.seat_count) as seat(n)
       cross join lateral generate_series(
         1, (select count(*) - 1 from train_stops where train_id = r.train_id)
       ) as seg(n)
       where t.number = '12345' and r.journey_date = $1
       on conflict do nothing`,
      [date],
    );
  }

  console.log("seeded");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
