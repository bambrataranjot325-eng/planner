-- Projects, plans, work sessions and the planning profile. Safe to run more than once.

create table if not exists public.personal_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- working_hours: {"1": {"start": "09:00", "end": "21:00"}, ..., "7": null}   (1 = Monday; null = no work that day)
  working_hours jsonb not null default '{"1":{"start":"09:00","end":"21:00"},"2":{"start":"09:00","end":"21:00"},"3":{"start":"09:00","end":"21:00"},"4":{"start":"09:00","end":"21:00"},"5":{"start":"09:00","end":"21:00"},"6":{"start":"10:00","end":"18:00"},"7":{"start":"10:00","end":"18:00"}}'::jsonb,
  -- blocks: [{"label": "CS lecture", "days": [1,3], "start": "09:30", "end": "10:50"}]  classes and other fixed commitments
  blocks jsonb not null default '[]'::jsonb,
  max_hours_per_day numeric(4,2) not null default 3 check (max_hours_per_day between 0.5 and 16),
  session_minutes integer not null default 60 check (session_minutes between 15 and 240),
  buffer_pct integer not null default 20 check (buffer_pct between 0 and 60),
  energy text not null default 'any' check (energy in ('any','morning','afternoon','evening')),
  goals text,
  notes text,
  learned jsonb not null default '{}'::jsonb,       -- e.g. {"pace": 1.2}: I take 20% longer than planned
  field_meta jsonb not null default '{}'::jsonb,    -- {"working_hours": {"source": "manual", "confirmed_at": "..."}}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  course text,
  deadline timestamptz,
  granularity text not null default 'daily' check (granularity in ('daily','weekly')),
  status text not null default 'open' check (status in ('open','done','archived')),
  current_plan_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null,
  deadline timestamptz not null,
  total_minutes integer not null,
  buffer_pct integer not null,
  granularity text not null,
  made_by text not null check (made_by in ('ai','manual')),
  milestones jsonb not null,     -- [{"title": "Outline", "minutes": 120, "due": "..."}]
  sessions jsonb not null,       -- what was put on the calendar, so a version can be restored
  explanation jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (project_id, version)
);

alter table public.items add column if not exists project_id uuid references public.projects(id) on delete cascade;
alter table public.items add column if not exists plan_id uuid;
alter table public.items add column if not exists planned_minutes integer;
alter table public.items add column if not exists actual_minutes integer;
create index if not exists items_project_idx on public.items (project_id) where project_id is not null;

-- Work sessions are items whose origin is 'plan'.
alter table public.items drop constraint if exists items_origin_check;
alter table public.items add constraint items_origin_check check (origin in ('email','brightspace','claude_chat','manual','plan'));

drop trigger if exists personal_profile_updated on public.personal_profile;
create trigger personal_profile_updated before update on public.personal_profile for each row execute function public.set_updated_at();
drop trigger if exists projects_updated on public.projects;
create trigger projects_updated before update on public.projects for each row execute function public.set_updated_at();

alter table public.personal_profile enable row level security;
alter table public.projects enable row level security;
alter table public.project_plans enable row level security;
drop policy if exists own_rows on public.personal_profile;
create policy own_rows on public.personal_profile for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists own_rows on public.projects;
create policy own_rows on public.projects for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists own_rows on public.project_plans;
create policy own_rows on public.project_plans for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

/*
 * Put a plan on the calendar in one step, so a half-applied plan can never exist:
 * retire the previous version, move its remaining sessions to Trash, add the new sessions.
 * Runs as the signed-in user, so row-level security still applies.
 */
create or replace function public.apply_plan(p_project uuid, p_plan jsonb, p_sessions jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_plan uuid;
  v_version integer;
  v_project public.projects;
begin
  select * into v_project from public.projects where id = p_project and user_id = v_user;
  if not found then raise exception 'project not found'; end if;

  select coalesce(max(version), 0) + 1 into v_version from public.project_plans where project_id = p_project;
  update public.project_plans set superseded_at = now() where project_id = p_project and superseded_at is null;

  insert into public.project_plans (user_id, project_id, version, deadline, total_minutes, buffer_pct, granularity, made_by, milestones, sessions, explanation)
  values (v_user, p_project, v_version, (p_plan->>'deadline')::timestamptz, (p_plan->>'total_minutes')::int, (p_plan->>'buffer_pct')::int,
          p_plan->>'granularity', p_plan->>'made_by', p_plan->'milestones', p_sessions, coalesce(p_plan->'explanation', '[]'::jsonb))
  returning id into v_plan;

  -- Sessions that have not happened yet and are not done go to Trash; finished and past ones stay as history.
  update public.items set deleted_at = now()
   where project_id = p_project and origin = 'plan' and status = 'open' and deleted_at is null
     and coalesce(start_at, due_at) > now();

  insert into public.items (user_id, title, summary, kind, start_at, end_at, due_at, due_precision, category, priority, course,
                            origin, project_id, plan_id, planned_minutes, review_state, status, action_required)
  select v_user, left(s.title, 80), s.summary, s.kind, s.start_at, s.end_at, s.due_at,
         case when s.kind = 'task' then 'date_only' end,
         case when v_project.course is not null then 'study' else 'work' end, 'medium', v_project.course,
         'plan', p_project, v_plan, s.planned_minutes, 'accepted', 'open', false
    from jsonb_to_recordset(p_sessions) as s(title text, summary text, kind text, start_at timestamptz, end_at timestamptz, due_at timestamptz, planned_minutes int)
   where coalesce(s.start_at, s.due_at) > now();

  update public.projects set current_plan_id = v_plan, deadline = (p_plan->>'deadline')::timestamptz, granularity = p_plan->>'granularity' where id = p_project;
  return v_plan;
end $$;
revoke all on function public.apply_plan(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.apply_plan(uuid, jsonb, jsonb) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null; when undefined_object then null; end $$;
