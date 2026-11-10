\set ON_ERROR_STOP on
-- two users; A makes a project and applies two plans
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into projects (id, user_id, name, course) values ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Essay 2', 'EXPOS-UY 1');
insert into personal_profile (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001');
do $$
declare v1 uuid; v2 uuid; n int; trashed int; past int;
begin
  v1 := apply_plan('11111111-0000-0000-0000-000000000001',
    '{"deadline":"2099-12-01T10:00:00Z","total_minutes":180,"buffer_pct":20,"granularity":"daily","made_by":"ai","milestones":[{"title":"Outline","minutes":60}],"explanation":["because"]}',
    '[{"title":"Essay 2: Outline","kind":"event","start_at":"2099-11-20T10:00:00Z","end_at":"2099-11-20T11:00:00Z","planned_minutes":60},
      {"title":"Essay 2: Draft","kind":"event","start_at":"2099-11-21T10:00:00Z","end_at":"2099-11-21T11:00:00Z","planned_minutes":60},
      {"title":"Essay 2: old","kind":"event","start_at":"2000-01-01T10:00:00Z","end_at":"2000-01-01T11:00:00Z","planned_minutes":60}]');
  select count(*) into n from items where plan_id = v1 and deleted_at is null;
  if n <> 2 then raise exception 'PLAN FAIL: expected 2 future sessions, got %', n; end if;   -- the past one is not created
  update items set status = 'done', actual_minutes = 75 where plan_id = v1 and title = 'Essay 2: Outline';

  v2 := apply_plan('11111111-0000-0000-0000-000000000001',
    '{"deadline":"2099-12-05T10:00:00Z","total_minutes":120,"buffer_pct":20,"granularity":"daily","made_by":"manual","milestones":[],"explanation":[]}',
    '[{"title":"Essay 2: Draft","kind":"event","start_at":"2099-11-25T10:00:00Z","end_at":"2099-11-25T11:00:00Z","planned_minutes":60}]');
  select count(*) into trashed from items where plan_id = v1 and deleted_at is not null;
  select count(*) into past from items where plan_id = v1 and deleted_at is null and status = 'done';
  if trashed <> 1 or past <> 1 then raise exception 'REPLAN FAIL: trashed=% kept_done=%', trashed, past; end if;
  if (select version from project_plans where id = v2) <> 2 then raise exception 'VERSION FAIL'; end if;
  if (select superseded_at from project_plans where id = v1) is null then raise exception 'SUPERSEDE FAIL'; end if;
  if (select current_plan_id from projects where id = '11111111-0000-0000-0000-000000000001') <> v2 then raise exception 'CURRENT FAIL'; end if;
  if (select deadline from projects where id = '11111111-0000-0000-0000-000000000001') <> '2099-12-05T10:00:00Z' then raise exception 'DEADLINE FAIL'; end if;
  raise notice 'Plans ok: v1 kept its finished session, its unfinished one went to Trash, v2 is current';
  if (select origin || '/' || category || '/' || course from items where plan_id = v2) <> 'plan/study/EXPOS-UY 1' then raise exception 'SESSION FIELDS FAIL'; end if;
end $$;

-- B cannot see or plan A's project
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
do $$ declare n int; begin
  select count(*) into n from projects; if n <> 0 then raise exception 'RLS FAIL: B sees % projects', n; end if;
  select count(*) into n from project_plans; if n <> 0 then raise exception 'RLS FAIL: B sees plans'; end if;
  select count(*) into n from personal_profile; if n <> 0 then raise exception 'RLS FAIL: B sees a profile'; end if;
  begin
    perform apply_plan('11111111-0000-0000-0000-000000000001', '{"deadline":"2099-12-05T10:00:00Z","total_minutes":1,"buffer_pct":0,"granularity":"daily","made_by":"manual","milestones":[]}', '[]');
    raise exception 'RLS FAIL: B applied a plan to A''s project';
  exception when others then
    if sqlerrm not like '%project not found%' then raise; end if;
    raise notice 'RLS ok: another user cannot see or plan this project';
  end;
end $$;
reset role; reset request.jwt.claim.sub;
set role anon;
do $$ begin
  begin perform apply_plan('11111111-0000-0000-0000-000000000001', '{}', '[]'); raise exception 'FAIL: anon could call apply_plan';
  exception when insufficient_privilege then raise notice 'RLS ok: signed-out visitors cannot call apply_plan'; end;
end $$;
reset role;

-- attached items survive a project being deleted; its sessions do not
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
do $$ declare kept int; sessions int; linked uuid; begin
  update items set project_id = '11111111-0000-0000-0000-000000000001' where origin = 'email' returning id into linked;
  if linked is null then raise exception 'LINK FAIL: no email item to attach'; end if;
  perform delete_project('11111111-0000-0000-0000-000000000001');
  select count(*) into kept from items where id = linked and project_id is null;
  select count(*) into sessions from items where origin = 'plan';
  if kept <> 1 or sessions <> 0 then raise exception 'DELETE FAIL: kept=% sessions_left=%', kept, sessions; end if;
  if exists (select 1 from projects) then raise exception 'DELETE FAIL: project still there'; end if;
  raise notice 'Delete ok: the attached email item was kept and unlinked, the sessions were removed';
end $$;
reset role; reset request.jwt.claim.sub;

-- assistant: my conversation is private, and a batch of imported items can be found and trashed together
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into chat_messages (user_id, role, content) values ('aaaaaaaa-0000-0000-0000-000000000001', 'user', 'add my timetable');
insert into items (user_id, title, kind, origin, start_at, import_batch) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Lecture wk1', 'event', 'manual', '2099-01-05T00:00:00Z', 'cccccccc-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Lecture wk2', 'event', 'manual', '2099-01-12T00:00:00Z', 'cccccccc-0000-0000-0000-000000000001');
do $$ declare n int; begin
  update items set deleted_at = now() where import_batch = 'cccccccc-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'BATCH FAIL: undo touched % rows', n; end if;
  raise notice 'Batch ok: one undo trashed both imported items';
end $$;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
do $$ declare n int; begin
  select count(*) into n from chat_messages; if n <> 0 then raise exception 'RLS FAIL: B can read A''s conversation'; end if;
  update items set deleted_at = null where import_batch = 'cccccccc-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'RLS FAIL: B could touch A''s batch'; end if;
  raise notice 'RLS ok: the conversation and the batch are private';
end $$;
reset role; reset request.jwt.claim.sub;

-- push: the private key is out of reach of signed-in users; each person sees only their own devices
set role service_role;
do $$ begin
  perform set_app_secret('push:private', 'k1');
  perform set_app_secret('push:private', 'k2');
  if get_app_secret('push:private') <> 'k2' then raise exception 'SECRET FAIL'; end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ('aaaaaaaa-0000-0000-0000-000000000001', 'https://push.example/a', 'p', 'a');
update user_settings set remind_minutes = 15, widget_token = 'tok-a';
do $$ begin
  begin perform get_app_secret('push:private'); raise exception 'FAIL: user read the push private key';
  exception when insufficient_privilege then raise notice 'Push ok: the private key is unreadable by signed-in users'; end;
end $$;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
do $$ declare n int; begin
  select count(*) into n from push_subscriptions; if n <> 0 then raise exception 'RLS FAIL: B sees A''s devices'; end if;
  select count(*) into n from user_settings where widget_token is not null; if n <> 0 then raise exception 'RLS FAIL: B sees A''s widget token'; end if;
  raise notice 'RLS ok: devices and the widget token are private';
end $$;
reset role; reset request.jwt.claim.sub;
