alter table bookings
  add column waitlist_requested boolean not null default false,
  add column waitlisted_at timestamptz;

-- waiting passengers have no seat yet
alter table booking_passengers
  alter column coach_code drop not null,
  alter column seat_number drop not null,
  add constraint seat_both_or_neither check ((coach_code is null) = (seat_number is null));

alter table payments
  add column refund_amount_paise int check (refund_amount_paise is null or refund_amount_paise >= 0);

alter table fake_bank_transactions add column refunded_paise int;

alter table outbox drop constraint outbox_type_check;
alter table outbox add constraint outbox_type_check check (type in
  ('booking_confirmed','refund_issued','booking_waitlisted','booking_cancelled'));

create index bookings_waitlist on bookings (run_id, class, waitlisted_at) where stage = 'waitlisted';