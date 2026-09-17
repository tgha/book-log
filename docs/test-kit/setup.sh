#!/bin/sh
# 로컬 시험 환경 처음 준비 (DB 만들기 · 역할 · bk_ 표 · 열쇠 파일 · 시험 도구 복사)
# 먼저 README 의 설치(PostgreSQL 16 · Deno 2.5.4 · PostgREST 12.2.12)를 끝낸 뒤 실행
set -e
KIT=/home/claude/book-log/docs/test-kit
PGBIN=/usr/lib/postgresql/16/bin
mkdir -p /tmp/pgtest /tmp/bktest && chown postgres /tmp/pgtest
if [ ! -f /tmp/pgtest/data/PG_VERSION ]; then
  su postgres -c "$PGBIN/initdb -A trust -D /tmp/pgtest/data" > /tmp/pgtest/init.log
fi
su postgres -c "setsid $PGBIN/pg_ctl -D /tmp/pgtest/data -o '-p 55432 -k /tmp/pgtest -h 127.0.0.1' -l /tmp/pgtest/log start" > /dev/null || true
sleep 3
P="psql -h /tmp/pgtest -p 55432 -U postgres -v ON_ERROR_STOP=1 -q"
su postgres -c "$P" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login password 'x' noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
for f in /home/claude/book-log/supabase/bk_0*.sql; do
  # 로컬에는 storage 스키마가 없으므로 사진 창고 부분(-- @storage 표시 줄)은 건너뜀
  if ! su postgres -c "psql -h /tmp/pgtest -p 55432 -U postgres -Atqc \"select 1 from public.bk_applied where name='$(basename $f)'\"" 2>/dev/null | grep -q 1; then
    grep -v -- '-- @storage' "$f" | su postgres -c "$P"
    su postgres -c "$P -c \"create table if not exists public.bk_applied(name text primary key); insert into public.bk_applied values ('$(basename $f)')\""
  fi
done
cp $KIT/gateway.ts $KIT/wrap.ts $KIT/static.mjs $KIT/start.sh $KIT/up.sh /tmp/bktest/ && cp $KIT/pgrst.conf /tmp/pgrst.conf && chmod +x /tmp/bktest/*.sh
if [ ! -f /tmp/keys.env ]; then
  deno eval '
    const secret = "local-test-secret-local-test-secret-1234";
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    const jwt = async (role) => { const h = enc({alg:"HS256",typ:"JWT"}) + "." + enc({role, iss:"local", exp: 2000000000});
      const s = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(h)));
      return h + "." + btoa(String.fromCharCode(...s)).replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_"); };
    console.log("SERVICE=" + await jwt("service_role")); console.log("ANON=" + await jwt("anon"));' > /tmp/keys.env
fi
echo "setup ok"
