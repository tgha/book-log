#!/bin/sh
. /tmp/keys.env
export DENO_DIR=/tmp/deno-cache DENO_TLS_CA_STORE=system NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost'
F=/home/claude/book-log/supabase/functions
for p in $(cat /tmp/bktest/pids 2>/dev/null); do kill $p 2>/dev/null; done; : > /tmp/bktest/pids
SERVICE=$SERVICE setsid nohup deno run --allow-net --allow-env --allow-read /tmp/bktest/gateway.ts > /tmp/bktest/gw.log 2>&1 < /dev/null & echo $! >> /tmp/bktest/pids
port=9001
for fn in bk-auth bk-admin bk-book bk-api bk-ocr; do
  FN_PORT=$port FN_FILE=file://$F/$fn/index.ts SUPABASE_URL=http://127.0.0.1:8000 SUPABASE_SERVICE_ROLE_KEY=$SERVICE BK_KAKAO_REST_KEY=test-key BK_KAKAO_BASE=http://127.0.0.1:8000 BK_GOOGLE_VISION_KEY=test-vision-key BK_VISION_BASE=http://127.0.0.1:8000 \
    setsid nohup deno run --allow-net --allow-env --allow-read /tmp/bktest/wrap.ts > /tmp/bktest/$fn.log 2>&1 < /dev/null & echo $! >> /tmp/bktest/pids
  port=$((port+1))
done
sleep 7
