#!/bin/sh
# 로컬 시험 환경을 (필요하면) 다시 켬: DB → PostgREST → 게이트웨이·함수 → 웹
PGBIN=/usr/lib/postgresql/16/bin
if ! su postgres -c "psql -h /tmp/pgtest -p 55432 -U postgres -Atqc 'select 1'" >/dev/null 2>&1; then
  rm -f /tmp/pgtest/data/postmaster.pid
  su postgres -c "setsid $PGBIN/pg_ctl -D /tmp/pgtest/data -o '-p 55432 -k /tmp/pgtest -h 127.0.0.1' -l /tmp/pgtest/log start" >/dev/null
  sleep 3
fi
curl -s --noproxy '*' -o /dev/null http://127.0.0.1:3000/ || { setsid nohup postgrest /tmp/pgrst.conf > /tmp/pgrst.log 2>&1 < /dev/null & sleep 2; }
curl -s --noproxy '*' -o /dev/null -X OPTIONS http://127.0.0.1:8000/functions/v1/bk-auth/me && curl -s --noproxy "*" -o /dev/null -X OPTIONS http://127.0.0.1:9004/bk-api/shelf/list && curl -s --noproxy "*" -o /dev/null -X OPTIONS http://127.0.0.1:9005/bk-ocr/quota || /tmp/bktest/start.sh
curl -s --noproxy '*' -o /dev/null http://127.0.0.1:8080/ || { cd /tmp/bktest && setsid nohup node static.mjs > static.log 2>&1 < /dev/null & sleep 1; }
for u in http://127.0.0.1:3000/ http://127.0.0.1:8080/; do printf "%s " "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $u)"; done
printf "%s\n" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X OPTIONS http://127.0.0.1:8000/functions/v1/bk-admin/users)"
