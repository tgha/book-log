# 5단계 서버 시험: 공개(책 단위) · 둘러보기 · 달별 통계 · 이어서 읽은 날
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
IMG=open("/tmp/bktest/tiny.jpg.b64").read().strip() if __import__("os").path.exists("/tmp/bktest/tiny.jpg.b64") else None
if IMG is None:
    import base64
    from PIL import Image; import io
    b=io.BytesIO(); Image.new("RGB",(60,80),(200,180,150)).save(b,"JPEG"); IMG=base64.b64encode(b.getvalue()).decode()
    open("/tmp/bktest/tiny.jpg.b64","w").write(IMG)
today=(datetime.datetime.utcnow()+datetime.timedelta(hours=9)).date()
TODAY=today.isoformat(); MONTH=TODAY[:7]
sql("delete from bk_users; delete from bk_books;")
s,b=call("bk-auth","/signup",{"username":"reader_a","password":"reading2026","display_name":"가나"}); A=b["token"]
s,b=call("bk-auth","/signup",{"username":"reader_b","password":"reading2026","display_name":"다라"}); B=b["token"]
sql("update bk_users set status='approved'")
A_id=sql("select id from bk_users where username='reader_a'")
s,b=call("bk-api","/shelf/add",{"token":A,"isbn":"9788934972464","total_pages":636}); SA=b["item"]["id"]
s,b=call("bk-api","/shelf/add",{"token":A,"isbn":"9791168503342"}); SA2=b["item"]["id"]
s,b=call("bk-api","/shelf/add",{"token":B,"isbn":"9788934972464"}); SB=b["item"]["id"]

# ── 공개 스위치 ──
check("처음엔 모두 비공개",sql("select count(*) from bk_shelf where is_public")=="0")
s,b=call("bk-api","/shelf/update",{"token":A,"shelf_id":SA,"is_public":"네"}); check("공개 값은 켬/끔만",s==400,(s,b))
s,b=call("bk-api","/shelf/update",{"token":B,"shelf_id":SA,"is_public":True}); check("남의 책은 공개 못 켬",s==404,(s,b))
s,b=call("bk-api","/shelf/update",{"token":A,"shelf_id":SA,"is_public":True}); check("공개 켜기",s==200 and b["item"]["is_public"] is True,(s,b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":"공개할 문장이에요.","page":10,"thought":"좋다","keep_photo":True,"photo":IMG}); N1=b["item"]
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA2,"kind":"capture","body":"비공개 문장이에요."}); N2=b["item"]
call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":40,"read_on":TODAY,"end_page":100})

s,b=call("bk-api","/public/book",{"token":B,"shelf_id":SA})
check("공개 책: 주인 이름 · 메모 · 사진 주소 · 독서 시간 합계",s==200 and b["owner"]["display_name"]=="가나" and len(b["notes"])==1 and b["notes"][0]["thought"]=="좋다" and "token=" in (b["notes"][0]["photo_url"] or "") and b["total_minutes"]==40,(s,b))
check("사진 위치는 안 나감","photo_path" not in json.dumps(b))
s,b=call("bk-api","/public/book",{"token":B,"shelf_id":SA2}); check("비공개 책은 못 봄",s==404 and b["code"]=="NOT_PUBLIC",(s,b))
s,b=call("bk-api","/public/book",{"shelf_id":SA}); check("로그인 안 하면 못 봄",s==401,(s,b))
sql("update bk_users set status='pending' where username='reader_b'")
s,b=call("bk-api","/public/book",{"token":B,"shelf_id":SA}); check("승인 전 회원도 못 봄",s==403,(s,b))
sql("update bk_users set status='approved' where username='reader_b'")
s,b=call("bk-api","/public/users",{"token":B}); U=b.get("users",[])
check("둘러보기 회원 목록(공개 1권)",s==200 and len(U)==1 and U[0]["display_name"]=="가나" and U[0]["books"]==1 and U[0]["me"] is False,(s,b))
s,b=call("bk-api","/public/users",{"token":A}); check("내 것은 「나」로 표시",s==200 and b["users"][0]["me"] is True,(s,b))
s,b=call("bk-api","/public/shelf",{"token":B,"user_id":A_id}); P=b.get("items",[])
check("회원의 공개 책장(메모 수 · 읽은 시간)",s==200 and len(P)==1 and P[0]["id"]==SA and P[0]["note_count"]==1 and P[0]["total_minutes"]==40,(s,b))
check("공개 책장에 비공개 책은 없음",all(x["id"]!=SA2 for x in P))
s,b=call("bk-api","/public/recent",{"token":B}); R=b.get("items",[])
check("최근 공개 문장",s==200 and len(R)==1 and R[0]["text"]=="공개할 문장이에요." and R[0]["owner"]["display_name"]=="가나" and R[0]["book"]["title"]=="사피엔스" and R[0]["has_photo"] is True,(s,b))
s,b=call("bk-api","/shelf/update",{"token":A,"shelf_id":SA,"is_public":False})
s,b=call("bk-api","/public/book",{"token":B,"shelf_id":SA}); check("공개를 끄면 즉시 안 보임",s==404,(s,b))
s,b=call("bk-api","/public/recent",{"token":B}); check("최근 문장에서도 사라짐",s==200 and b["items"]==[],(s,b))
s,b=call("bk-api","/public/users",{"token":B}); check("회원 목록에서도 사라짐",s==200 and b["users"]==[],(s,b))
call("bk-api","/shelf/update",{"token":A,"shelf_id":SA,"is_public":True})

# ── 통계 ──
def d(n): return (today-datetime.timedelta(days=n)).isoformat()
sql(f"delete from bk_reading_logs where user_id='{A_id}'")
for day,mins in [(d(0),30),(d(0),25),(d(1),60),(d(2),15),(d(40),90)]:
    call("bk-api","/logs/add",{"token":A,"shelf_id":SA,"minutes":mins,"read_on":day})
call("bk-api","/logs/add",{"token":A,"shelf_id":SA2,"minutes":20,"read_on":d(1)})
s,b=call("bk-api","/stats",{"token":A,"month":"2026-13"}); check("이상한 달 거부",s==400,(s,b))
s,b=call("bk-api","/stats",{"token":A}); ST=b
mine=[x for x in [d(0),d(1),d(2)] if x[:7]==MONTH]
check("이번 달 통계: 합계 · 달력 · 읽은 날",s==200 and ST["month"]==MONTH and ST["calendar"].get(d(0))==55 and ST["read_days"]==len(mine),(s,ST.get("calendar")))
check("하루 평균은 이번 달 오늘까지로 나눔",ST["average_over"]==int(TODAY[8:]) and ST["average_minutes"]==round(ST["total_minutes"]/int(TODAY[8:])),ST)
check("이어서 읽은 날 3일 · 최고 3일",ST["streak"]==3 and ST["best_streak"]==3,(ST.get("streak"),ST.get("best_streak")))
check("가장 긴 한 번 기록(60분)",ST["longest_minutes"]==60,ST.get("longest_minutes"))
check("그 달에 조금이라도 읽은 책 2권",ST["books_read"]==2,ST.get("books_read"))
check("그 달 메모 수(공개 1 + 비공개 1)",ST["note_count"]==2,ST.get("note_count"))
check("읽는 중인 책 목록",len(ST["reading"])==2 and ST["books_finished"]==0,(len(ST["reading"]),ST["books_finished"]))
call("bk-api","/shelf/update",{"token":A,"shelf_id":SA,"status":"finished"})
s,b=call("bk-api","/stats",{"token":A}); check("다 읽은 책이 이번 달 통계에",b["books_finished"]==1 and b["finished"][0]["book"]["title"]=="사피엔스",(b["books_finished"],))
last=(today.replace(day=1)-datetime.timedelta(days=1)).isoformat()[:7]
s,b=call("bk-api","/stats",{"token":A,"month":last})
check("지난달로 넘기면 그 달만",s==200 and b["month"]==last and b["average_over"]==b["days"],(s,b.get("month")))
s,b=call("bk-api","/stats/streak",{"token":A})
check("서재용 요약(이어서 3일 · 오늘 55분)",s==200 and b["streak"]==3 and b["today_minutes"]==55,(s,b))
s,b=call("bk-api","/stats",{"token":B}); check("다른 회원 통계는 자기 것만",s==200 and b["total_minutes"]==0 and b["streak"]==0,(s,b))
sql(f"delete from bk_reading_logs where user_id='{A_id}' and read_on='{d(0)}'")
s,b=call("bk-api","/stats/streak",{"token":A}); check("오늘 안 읽어도 어제까지 이어졌으면 유지(2일)",b["streak"]==2 and b["today_minutes"]==0,(s,b))
sql(f"delete from bk_reading_logs where user_id='{A_id}' and read_on='{d(1)}'")
s,b=call("bk-api","/stats/streak",{"token":A}); check("이틀 끊기면 0일",b["streak"]==0,(s,b))
s,b=call("bk-api","/shelf/remove",{"token":A,"shelf_id":SA})
s,b=call("bk-api","/public/users",{"token":B}); check("책을 빼면 공개 목록에서도 빠짐",s==200 and b["users"]==[],(s,b))
print(f"\n{sum(res)}/{len(res)} 통과")
