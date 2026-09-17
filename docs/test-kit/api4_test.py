# 4단계 서버 시험: 독서 시간 (타이머 · 손으로 적기 · 목록 · 고치기 · 지우기)
import json, urllib.request, subprocess, datetime
BASE="http://127.0.0.1:8000/functions/v1"
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(fn,path,body):
    req=urllib.request.Request(f"{BASE}/{fn}{path}",data=json.dumps(body).encode(),method="POST",headers={"content-type":"application/json"})
    try: r=op.open(req); return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw=e.read()
        try: return e.code,json.loads(raw)
        except Exception: return e.code,{"raw":raw.decode()}
def sql(q): return subprocess.run(["su","postgres","-c",f"psql -h /tmp/pgtest -p 55432 -U postgres -Atq -c \"{q}\""],capture_output=True,text=True).stdout.strip()
res=[]
def check(n,c,i=""): res.append(bool(c)); print(("PASS " if c else "FAIL ")+n+("" if c else f" -> {str(i)[:400]}"))
kst_today=(datetime.datetime.utcnow()+datetime.timedelta(hours=9)).date().isoformat()
sql("delete from bk_users; delete from bk_books;")
s,b=call("bk-auth","/signup",{"username":"reader_a","password":"reading2026","display_name":"가"}); A=b["token"]
s,b=call("bk-auth","/signup",{"username":"reader_b","password":"reading2026","display_name":"나"}); B=b["token"]
s,b=call("bk-api","/logs/running",{"token":A}); check("대기 회원은 못 씀",s==403,(s,b))
sql("update bk_users set status='approved'")
s,b=call("bk-api","/shelf/add",{"token":A,"isbn":"9788934972464","status":"want","total_pages":636}); SA=b["item"]["id"]
s,b=call("bk-api","/shelf/add",{"token":A,"isbn":"9791168503342","status":"reading"}); SM=b["item"]["id"]
s,b=call("bk-api","/shelf/add",{"token":B,"isbn":"9788934972464"}); SB=b["item"]["id"]

s,b=call("bk-api","/logs/running",{"token":A}); check("처음엔 돌고 있는 타이머 없음 + 서버 시각",s==200 and b["item"] is None and b["now"],(s,b))
s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SA}); T=b.get("item",{})
check("타이머 시작(책 정보 · 한국 날짜)",s==200 and T["method"]=="timer" and T["ended_at"] is None and T["read_on"]==kst_today and T["shelf"]["book"]["title"]=="사피엔스",(s,b))
check("읽고 싶은 책 → 읽는 중 · 시작한 날",sql(f"select status||'/'||(started_on is not null)::text from bk_shelf where id='{SA}'")=="reading/true")
s,b=call("bk-api","/logs/running",{"token":A}); check("다시 열어도 같은 타이머(서버에 적힘)",s==200 and b["item"]["id"]==T["id"],(s,b))
s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SM}); check("다른 책 타이머는 못 켬(책 이름 · 번호 알려 줌)",s==409 and "사피엔스" in b["error"] and b["code"]=="RUNNING:"+SA,(s,b))
s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SA}); check("같은 책 두 번 시작도 막음",s==409,(s,b))
s,b=call("bk-api","/logs/start",{"token":B,"shelf_id":SB}); check("다른 사람은 따로 켤 수 있음",s==200,(s,b)); TB=b.get("item",{})
s,b=call("bk-api","/logs/stop",{"token":B,"log_id":T["id"]}); check("남의 타이머는 못 멈춤",s==404,(s,b))
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T["id"]}); check("1분도 안 되면 저장 거부",s==400 and b["code"]=="TOO_SHORT",(s,b))
sql(f"update bk_reading_logs set started_at=now()-interval '32 minutes 20 seconds' where id='{T['id']}'")
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T["id"],"minutes":50}); check("타이머보다 긴 시간은 거부",s==400,(s,b))
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T["id"],"end_page":700}); check("전체 쪽수보다 많은 쪽 거부",s==400 and "636" in b["error"],(s,b))
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T["id"],"end_page":120}); S1=b.get("item",{})
check("멈추면 32분 · 끝낸 쪽 저장",s==200 and S1["minutes"]==32 and S1["end_page"]==120 and S1["ended_at"],(s,b))
check("서재 읽은 쪽도 120으로",sql(f"select current_page from bk_shelf where id='{SA}'")=="120")
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T["id"]}); check("이미 끝난 타이머는 다시 못 멈춤",s==409,(s,b))
s,b=call("bk-api","/logs/running",{"token":A}); check("멈춘 뒤엔 돌고 있는 타이머 없음",b["item"] is None,(s,b))

# 멈춤을 잊음 · 자정 넘김
s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SM}); T2=b["item"]
sql(f"update bk_reading_logs set started_at=(date_trunc('day', now() at time zone 'Asia/Seoul') - interval '1 hour') at time zone 'Asia/Seoul' - interval '6 hours', read_on=((now() at time zone 'Asia/Seoul')::date - 1) where id='{T2['id']}'")
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T2["id"],"minutes":90,"end_page":40}); S2=b.get("item",{})
check("오래 켜 둔 타이머는 실제 읽은 시간(90분)으로 고쳐 저장",s==200 and S2["minutes"]==90,(s,b))
check("자정을 넘겨도 시작한 날로",S2.get("read_on")==(datetime.date.fromisoformat(kst_today)-datetime.timedelta(days=1)).isoformat(),S2)
s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SM}); T3=b["item"]
sql(f"update bk_reading_logs set started_at=now()-interval '30 hours' where id='{T3['id']}'")
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":T3["id"]}); check("시간을 안 주면 최대 24시간(1440분)으로",s==200 and b["item"]["minutes"]==1440,(s,b))
s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SM}); T4=b["item"]
s,b=call("bk-api","/logs/cancel",{"token":A,"log_id":T4["id"]}); check("기록하지 않고 끝내기 → 사라짐",s==200 and sql(f"select count(*) from bk_reading_logs where id='{T4['id']}'")=="0",(s,b))
check("끝낸 쪽이 지금보다 앞이면 서재 쪽은 그대로(돈의 심리학 40)",sql(f"select coalesce(current_page,-1) from bk_shelf where id='{SM}'")=="40")

# 손으로 적기
s,b=call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":0}); check("0분 거부",s==400,(s,b))
s,b=call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":2000}); check("24시간 넘는 시간 거부",s==400,(s,b))
s,b=call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":30,"read_on":"2099-01-01"}); check("미래 날짜 거부",s==400,(s,b))
s,b=call("bk-api","/logs/add",{"token":B,"shelf_id":SA,"minutes":30}); check("남의 책에 적기 불가",s==404,(s,b))
s,b=call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":45,"read_on":"2026-09-01","end_page":100}); M1=b.get("item",{})
check("손으로 적기(날짜 · 분 · 쪽)",s==200 and M1["method"]=="manual" and M1["minutes"]==45 and M1["read_on"]=="2026-09-01",(s,b))
check("앞쪽(100)을 적으면 서재 읽은 쪽(120)은 그대로",sql(f"select current_page from bk_shelf where id='{SA}'")=="120")
s,b=call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":20}); M2=b.get("item",{}); check("날짜를 비우면 오늘",s==200 and M2["read_on"]==kst_today,(s,b))

s,b=call("bk-api","/logs/start",{"token":A,"shelf_id":SA}); RUN=b["item"]
s,b=call("bk-api","/logs/list",{"token":A,"shelf_id":SA})
check("목록: 끝난 기록만 · 최근 날짜 먼저 · 합계(32+45+20=97분)",s==200 and [x["minutes"] for x in b["items"]]==[20,32,45] and b["total_minutes"]==97,(s,b))
s,b=call("bk-api","/logs/update",{"token":A,"log_id":RUN["id"],"minutes":10}); check("돌고 있는 타이머는 고치기 불가",s==409,(s,b))
call("bk-api","/logs/cancel",{"token":A,"log_id":RUN["id"]})
s,b=call("bk-api","/logs/list",{"token":B,"shelf_id":SA}); check("남의 책 목록 불가",s==404,(s,b))
s,b=call("bk-api","/logs/update",{"token":A,"log_id":S1["id"],"minutes":35,"read_on":"2026-09-10","end_page":130}); U=b.get("item",{})
check("타이머 기록도 고치기(분 · 날짜 · 쪽)",s==200 and U["minutes"]==35 and U["read_on"]=="2026-09-10" and U["end_page"]==130 and U["method"]=="timer",(s,b))
s,b=call("bk-api","/logs/update",{"token":A,"log_id":S1["id"],"minutes":-5}); check("고칠 때도 잘못된 분 거부",s==400,(s,b))
s,b=call("bk-api","/logs/update",{"token":B,"log_id":S1["id"],"minutes":5}); check("남의 기록은 못 고침",s==404,(s,b))
s,b=call("bk-api","/logs/remove",{"token":B,"log_id":M1["id"]}); check("남의 기록은 못 지움",s==404,(s,b))
s,b=call("bk-api","/logs/remove",{"token":A,"log_id":M1["id"]}); check("지우기",s==200 and sql(f"select count(*) from bk_reading_logs where id='{M1['id']}'")=="0",(s,b))
s,b=call("bk-api","/logs/stop",{"token":A,"log_id":"nope"}); check("이상한 번호 400",s==400,(s,b))
s,b=call("bk-api","/shelf/remove",{"token":A,"shelf_id":SA}); check("서재에서 빼면 독서 시간도 지워짐",s==200 and sql(f"select count(*) from bk_reading_logs where shelf_id='{SA}'")=="0",(s,b))
print(f"\n{sum(res)}/{len(res)} 통과")
