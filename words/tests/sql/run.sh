#!/usr/bin/env bash
# Runs the WORDS migrations and SQL tests against a throwaway local PostgreSQL.
#   npm run test:sql     (needs PostgreSQL 15+ binaries: initdb, pg_ctl, psql)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bin="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PATH="$bin:$PATH"
dir="$(mktemp -d)"
port="${PG_TEST_PORT:-54329}"
cleanup() { run "'$bin/pg_ctl' -D '$dir/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT
run() { if [ "$(id -u)" = 0 ]; then chown -R postgres "$dir"; su postgres -c "$*"; else bash -c "$*"; fi; }
run "'$bin/initdb' -D '$dir/data' -U postgres -A trust >/dev/null"
run "'$bin/pg_ctl' -D '$dir/data' -o '-p $port -k $dir -c timezone=UTC' -l '$dir/log' -w start >/dev/null"
psql=(psql -h "$dir" -p "$port" -U postgres -v ON_ERROR_STOP=1 -q -X)
"${psql[@]}" -c "create database words" >/dev/null
"${psql[@]}" -d words -f "$here/bootstrap.sql" >/dev/null
for m in "$root"/supabase/migrations/*.sql; do "${psql[@]}" -d words -f "$m" >/dev/null; done
"${psql[@]}" -d words -f "$here/test.sql"

# Concurrency: 8 parallel reserves against a 300-point balance (one may win),
# then 8 parallel confirmations of one code (one may redeem it).
"${psql[@]}" -d words -f "$here/concurrency.sql" >/dev/null
offer=$("${psql[@]}" -d words -tAc "select id from market.offers where title = 'Tea'")
for i in $(seq 1 8); do
  "${psql[@]}" -d words -tAc "select public.svc_reserve('00000000-0000-0000-0000-0000000000f1', '$offer', 'race-$i', 'hash-race-$i')" >/dev/null 2>&1 &
done
wait
won=$("${psql[@]}" -d words -tAc "select count(*) from market.redemptions where user_id = '00000000-0000-0000-0000-0000000000f1'")
avail=$("${psql[@]}" -d words -tAc "select loyalty.balance('00000000-0000-0000-0000-0000000000f1') ->> 'available'")
[ "$won" = 1 ] && [ "$avail" = 0 ] || { echo "FAIL parallel reserve: $won reservations, $avail available"; exit 1; }
for i in $(seq 1 8); do
  "${psql[@]}" -d words -tAc "select public.svc_validate('00000000-0000-0000-0000-00000000000c', 'hash-race', true)" >/dev/null 2>&1 &
done
wait
redeems=$("${psql[@]}" -d words -tAc "select count(*) from loyalty.transactions where type = 'redeem' and user_id = '00000000-0000-0000-0000-0000000000f2'")
[ "$redeems" = 1 ] || { echo "FAIL parallel validate: $redeems redeem transactions"; exit 1; }
echo "concurrency: 1 of 8 parallel reserves, 1 of 8 parallel redemptions"
echo "SQL tests passed"
