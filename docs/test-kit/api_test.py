import json, urllib.request, subprocess, os
os.environ["NO_PROXY"]="*"
BASE="http://127.0.0.1:8000/functions/v1"
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(fn, path, body=None, method="POST"):
    req=urllib.request.Request(f"{BASE}/{fn}{path}", data=None if method!="POST" else json.dumps(body or {}).encode(), method=method, headers={"content-type":"application/json","Origin":"https://book-log-tgha-9389s-projects.vercel.app"})
    try:
        r=opener.open(req); raw=r.read()
        try: return r.status, json.loads(raw or b"{}"), r.headers
        except Exception: return r.status, {"raw":raw.decode()}, r.headers
    except urllib.error.HTTPError as e:
        raw=e.read()
        try: return e.code, json.loads(raw), e.headers
        except Exception: return e.code, {"raw":raw.decode()}, e.headers
def sql(q):
    return subprocess.run(["su","postgres","-c",f"psql -h /tmp/pgtest -p 55432 -U postgres -At -c \"{q}\""],capture_output=True,text=True).stdout.strip()
results=[]
def check(name, cond, info=""):
    results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ")+name+("" if cond else f"  -> {info}"))

sql("delete from bk_users; delete from bk_books;")
s,b,_=call("bk-auth","/signup",{"username":"A B","password":"abcd1234","display_name":"x"}); check("잘못된 아이디 거부", s==400, (s,b))
s,b,_=call("bk-auth","/signup",{"username":"alice","password":"short1","display_name":"앨리스"}); check("짧은 비밀번호 거부", s==400, (s,b))
s,b,_=call("bk-auth","/signup",{"username":"alice","password":"abcdefgh","display_name":"앨리스"}); check("숫자 없는 비밀번호 거부", s==400, (s,b))
s,b,_=call("bk-auth","/signup",{"username":"Alice","password":"reading2026","display_name":"  앨리스  "}); check("가입 성공 → 대기", s==200 and b["user"]["status"]=="pending" and b["user"]["username"]=="alice" and b["user"]["display_name"]=="앨리스", (s,b))
alice=b.get("token","")
check("비밀번호 원문이 DB에 없음", "reading2026" not in sql("select password_hash from bk_users where username='alice'") and sql("select password_hash from bk_users where username='alice'").startswith("pbkdf2$210000$"))
check("출입증 원문이 DB에 없음", sql(f"select count(*) from bk_sessions where token_hash='{alice}'")=="0" and sql("select count(*) from bk_sessions")=="1")
s,b,_=call("bk-auth","/signup",{"username":"alice","password":"reading2026","display_name":"다른"}); check("같은 아이디 가입 거부", s==409, (s,b))
s,b,_=call("bk-auth","/me",{"token":alice}); check("대기 회원 /me", s==200 and b["user"]["status"]=="pending", (s,b))
s,b,_=call("bk-admin","/users",{"token":alice}); check("대기 회원은 관리자 기능 불가", s==403, (s,b))
s,b,_=call("bk-auth","/me",{"token":"not-a-real-token-123456789"}); check("가짜 출입증 거부", s==401, (s,b))
# 첫 관리자 만들기 (실제로는 사용자 승인 후 명령 한 줄)
sql("update bk_users set status='approved', is_admin=true, approved_at=now() where username='alice'")
s,b,_=call("bk-auth","/me",{"token":alice}); check("관리자 승인 후 /me", s==200 and b["user"]["is_admin"] and b["user"]["status"]=="approved", (s,b))
# 비밀번호 틀리기와 잠금
for i in range(1,5):
    s,b,_=call("bk-auth","/login",{"username":"alice","password":"wrong"+str(i)+"aaa"})
check("틀린 비밀번호 4번째까지 401 + 횟수 안내", s==401 and "(4/5번)" in b["error"], (s,b))
s,b,_=call("bk-auth","/login",{"username":"alice","password":"wrong5aaa"}); check("5번째 틀리면 잠금 423", s==423, (s,b))
s,b,_=call("bk-auth","/login",{"username":"alice","password":"reading2026"}); check("잠긴 동안은 맞는 비밀번호도 거부", s==423 and "분 뒤" in b["error"], (s,b))
sql("update bk_users set locked_until=null where username='alice'")
s,b,_=call("bk-auth","/login",{"username":"ALICE","password":"reading2026"}); check("잠금 풀린 뒤 로그인(대문자 아이디도 됨)", s==200 and b.get("token"), (s,b))
alice2=b.get("token")
s,b,_=call("bk-auth","/login",{"username":"nobody","password":"reading2026"}); check("없는 아이디는 같은 문구", s==401 and "아이디 또는 비밀번호" in b["error"], (s,b))
# 두 번째 회원
s,b,_=call("bk-auth","/signup",{"username":"bob_1","password":"bookworm99","display_name":"밥"}); bob=b.get("token"); check("두 번째 가입", s==200, (s,b))
s,b,_=call("bk-admin","/users",{"token":alice}); check("회원 목록: 대기 먼저", s==200 and b["users"][0]["username"]=="bob_1" and b["users"][0]["status"]=="pending", (s,b))
bob_id=b["users"][0]["id"]; alice_id=[u for u in b["users"] if u["username"]=="alice"][0]["id"]
check("목록에 비밀번호 정보 없음", all("password_hash" not in u for u in b["users"]))
s,b,_=call("bk-admin","/approve",{"token":alice,"user_id":bob_id}); check("승인", s==200 and b["user"]["status"]=="approved", (s,b))
s,b,_=call("bk-admin","/approve",{"token":alice,"user_id":bob_id}); check("두 번 승인하면 이미 처리됨", s==409, (s,b))
s,b,_=call("bk-auth","/me",{"token":bob}); check("승인된 회원 /me", s==200 and b["user"]["status"]=="approved", (s,b))
s,b,_=call("bk-admin","/users",{"token":bob}); check("일반 회원은 관리자 기능 불가", s==403, (s,b))
s,b,_=call("bk-admin","/disable",{"token":alice,"user_id":alice_id}); check("관리자 자기 자신 중지 불가", s==400, (s,b))
s,b,_=call("bk-admin","/disable",{"token":alice,"user_id":bob_id}); check("사용 중지", s==200 and b["user"]["status"]=="disabled", (s,b))
s,b,_=call("bk-auth","/me",{"token":bob}); check("중지되면 기존 출입증 끊김", s==401, (s,b))
s,b,_=call("bk-auth","/login",{"username":"bob_1","password":"bookworm99"}); check("중지된 회원 로그인 거부", s==403 and "중지" in b["error"], (s,b))
s,b,_=call("bk-auth","/login",{"username":"bob_1","password":"wrongpass1"}); check("중지 회원도 비번 틀리면 상태 안 알려줌", s==401, (s,b))
s,b,_=call("bk-admin","/enable",{"token":alice,"user_id":bob_id}); check("다시 승인", s==200 and b["user"]["status"]=="approved", (s,b))
s,b,_=call("bk-admin","/reset-password",{"token":alice,"user_id":bob_id}); temp=b.get("temp_password",""); check("임시 비밀번호 발급", s==200 and len(temp)==10, (s,b))
s,b,_=call("bk-auth","/login",{"username":"bob_1","password":"bookworm99"}); check("옛 비밀번호는 안 됨", s==401, (s,b))
s,b,_=call("bk-auth","/login",{"username":"bob_1","password":temp}); bobA=b.get("token"); check("임시 비밀번호로 로그인", s==200, (s,b))
s,b,_=call("bk-auth","/login",{"username":"bob_1","password":temp}); bobB=b.get("token")
s,b,_=call("bk-auth","/password",{"token":bobA,"current_password":"wrong","new_password":"newpass2026"}); check("지금 비밀번호 틀리면 변경 거부", s==401, (s,b))
s,b,_=call("bk-auth","/password",{"token":bobA,"current_password":temp,"new_password":"newpass2026"}); check("비밀번호 변경", s==200, (s,b))
s1,_,_=call("bk-auth","/me",{"token":bobA}); s2,_,_=call("bk-auth","/me",{"token":bobB}); check("바꾼 기기는 유지, 다른 기기는 끊김", s1==200 and s2==401, (s1,s2))
s,b,_=call("bk-auth","/profile",{"token":bobA,"display_name":"밥 스미스"}); check("이름 바꾸기", s==200 and b["user"]["display_name"]=="밥 스미스", (s,b))
s,b,_=call("bk-admin","/settings/set",{"token":alice,"key":"ocr_daily_limit","value":0}); check("한도 0 거부", s==400, (s,b))
s,b,_=call("bk-admin","/settings/set",{"token":alice,"key":"ocr_daily_limit","value":150}); check("한도 150 저장", s==200, (s,b))
s,b,_=call("bk-admin","/settings",{"token":alice}); check("설정 읽기", s==200 and b["settings"]["ocr_daily_limit"]==150, (s,b))
sql("update bk_settings set value='100' where key='ocr_daily_limit'")
s,b,_=call("bk-admin","/settings/set",{"token":alice,"key":"is_admin","value":1}); check("정해진 설정 말고는 못 바꿈", s==400, (s,b))
s,b,_=call("bk-auth","/logout",{"token":bobA}); s2,_,_=call("bk-auth","/me",{"token":bobA}); check("로그아웃하면 출입증 끊김", s==200 and s2==401, (s,s2))
s,b,h=call("bk-auth","/me",None,method="OPTIONS"); check("브라우저 사전 확인(OPTIONS) + CORS", s==200 and h.get("Access-Control-Allow-Origin")=="*", (s,dict(h)))
s,b,_=call("bk-auth","/nothing",{}); check("없는 기능 404", s==404, (s,b))
s,b,_=call("bk-auth","/me",None,method="GET"); check("GET 거부 405", s==405, (s,b))
# 가짜 가입 폭주 막기
for i in range(30):
    call("bk-auth","/signup",{"username":f"spam{i:02d}","password":"spam12345","display_name":"s"})
s,b,_=call("bk-auth","/signup",{"username":"spam99","password":"spam12345","display_name":"s"}); check("대기 30명 넘으면 새 가입 막음", s==429, (s,b))
print(f"\n{sum(ok for _,ok in results)}/{len(results)} 통과")
