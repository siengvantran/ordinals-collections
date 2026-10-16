#!/usr/bin/env bash
# Runs the words-api Edge Function (Deno) against the real SQL on a throwaway
# PostgreSQL, with a small shim standing in for Supabase's REST and Auth.
#   npm run test:integration   (needs PostgreSQL binaries and deno on PATH or $DENO)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bin="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
deno="${DENO:-deno}"
export PATH="$bin:$PATH"
dir="$(mktemp -d)"; chmod 755 "$dir"
port=54330; shim=54331; api=54332
pids=()
run() { if [ "$(id -u)" = 0 ]; then chown -R postgres "$dir"; su postgres -c "$*"; else bash -c "$*"; fi; }
cleanup() { for p in "${pids[@]}"; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done; run "'$bin/pg_ctl' -D '$dir/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT
run "'$bin/initdb' -D '$dir/data' -U postgres -A trust >/dev/null"
run "'$bin/pg_ctl' -D '$dir/data' -o '-p $port -k $dir -c timezone=UTC' -l '$dir/log' -w start >/dev/null"
psql_args="[\"-h\",\"$dir\",\"-p\",\"$port\",\"-U\",\"postgres\",\"-d\",\"words\"]"
psql -h "$dir" -p "$port" -U postgres -qX -c "create database words" >/dev/null
for f in "$root/tests/sql/bootstrap.sql" "$root"/supabase/migrations/*.sql "$here/rpc-shim.sql"; do
  psql -h "$dir" -p "$port" -U postgres -d words -qX -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
node "$here/shim.mjs" "$shim" "$psql_args" & pids+=($!)
# Run a copy of the functions folder so Deno doesn't pick up words/package.json.
cp -r "$root/supabase/functions" "$dir/functions"
echo '{"nodeModulesDir":"auto"}' > "$dir/functions/deno.json"
( cd "$dir/functions" && SUPABASE_URL="http://127.0.0.1:$shim" SUPABASE_SERVICE_ROLE_KEY=test GAME_SALT=test WORDS_API_PORT="$api" \
  exec "$deno" run -A --quiet words-api/index.ts ) &
pids+=($!)
for i in $(seq 1 120); do curl -s "http://127.0.0.1:$api/words-api/game/leaderboard" >/dev/null 2>&1 && break; sleep 1; done
node "$here/journey.mjs" "http://127.0.0.1:$api/words-api" "$psql_args"
