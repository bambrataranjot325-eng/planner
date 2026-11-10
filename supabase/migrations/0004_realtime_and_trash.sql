-- Lets the web app hear about item changes as they happen, and empties the Trash after 30 days.
-- Safe to run more than once.
do $$
begin
  alter publication supabase_realtime add table public.items;
exception
  when duplicate_object then null;  -- already added
  when undefined_object then raise notice 'supabase_realtime publication not found; live updates stay off';
end $$;

select cron.schedule(
  'purge-trash', '41 3 * * *',
  $$delete from public.items where deleted_at is not null and deleted_at < now() - interval '30 days'$$
);
