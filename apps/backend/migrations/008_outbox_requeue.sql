-- when a note was handed to the queue, so notes whose token vanished can be put back
alter table outbox add column queued_at timestamptz;
