#!/usr/bin/env bash
# Runs the migration and the RLS/override tests against a throwaway local Postgres database.
# Needs a local Postgres you can reach as a superuser (psql). Never touches Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL=${PSQL:-psql}
$PSQL -q -c 'drop database if exists planner_test' -c 'create database planner_test'
$PSQL -q -c 'drop role if exists anon' -c 'drop role if exists authenticated' -c 'drop role if exists service_role'
for f in supabase/tests/00_supabase_stub.sql supabase/migrations/0001_init.sql supabase/migrations/0003_item_timezone.sql supabase/migrations/0005_possible_items.sql supabase/migrations/0006_projects.sql supabase/migrations/0007_project_links.sql supabase/migrations/0008_assistant.sql supabase/tests/01_rls_and_overrides.sql supabase/tests/02_projects.sql; do
  $PSQL -q -v ON_ERROR_STOP=1 -d planner_test -f "$f"
done
echo "SQL tests passed"
