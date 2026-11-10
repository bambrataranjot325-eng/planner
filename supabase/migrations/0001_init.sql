-- Planner: core schema, row-level security, audit log, Vault helpers.
-- Run once in the Supabase SQL editor (or `supabase db push`).

-- ---------- helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();   -- always the server clock: last write wins on server time
  return new;
end $$;

-- ---------- tables ----------
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC',          -- last timezone reported by a device
  timezone_reported_at timestamptz,
  llm_monthly_cap_usd numeric(8,2) not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('gmail','brightspace','claude_chat')),
  label text not null,
  account text not null default '',
  status text not null default 'active' check (status in ('active','needs_reauth','disabled')),
  secret_id uuid,                                 -- Vault secret (refresh token / feed URL)
  cursor jsonb not null default '{}'::jsonb,      -- e.g. {"historyId": "123"}
  backfill_done boolean not null default false,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, account)
);

create table public.source_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  provider text not null,
  provider_message_id text not null,
  thread_id text,
  sender text,
  subject text,
  received_at timestamptz,
  body_clean text,                                -- redacted; purged after 14 days
  filter_decision text not null check (filter_decision in ('pass','skip')),
  filter_reason text,
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending','done','failed','skipped','capped')),
  prompt_version text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, provider_message_id)
);
create index source_messages_thread_idx on public.source_messages (source_id, thread_id);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  summary text,
  description text,
  kind text not null check (kind in ('event','task')),
  start_at timestamptz,
  end_at timestamptz,
  due_at timestamptz,
  all_day boolean not null default false,
  due_precision text check (due_precision in ('exact','date_only','approximate')),
  location text,
  course text,
  priority text not null default 'medium' check (priority in ('high','medium','low')),
  priority_reason text,
  category text not null default 'other'
    check (category in ('work','study','personal','finance','health','admin','other')),
  color text,
  action_required boolean not null default false,
  confidence numeric(3,2) check (confidence between 0 and 1),
  status text not null default 'open'
    check (status in ('open','done','snoozed','dismissed','cancelled')),
  review_state text not null default 'accepted' check (review_state in ('needs_review','accepted')),
  origin text not null check (origin in ('email','brightspace','claude_chat','manual')),
  thread_key text,                                -- "<source_id>:<thread_id>" for email items
  link text,
  overridden_fields text[] not null default '{}', -- fields I edited by hand; the worker can't change them
  ai_values jsonb not null default '{}'::jsonb,   -- latest AI value per field, for "revert to AI value"
  deleted_at timestamptz,                         -- trash
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_user_time_idx on public.items (user_id, coalesce(start_at, due_at));
create index items_thread_idx on public.items (thread_key) where thread_key is not null;
create index items_review_idx on public.items (user_id) where review_state = 'needs_review';

create table public.item_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  source_type text not null check (source_type in ('email','brightspace','claude_chat','manual')),
  source_id uuid references public.sources(id) on delete set null,
  message_id uuid references public.source_messages(id) on delete set null,
  ref text not null,                              -- provider message id, ICS UID, ...
  link text,
  created_at timestamptz not null default now(),
  unique (item_id, source_type, ref)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('insert','update','delete')),
  actor text not null check (actor in ('user','worker')),
  changes jsonb not null default '{}'::jsonb,     -- {"field": {"old": ..., "new": ...}}
  at timestamptz not null default now()
);
create index audit_log_row_idx on public.audit_log (row_id, at desc);

create table public.worker_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.sources(id) on delete set null,
  mode text not null check (mode in ('preview','dry-run','live')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error text
);
create index worker_runs_started_idx on public.worker_runs (user_id, started_at desc);

create table public.llm_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.worker_runs(id) on delete set null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  purpose text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  est_cost_usd numeric(10,6) not null default 0,
  created_at timestamptz not null default now()
);
create index llm_usage_month_idx on public.llm_usage (user_id, created_at);

create table public.sender_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pattern text not null,                          -- "news@shop.com" or "@shop.com"
  action text not null check (action in ('block','allow')),
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, pattern)
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,                             -- needs_reauth | spend_cap | worker_error
  message text not null,
  source_id uuid references public.sources(id) on delete cascade,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

-- ---------- updated_at ----------
create trigger user_settings_updated before update on public.user_settings
  for each row execute function public.set_updated_at();
create trigger sources_updated before update on public.sources
  for each row execute function public.set_updated_at();
create trigger items_updated before update on public.items
  for each row execute function public.set_updated_at();

-- ---------- manual edits survive extraction ----------
-- A signed-in user editing an AI-filled field marks that field as overridden.
-- The worker (service role, no auth.uid()) cannot change overridden fields.
create or replace function public.items_protect_overrides() returns trigger
language plpgsql as $$
declare
  tracked constant text[] := array['title','summary','description','kind','start_at','end_at',
    'due_at','all_day','due_precision','location','course','priority','priority_reason','category'];
  f text;
  old_j jsonb := to_jsonb(old);
  new_j jsonb := to_jsonb(new);
  overrides text[] := new.overridden_fields;
begin
  if auth.uid() is not null then
    if old.origin <> 'manual' then
      foreach f in array tracked loop
        if (new_j -> f) is distinct from (old_j -> f)
           and not (f = any (overrides))
           -- "revert to AI value": the client removes the flag and sets the AI value together
           and not (f = any (old.overridden_fields)) then
          overrides := array_append(overrides, f);
        end if;
      end loop;
      new.overridden_fields := overrides;
    end if;
  else
    foreach f in array old.overridden_fields loop
      if f = any (tracked) then
        new_j := jsonb_set(new_j, array[f], old_j -> f);
      end if;
    end loop;
    new_j := jsonb_set(new_j, '{overridden_fields}', old_j -> 'overridden_fields');
    new := jsonb_populate_record(new, new_j);
  end if;
  return new;
end $$;
create trigger items_10_protect_overrides before update on public.items
  for each row execute function public.items_protect_overrides();

-- ---------- audit log ----------
create or replace function public.audit_items() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor text := case when auth.uid() is not null then 'user' else 'worker' end;
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (user_id, table_name, row_id, action, actor, changes)
    values (new.user_id, tg_table_name, new.id, 'insert', v_actor, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)), '{}'::jsonb)
      into v_changes
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'ai_values');
    if v_changes <> '{}'::jsonb then
      insert into public.audit_log (user_id, table_name, row_id, action, actor, changes)
      values (new.user_id, tg_table_name, new.id, 'update', v_actor, v_changes);
    end if;
    return new;
  else
    insert into public.audit_log (user_id, table_name, row_id, action, actor, changes)
    values (old.user_id, tg_table_name, old.id, 'delete', v_actor, to_jsonb(old));
    return old;
  end if;
end $$;
create trigger items_audit after insert or update or delete on public.items
  for each row execute function public.audit_items();

-- ---------- row-level security ----------
alter table public.user_settings   enable row level security;
alter table public.sources         enable row level security;
alter table public.source_messages enable row level security;
alter table public.items           enable row level security;
alter table public.item_sources    enable row level security;
alter table public.audit_log       enable row level security;
alter table public.worker_runs     enable row level security;
alter table public.llm_usage       enable row level security;
alter table public.sender_rules    enable row level security;
alter table public.alerts          enable row level security;

-- Full access to my own rows:
create policy own_rows on public.user_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.item_sources for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.sender_rules for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Read-only for me; only the worker writes:
create policy own_rows_read on public.sources for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_read on public.source_messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_read on public.audit_log for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_read on public.worker_runs for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_read on public.llm_usage for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_read on public.alerts for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows_ack on public.alerts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- Vault helpers (service role only) ----------
create or replace function public.set_source_secret(p_source_id uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select secret_id into v_id from public.sources where id = p_source_id;
  if not found then raise exception 'source % not found', p_source_id; end if;
  if v_id is null then
    v_id := vault.create_secret(p_secret, 'source:' || p_source_id::text);
    update public.sources set secret_id = v_id where id = p_source_id;
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
end $$;

create or replace function public.get_source_secret(p_source_id uuid) returns text
language sql security definer set search_path = '' as $$
  select d.decrypted_secret
    from public.sources s
    join vault.decrypted_secrets d on d.id = s.secret_id
   where s.id = p_source_id;
$$;

revoke all on function public.set_source_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.get_source_secret(uuid)       from public, anon, authenticated;
grant execute on function public.set_source_secret(uuid, text) to service_role;
grant execute on function public.get_source_secret(uuid)       to service_role;
