-- Fails loudly (raise exception) if any check is wrong.
\set ON_ERROR_STOP on
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002');

-- seed as the worker (service role): one row per table for each user
set role service_role;
do $$
declare u uuid; s uuid; m uuid; i uuid; r uuid;
begin
  foreach u in array array['aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002']::uuid[] loop
    insert into user_settings (user_id) values (u);
    insert into sources (user_id, kind, label, account) values (u,'gmail','Personal','x@example.com') returning id into s;
    insert into source_messages (user_id, source_id, provider, provider_message_id, filter_decision) values (u,s,'gmail','m1','pass') returning id into m;
    insert into items (user_id, title, kind, origin, due_at, priority) values (u,'Submit essay','task','email', '2026-11-13T22:00:00Z','medium') returning id into i;
    insert into item_sources (user_id, item_id, source_type, source_id, message_id, ref) values (u,i,'email',s,m,'m1');
    insert into worker_runs (user_id, source_id, mode) values (u,s,'live') returning id into r;
    insert into llm_usage (user_id, run_id, provider, model, prompt_version, purpose) values (u,r,'groq','x','v1','extract');
    insert into sender_rules (user_id, pattern, action) values (u,'@spam.com','block');
    insert into alerts (user_id, kind, message) values (u,'needs_reauth','test');
    perform set_source_secret(s, 'refresh-token-' || u::text);
  end loop;
end $$;
reset role;

-- 1. RLS: user A sees exactly their own rows in every table, never B's; anon sees nothing
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
do $$
declare t text; n int; other int;
begin
  foreach t in array array['user_settings','sources','source_messages','items','item_sources',
                           'audit_log','worker_runs','llm_usage','sender_rules','alerts'] loop
    execute format('select count(*), count(*) filter (where user_id <> auth.uid()) from %I', t) into n, other;
    if n < 1 or other <> 0 then raise exception 'RLS FAIL on %: own=% other=%', t, n, other; end if;
    raise notice 'RLS ok: % (own rows %, other users'' rows %)', t, n, other;
  end loop;
end $$;
do $$
declare n int;
begin
  update items set title = 'hacked' where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL: updated another user''s item'; end if;
  raise notice 'RLS ok: cross-user update touched 0 rows';
  begin
    insert into items (user_id, title, kind, origin) values ('bbbbbbbb-0000-0000-0000-000000000002','x','task','manual');
    raise exception 'RLS FAIL: inserted a row for another user';
  exception when insufficient_privilege then raise notice 'RLS ok: cross-user insert rejected';
  end;
  begin
    perform get_source_secret((select id from sources limit 1));
    raise exception 'FAIL: signed-in user could read a Vault secret';
  exception when insufficient_privilege then raise notice 'Vault ok: secret function denied to signed-in users';
  end;
  update sources set status = 'disabled';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS FAIL: user could modify sources'; end if;
  raise notice 'RLS ok: sources are read-only to the user';
end $$;
reset role; reset request.jwt.claim.sub;
set role anon;
do $$ declare n int; begin
  select count(*) into n from items;
  if n <> 0 then raise exception 'RLS FAIL: anon can read items'; end if;
  raise notice 'RLS ok: anon sees 0 items';
end $$;
reset role;

-- 2. My edit survives a later extraction run
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update items set title = 'Submit ENGL essay (my wording)';
reset role; reset request.jwt.claim.sub;
set role service_role;
update items set title = 'AI retitle', due_at = '2026-11-16T22:00:00Z', ai_values = '{"title":"AI retitle"}'
 where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
do $$
declare r items;
begin
  select * into r from items where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if r.title <> 'Submit ENGL essay (my wording)' then raise exception 'OVERRIDE FAIL: worker overwrote my title'; end if;
  if r.overridden_fields <> array['title'] then raise exception 'OVERRIDE FAIL: flags = %', r.overridden_fields; end if;
  if r.due_at <> '2026-11-16T22:00:00Z' then raise exception 'OVERRIDE FAIL: non-overridden due date was not updated'; end if;
  raise notice 'Override ok: my title kept, AI due-date change applied, flags = %', r.overridden_fields;
end $$;

-- 3. Revert to AI value clears the flag
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update items set title = ai_values->>'title', overridden_fields = array_remove(overridden_fields, 'title');
reset role; reset request.jwt.claim.sub;
do $$ declare r items; begin
  select * into r from items where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if r.title <> 'AI retitle' or r.overridden_fields <> '{}' then raise exception 'REVERT FAIL: % %', r.title, r.overridden_fields; end if;
  raise notice 'Revert ok';
end $$;

-- 4. Audit trail recorded both writers and both values
do $$ declare n_user int; n_worker int; moved jsonb; begin
  select count(*) filter (where actor='user'), count(*) filter (where actor='worker')
    into n_user, n_worker from audit_log
   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'update';
  select changes->'due_at' into moved from audit_log where actor='worker' and action='update' and changes ? 'due_at' limit 1;
  if n_user < 2 or n_worker < 1 or moved is null then raise exception 'AUDIT FAIL: user=% worker=% moved=%', n_user, n_worker, moved; end if;
  raise notice 'Audit ok: % user edits, % worker edits; date change recorded as %', n_user, n_worker, moved;
end $$;

-- 5. Vault round trip as the worker
set role service_role;
do $$ declare v text; begin
  select get_source_secret(id) into v from sources where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if v <> 'refresh-token-aaaaaaaa-0000-0000-0000-000000000001' then raise exception 'VAULT FAIL: %', v; end if;
  raise notice 'Vault ok: worker can store and read a source secret';
end $$;
reset role;
