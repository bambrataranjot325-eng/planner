# Planner

Two parts: the **worker** on the VPS (this file) and the **web app** in `web/` (see `web/README.md`).

## Worker (Phase 1)

A Supabase database and a small worker that runs on the VPS. The worker reads one Gmail inbox
(read-only), filters out noise, sends what is left to an AI model, and turns the result into
calendar items. Phase 1 has no app yet: you look at results in a report file and in Supabase.

## What is in here

| Path | What it is |
|---|---|
| `supabase/migrations/` | Tables, row-level security, audit log, Vault helpers, nightly email-body purge |
| `supabase/tests/`, `scripts/test-sql.sh` | Security and "my edits survive" tests, run on a local Postgres |
| `worker/` | The worker (TypeScript, Node 22) and its unit tests |
| `worker/prompts/extract.v1.md` | The extraction prompt. Edit it, then `make restart` |
| `worker/config/models.json` | Which models, their prices, and the confidence thresholds |
| `worker/fixtures/` | 30 invented emails and 5 Brightspace events used by tests and the eval |
| `web/` | The calendar web app (Phase 2). Deployed to Vercel, not to the VPS |
| `docker-compose.yml`, `Makefile` | Deployment. `make deploy` is the only command needed after setup |

## Setup (about 20 minutes, once)

### 1. Supabase

1. Open the new project's **SQL Editor**. Paste and run the contents of `supabase/migrations/0001_init.sql`, then `0002_retention.sql`, then `0003_item_timezone.sql`, `0004_realtime_and_trash.sql`, `0005_possible_items.sql` and `0006_projects.sql` (the file contents, not the file names).
2. **Authentication > Users > Add user**: create a user with your email. Copy its **UID**.
3. **Project Settings > API**: copy the project URL and the secret (service role) key.

### 2. Google

In the Planner project's OAuth client, add this **Authorized redirect URI** and save:

```
http://localhost:53682/oauth/callback
```

### 3. Server

Copy this folder to the VPS (for example `scp planner-phase1.zip root@SERVER:~`, then unzip), then:

```
cd planner
make vps-audit          # read-only; shows Docker, firewall and SSH settings
cp .env.example .env
nano .env               # fill in every value
```

Use new Groq and Anthropic keys, not the ones from the old n8n exports.

### 4. Connect the inbox

On your Mac, open a tunnel so Google's redirect to `localhost` reaches the server:

```
ssh -L 53682:localhost:53682 root@SERVER
```

In that SSH session:

```
cd planner && make auth
```

Open the printed link in your Mac's browser, choose the bambrataranjot325 account, click through the
"unverified app" warning, and approve read-only access. The tab should say "Connected". The sign-in
token goes straight into Supabase Vault and is never printed.

### 5. Look before anything is created

```
make preview        # sends nothing; writes reports/preview-*.md with the exact AI payloads
make dry-run        # calls the AI on the 60 most recent emails; writes reports/dry-run-*.md
make report         # prints the newest dry-run report
```

The dry-run report lists what would be created, what was sent to the AI and produced nothing, and
what was filtered out and why. It contains subjects and sender names but no email bodies, so it is
fine to paste into a chat. The preview file does contain (redacted) bodies; keep that one on the server.

Neither command creates items or moves the sync position.

### 6. Go live (only when the dry-run looks right)

Set `MODE=live` in `.env`, then:

```
make deploy
make logs
```

The first live run reads the last 30 days. After that it checks every 15 minutes for new mail only.

### 7. Brightspace

Put the feed address in `.env` as `BRIGHTSPACE_FEED_URL`, then:

```
make brightspace-preview     # what would go on the calendar; saves nothing
make connect-brightspace     # stores the address in the Vault; syncing starts within the hour
```

After connecting you can delete the address from `.env`. The feed is read hourly. Due dates become
tasks, sittings and course events become events, and "Available" entries are ignored. No AI is used for
Brightspace, so it costs nothing. A deadline that an email already put on the calendar is linked to the
feed rather than duplicated, and the feed then keeps its date current.

### 8. More inboxes

A new inbox starts reading 30 days of mail as soon as the live worker sees it, so stop the worker
first if you want a trial run:

```
make stop
make auth                                   # in the SSH tunnel; choose the new account
make dry-run ACCOUNT=new.address@example.com
make report
make deploy                                 # when the report looks right
```

A university account may refuse the sign-in if its administrators block unverified apps.

## Day to day

| Command | Does |
|---|---|
| `make deploy` | Rebuild and restart after any change |
| `make logs` / `make status` | Watch the worker |
| `make restart` | Pick up an edited prompt or `models.json` |
| `make eval` | Precision and recall on the 30 fixture emails (calls the AI) |
| `make auth` | Reconnect an inbox that shows `needs_reauth` |

Where to look in Supabase: `items` (results), `worker_runs` (one row per run with counts),
`llm_usage` (tokens and estimated cost), `alerts` (re-auth and spend-cap warnings),
`audit_log` (every change to an item, with old and new values).

## How it behaves

- **Filtering before the AI:** Promotions and Social, security codes and sign-in alerts, receipts with
  no deadline, and newsletters with no action wording are skipped. Rows in `sender_rules` block or allow a sender.
- **What is sent:** sender, subject, received date in your timezone, and the body with quoted replies
  and signatures removed, truncated at 6,000 characters. Card numbers, passwords, account numbers and
  one-time codes are masked first. No attachments.
- **Two models:** mail from a person goes to the stronger model. Newsletters, digests and list mail go
  to a cheaper one under a stricter rule: obligations (deadlines, required forms, payments, exams)
  become normal items and optional events become possibles. A malformed reply is retried once, then the stronger
  model is asked.
- **Possibles:** events and opportunities you could take up but haven't (a workshop in a digest, a
  fellowship deadline) are saved as "possible" and drawn dashed in the app. A ticket or sign-up email turns
  one into a plan. Sales, job listings and surveys are left out entirely.
- **Blocking a sender:** add a row to `sender_rules`. `@shop.com` blocks a domain, `news@shop.com` an
  address, and a word with no @ (such as `WSJ`) blocks any sender whose name contains it.
- **Review queue:** items under 0.6 confidence, and cancellations, are saved with
  `review_state = 'needs_review'` and stay off the calendar until accepted.
- **No duplicates:** each email is shown the items already on the calendar (its own thread's, plus other
  open items near that date), so a reply or a repeat reminder updates an item instead of adding one. As a
  backstop, a new item that matches an existing one (same kind, within a day, mostly the same words) is
  merged into it, and the email is added as another source.
- **Done and cancelled:** an email saying something is finished ("your password has been changed") marks
  the matching item done. A cancellation marks it cancelled and puts it in Needs review for you to confirm.
- **Timezones:** a time in an email is read in the timezone of the place it happens when the email makes
  that clear (a Sydney venue, a flight's airports), otherwise in your timezone.
- **First run:** during the 30-day backfill, things whose date has already passed are not created
  (`BACKFILL_SKIP_PAST=false` turns this off).
- **Your edits win:** once you edit a field, the database refuses AI changes to that field.
- **Spend cap:** when the month's estimated spend reaches `user_settings.llm_monthly_cap_usd`
  (default 5), extraction stops, an alert row is written, and the skipped emails are picked up later.
- **Re-auth:** if Google rejects the saved sign-in, the inbox is marked `needs_reauth` and an alert row is written.
- **Retention:** stored email bodies are deleted after 14 days by a nightly database job.

## Tests

```
make test                 # 114 unit tests
./scripts/test-sql.sh     # needs a local Postgres; runs the migration and the security tests
```

## Not in Phase 1

Alerts are rows in a table; nothing notifies you yet. No backups or server hardening changes yet. See the open questions in the chat.
