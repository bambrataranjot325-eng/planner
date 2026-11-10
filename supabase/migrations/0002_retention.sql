-- Nightly purge of stored email bodies older than 14 days (pg_cron).
create extension if not exists pg_cron;
select cron.schedule(
  'purge-email-bodies', '17 3 * * *',
  $$update public.source_messages set body_clean = null
     where body_clean is not null and created_at < now() - interval '14 days'$$
);
