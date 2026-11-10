-- Push notifications and the home-screen widget. Safe to run more than once.
alter table public.user_settings add column if not exists remind_minutes integer not null default 30 check (remind_minutes between 0 and 240);
alter table public.user_settings add column if not exists daily_summary_time text default '08:00';  -- local "HH:mm"; null = no morning summary
alter table public.user_settings add column if not exists push_public_key text;                      -- written by the worker; safe to expose
alter table public.user_settings add column if not exists push_test_at timestamptz;                  -- set by the app to ask for a test notification
alter table public.user_settings add column if not exists widget_token text unique;                  -- long random string the widget presents

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
alter table public.push_subscriptions enable row level security;
drop policy if exists own_rows on public.push_subscriptions;
create policy own_rows on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- One row per notification already sent, so nothing is ever sent twice.
create table if not exists public.notifications_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.notifications_sent enable row level security;
drop policy if exists own_rows_read on public.notifications_sent;
create policy own_rows_read on public.notifications_sent for select to authenticated using (user_id = (select auth.uid()));

-- Named secrets in the Vault, for the worker only (the private half of the push key lives here).
create or replace function public.set_app_secret(p_name text, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then perform vault.create_secret(p_secret, p_name);
  else perform vault.update_secret(v_id, p_secret); end if;
end $$;
create or replace function public.get_app_secret(p_name text) returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;
revoke all on function public.set_app_secret(text, text) from public, anon, authenticated;
revoke all on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.set_app_secret(text, text) to service_role;
grant execute on function public.get_app_secret(text) to service_role;

select cron.schedule('purge-sent-notifications', '53 3 * * *',
  $$delete from public.notifications_sent where sent_at < now() - interval '14 days'$$);
