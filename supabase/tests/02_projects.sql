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
