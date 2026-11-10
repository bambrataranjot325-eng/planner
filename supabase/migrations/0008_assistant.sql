-- The in-app assistant: a saved conversation, grouped imports that can be undone, and project background notes.
-- Safe to run more than once.
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null default '',
  attachments jsonb not null default '[]'::jsonb,   -- file names only; the files themselves are never stored
  proposal jsonb,                                   -- what the assistant suggested changing
  proposal_state jsonb,                             -- what I did about it: {"applied_at": "...", "batch_id": "...", "undone_at": "..."}
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_idx on public.chat_messages (user_id, created_at);
alter table public.chat_messages enable row level security;
drop policy if exists own_rows on public.chat_messages;
create policy own_rows on public.chat_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Everything added from one assistant proposal shares a batch id, so it can be undone together.
alter table public.items add column if not exists import_batch uuid;
create index if not exists items_batch_idx on public.items (import_batch) where import_batch is not null;

-- Pasted background for a project (a chat, a brief, notes). Read by the estimate.
alter table public.projects add column if not exists background text;
