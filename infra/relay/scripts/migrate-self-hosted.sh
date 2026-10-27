#!/usr/bin/env bash
# Fork: applies the relay's Drizzle migrations to the self-hosted database.
# Upstream's PlanetScale resource did this on deploy. Run it before deploying,
# with libpq settings in the environment (PGHOST, PGDATABASE, PGUSER and
# PGPASSWORD), from a machine that can reach the database.
set -euo pipefail

migrations="$(cd "$(dirname "$0")/../migrations/postgres" && pwd)"
psql=(psql --no-psqlrc --quiet --set ON_ERROR_STOP=1)

"${psql[@]}" --command "CREATE TABLE IF NOT EXISTS relay_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for dir in "$migrations"/*/; do
  name="$(basename "$dir")"
  applied="$("${psql[@]}" --tuples-only --no-align --set name="$name" <<<"SELECT 1 FROM relay_migrations WHERE name = :'name';")"
  [[ -n "$applied" ]] && continue
  echo "applying $name"
  # On stdin: psql does not substitute variables in --command strings.
  "${psql[@]}" --single-transaction --set name="$name" --set file="${dir}migration.sql" <<'SQL'
\i :file
INSERT INTO relay_migrations (name) VALUES (:'name');
SQL
done
echo "migrations up to date"
