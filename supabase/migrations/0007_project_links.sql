-- Calendar items can be attached to a project as context. Deleting a project must not delete them,
-- only its own work sessions. Safe to run more than once.
alter table public.items drop constraint if exists items_project_id_fkey;
alter table public.items add constraint items_project_id_fkey foreign key (project_id) references public.projects(id) on delete set null;

create or replace function public.delete_project(p_project uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not exists (select 1 from public.projects where id = p_project and user_id = auth.uid()) then
    raise exception 'project not found';
  end if;
  delete from public.items where project_id = p_project and origin = 'plan' and user_id = auth.uid();  -- its work sessions
  delete from public.projects where id = p_project and user_id = auth.uid();                          -- attached items are kept, unlinked
end $$;
revoke all on function public.delete_project(uuid) from public, anon;
grant execute on function public.delete_project(uuid) to authenticated;
