-- Stand-in for what Supabase provides (auth, vault, roles). Test use only; never run on Supabase.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text);
create view vault.decrypted_secrets as select id, secret as decrypted_secret, name from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null) returns uuid language sql as
  $$ insert into vault.secrets (secret, name) values (new_secret, new_name) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null) returns void language sql as
  $$ update vault.secrets set secret = new_secret where id = secret_id $$;
grant usage on schema auth, vault to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- pg_cron stand-in
create schema cron;
create function cron.schedule(job text, sched text, cmd text) returns bigint language sql as $$ select 1::bigint $$;
grant usage on schema cron to anon, authenticated, service_role;
