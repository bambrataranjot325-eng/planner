-- "Possible" items: things I could go to or apply for but have not committed to.
-- Safe to run more than once.
alter table public.items add column if not exists optional boolean not null default false;

-- Same function as before, with 'optional' added, so once I say "I'm going" a later email cannot undo it.
create or replace function public.items_protect_overrides() returns trigger
language plpgsql as $$
declare
  tracked constant text[] := array['title','summary','description','kind','start_at','end_at',
    'due_at','all_day','timezone','optional','due_precision','location','course','priority','priority_reason','category'];
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
