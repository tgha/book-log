# 3단계 서버 시험: bk-ocr(글자 읽기 · 하루 한도) · bk-api(메모 · 밑줄 · 사진) · bk-admin(사용량)
import json, urllib.request, subprocess, base64, io, threading
from PIL import Image
BASE="http://127.0.0.1:8000/functions/v1"; GW="http://127.0.0.1:8000"
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(fn,path,body):
    req=urllib.request.Request(f"{BASE}/{fn}{path}",data=json.dumps(body).encode(),method="POST",headers={"content-type":"application/json"})
    try: r=op.open(req); return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw=e.read()
        try: return e.code,json.loads(raw)
        except Exception: return e.code,{"raw":raw.decode()}
def get(url):
    try: r=op.open(url); return r.status, r.read(), r.headers.get("content-type")
    except urllib.error.HTTPError as e: return e.code, e.read(), ""
def vision(mode="ok", text=""):
    return json.loads(get(f"{GW}/__vision?mode={mode}&text={urllib.parse.quote(text)}")[1])
def photos(): return json.loads(get(f"{GW}/__photos")[1])["paths"]
def sql(q): return subprocess.run(["su","postgres","-c",f"psql -h /tmp/pgtest -p 55432 -U postgres -Atq -c \"{q}\""],capture_output=True,text=True).stdout.strip()
res=[]
def check(n,c,i=""): res.append(bool(c)); print(("PASS " if c else "FAIL ")+n+("" if c else f" -> {str(i)[:400]}"))
def jpeg(w=400,h=300,q=80):
    im=Image.new("RGB",(w,h),(250,248,240)); b=io.BytesIO(); im.save(b,"JPEG",quality=q); return base64.b64encode(b.getvalue()).decode()
IMG=jpeg()
import urllib.parse
sql("delete from bk_users; delete from bk_books; update bk_settings set value='100' where key='ocr_daily_limit';")
vision("ok")
s,b=call("bk-auth","/signup",{"username":"reader_a","password":"reading2026","display_name":"가"}); A=b["token"]
s,b=call("bk-auth","/signup",{"username":"reader_b","password":"reading2026","display_name":"나"}); B=b["token"]
s,b=call("bk-ocr","/quota",{"token":A}); check("대기 회원은 글자 읽기 불가",s==403,(s,b))
s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("대기 회원은 읽기 요청도 불가",s==403,(s,b))
sql("update bk_users set status='approved'; update bk_users set is_admin=true where username='reader_a'")
A_id=sql("select id from bk_users where username='reader_a'")

# ── 글자 읽기 ──
s,b=call("bk-ocr","/quota",{"token":A}); check("처음 사용량 0/100 + 사진 남기기 기억값(처음 꺼짐)",s==200 and b=={"used":0,"limit":100,"keep_photo":False},(s,b))
s,b=call("bk-ocr","/read",{"token":A}); check("사진 없음 → 쉬운 안내",s==400 and b["code"]=="BAD_IMAGE",(s,b))
s,b=call("bk-ocr","/read",{"token":A,"image":base64.b64encode(b"hello this is not a picture at all"*10).decode()}); check("사진이 아닌 파일 거부",s==400 and b["code"]=="BAD_IMAGE",(s,b))
s,b=call("bk-ocr","/read",{"token":A,"image":"@@@not-base64@@@"}); check("망가진 데이터 거부",s==400,(s,b))
s,b=call("bk-ocr","/read",{"token":A,"image":"A"*(6*1024*1024)}); check("너무 큰 사진 413",s==413 and b["code"]=="IMAGE_TOO_BIG",(s,b))
check("잘못된 요청은 횟수에 안 셈",sql("select count(*) from bk_ocr_usage")=="0")
before=vision("ok")["calls"]
s,b=call("bk-ocr","/read",{"token":A,"image":"data:image/jpeg;base64,"+IMG}); check("글자 읽기 성공",s==200 and "우리가 어떤 사건을" in b.get("text","") and b["used"]==1 and b["limit"]==100,(s,b))
check("끝 줄바꿈 정리",s==200 and not b["text"].endswith("\n"),b)
v=vision("ok"); check("구글에 문서용 글자 읽기 · 한국어 우선으로 요청",v["calls"]==before+1 and v["last"]["features"]==[{"type":"DOCUMENT_TEXT_DETECTION"}] and v["last"]["hints"][0]=="ko",v)
check("화면으로 열쇠가 나가지 않음","test-vision-key" not in json.dumps(b))
check("열쇠는 주소가 아니라 머리글로 보냄",v["last"]["key"]=="test-vision-key" and v["last"]["keyInUrl"] is False,v)
check("사용 기록: 성공 · 한국 날짜 · 사진 크기",sql("select ok::text||'/'||(used_on=(now() at time zone 'Asia/Seoul')::date)::text||'/'||(image_bytes>100)::text||'/'||coalesce(error,'-') from bk_ocr_usage")=="true/true/true/-")
s,b=call("bk-ocr","/quota",{"token":A}); check("사용량 1",b.get("used")==1,(s,b))
vision("empty"); s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("글자 없음 → 422 + 다시 찍기 안내",s==422 and b["code"]=="NO_TEXT" and "다시 찍어" in b["error"],(s,b))
vision("badkey"); s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("열쇠 틀림 → 관리자에게 알리기 안내",s==502 and b["code"]=="VISION_AUTH" and "관리자" in b["error"],(s,b))
vision("denied"); s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("API 꺼짐(403) → 열쇠 문제로 안내",s==502 and b["code"]=="VISION_AUTH",(s,b))
vision("quota"); s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("구글 쪽 한도(429) 안내",s==502 and b["code"]=="VISION_QUOTA",(s,b))
vision("err500"); s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("구글 고장 → 다시 시도 안내",s==502 and b["code"]=="VISION_DOWN" and "다시 시도" in b["error"],(s,b))
vision("badimage"); s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("구글이 못 읽는 사진 → 400",s==400 and b["code"]=="BAD_IMAGE",(s,b))
check("구글에 보낸 것은 성공·실패 모두 기록(7번)",sql("select count(*) from bk_ocr_usage")=="7" and sql("select string_agg(coalesce(error,'-'),',' order by id) from bk_ocr_usage")=="-,NO_TEXT,VISION_AUTH,VISION_AUTH,VISION_QUOTA,VISION_DOWN,BAD_IMAGE", sql("select string_agg(coalesce(error,'-'),',' order by id) from bk_ocr_usage"))
vision("ok")
sql("update bk_settings set value='8' where key='ocr_daily_limit'")
s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("한도 8번째까지 성공",s==200 and b["used"]==8 and b["limit"]==8,(s,b))
calls=vision("ok")["calls"]
s,b=call("bk-ocr","/read",{"token":A,"image":IMG}); check("한도 넘으면 429 + 직접 입력 안내",s==429 and b["code"]=="OCR_LIMIT" and "직접 입력" in b["error"],(s,b))
check("한도 넘은 요청은 구글을 부르지 않고 기록도 안 남음",vision("ok")["calls"]==calls and sql("select count(*) from bk_ocr_usage")=="8")
s,b=call("bk-ocr","/quota",{"token":B}); check("한도는 사람마다 따로",b.get("used")==0 and b.get("limit")==8,(s,b))
sql("update bk_settings set value='3' where key='ocr_daily_limit'")
out=[]
def worker(): out.append(call("bk-ocr","/read",{"token":B,"image":IMG})[0])
ts=[threading.Thread(target=worker) for _ in range(6)]; [t.start() for t in ts]; [t.join() for t in ts]
check("동시에 6번 눌러도 한도 3번만 통과",sorted(out).count(200)==3 and sorted(out).count(429)==3 and sql(f"select count(*) from bk_ocr_usage u join bk_users x on x.id=u.user_id where x.username='reader_b'")=="3",(out))
sql("update bk_settings set value='100' where key='ocr_daily_limit'")
sql("update bk_ocr_usage set used_on=used_on-1 where user_id=(select id from bk_users where username='reader_b')")
s,b=call("bk-ocr","/quota",{"token":B}); check("어제 쓴 것은 오늘 한도에 안 셈",b.get("used")==0,(s,b))

# ── 메모 ──
s,b=call("bk-api","/shelf/add",{"token":A,"isbn":"9788934972464","status":"reading","total_pages":636}); SA=b["item"]["id"]
s,b=call("bk-api","/shelf/add",{"token":B,"isbn":"9788934972464","status":"reading"}); SB=b["item"]["id"]
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"thought","body":"   "}); check("빈 메모 거부",s==400,(s,b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"diary","body":"x"}); check("모르는 메모 종류 거부",s==400,(s,b))
s,b=call("bk-api","/notes/add",{"token":B,"shelf_id":SA,"kind":"thought","body":"남의 책"}); check("남의 서재 책에 메모 불가",s==404,(s,b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"thought","body":"사피엔스는 이야기의 힘을 말한다.","page":12,"thought":"무시돼야 함"}); T1=b.get("item",{})
check("내 생각 메모 저장",s==200 and T1["kind"]=="thought" and T1["page"]==12 and T1["thought"] is None and T1["book"]["title"]=="사피엔스" and not T1["has_photo"],(s,b))
BODY="우리가 어떤 사건을 현재의 눈으로 보면,\n그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다."
i1=BODY.index("현재의 눈"); e1=i1+len("현재의 눈으로 보면,"); i2=BODY.index("그 시대"); e2=len(BODY)
n_before=sql("select count(*) from bk_notes")
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":BODY,"page":339,"keep_photo":True,"photo":IMG,"highlights":[{"start":0,"end":999}]})
check("글과 안 맞는 밑줄 위치 거부",s==400 and "밑줄" in b["error"],(s,b))
check("거부되면 메모 · 사진이 남지 않음",sql("select count(*) from bk_notes")==n_before and photos()==[],photos())
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":BODY,"keep_photo":True,"photo":base64.b64encode(b"x"*500).decode()})
check("사진이 아닌 것은 저장 거부",s==400 and sql("select count(*) from bk_notes")==n_before,(s,b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":BODY,"page":339,"thought":"  지금 내 이야기 같다  ","keep_photo":True,"photo":IMG,
    "highlights":[{"start":i1-1,"end":e1+1,"text":"가짜 문장"},{"start":i2,"end":e2}]})
C1=b.get("item",{})
check("찍은 문장 + 사진 + 밑줄 2개 저장",s==200 and C1["kind"]=="capture" and C1["page"]==339 and C1["thought"]=="지금 내 이야기 같다" and C1["has_photo"] and len(C1["highlights"])==2,(s,b))
check("밑줄 문장은 서버가 메모 글에서 복사(앞뒤 공백 빼고)",s==200 and C1["highlights"][0]["text"]=="현재의 눈으로 보면," and C1["highlights"][0]["start_offset"]==i1 and C1["highlights"][1]["text"]==BODY[i2:],C1.get("highlights"))
check("[사진도 남기기] 선택을 계정에 기억",b.get("keep_photo") is True and sql("select keep_photo from bk_users where username='reader_a'")=="t",b)
check("사진은 회원별 칸에 저장",photos()==[f"{A_id}/{C1.get('id')}.jpg"] and sql(f"select photo_path from bk_notes where id='{C1.get('id')}'")==f"{A_id}/{C1.get('id')}.jpg",photos())
check("사진 위치는 화면으로 내보내지 않음","photo_path" not in json.dumps(b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":"사진은 버리는 메모","keep_photo":False,"photo":IMG}); C2=b.get("item",{})
check("사진 안 남기기 → 글자만 저장 · 선택 기억(꺼짐)",s==200 and not C2["has_photo"] and len(photos())==1 and b["keep_photo"] is False and sql("select keep_photo from bk_users where username='reader_a'")=="f",(s,b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":"","keep_photo":True,"photo":IMG}); C3=b.get("item",{})
check("글자 없이 사진만 남기기 허용",s==200 and C3["has_photo"] and C3["body"]=="",(s,b))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":"","keep_photo":False,"photo":IMG}); check("글자도 사진도 없으면 거부",s==400,(s,b))
s,b=call("bk-api","/notes/list",{"token":A,"shelf_id":SA}); check("책별 메모 목록(최근순, 책 정보 · 밑줄 포함)",s==200 and [x["id"] for x in b["items"]]==[C3["id"],C2["id"],C1["id"],T1["id"]] and b["items"][2]["book"]["title"]=="사피엔스" and len(b["items"][2]["highlights"])==2,(s,[x.get("body") for x in b.get("items",[])]))
s,b=call("bk-api","/notes/list",{"token":A}); check("전체 메모 목록",s==200 and len(b["items"])==4,(s,b))
s,b=call("bk-api","/notes/list",{"token":B}); check("남의 메모는 목록에 안 나옴",s==200 and b["items"]==[],(s,b))
s,b=call("bk-api","/notes/list",{"token":B,"shelf_id":SA}); check("남의 책 메모 목록 요청 404",s==404,(s,b))
s,b=call("bk-api","/notes/get",{"token":A,"note_id":C1["id"]}); url=b.get("item",{}).get("photo_url")
check("메모 하나 + 잠깐 열리는 사진 주소",s==200 and url and "token=" in url and b["item"]["photo_url_seconds"]==600,(s,b))
st,raw,ct=get(url) if url else (0,b"","")
check("사진 주소로 사진이 열림",st==200 and raw[:3]==b"\xff\xd8\xff" and ct=="image/jpeg",(st,ct))
check("열쇠 없이 창고 주소를 짐작해 열 수 없음",get(f"{GW}/storage/v1/object/sign/bk-photos/{A_id}/{C1['id']}.jpg?token=guess")[0]==400)
s,b=call("bk-api","/notes/get",{"token":B,"note_id":C1["id"]}); check("남의 메모는 못 봄",s==404,(s,b))
s,b=call("bk-api","/notes/get",{"token":A,"note_id":"not-a-uuid"}); check("잘못된 메모 번호 400",s==400,(s,b))
s,b=call("bk-api","/notes/update",{"token":B,"note_id":C1["id"],"body":"해킹"}); check("남의 메모는 못 고침",s==404,(s,b))
NEW=BODY.replace("현재의 눈으로 보면,","지금 눈으로 보면,")
s,b=call("bk-api","/notes/update",{"token":A,"note_id":C1["id"],"body":NEW,"page":340,"thought":""}); U=b.get("item",{})
check("메모 글 · 쪽수 · 한마디 고치기",s==200 and U["body"]==NEW and U["page"]==340 and U["thought"] is None,(s,b))
check("글을 고쳐도 밑줄 문장은 그대로",s==200 and U["highlights"][0]["text"]=="현재의 눈으로 보면,",U.get("highlights"))
check("글을 고치면 밑줄 자리를 다시 찾음(없어진 문장은 자리만 비움)",s==200 and U["highlights"][0]["start_offset"] is None and NEW[U["highlights"][1]["start_offset"]:U["highlights"][1]["end_offset"]]==U["highlights"][1]["text"],U.get("highlights"))
s,b=call("bk-api","/notes/update",{"token":A,"note_id":T1["id"],"thought":"x"}); check("내 생각 메모에 한마디 달기 거부",s==400,(s,b))
s,b=call("bk-api","/notes/update",{"token":A,"note_id":T1["id"],"page":-1}); check("음수 쪽수 거부",s==400,(s,b))
s,b=call("bk-api","/notes/update",{"token":A,"note_id":T1["id"],"body":"x"*20001}); check("20000자 넘는 글 거부",s==400,(s,b))
j=NEW.index("시대"); s,b=call("bk-api","/highlights/add",{"token":A,"note_id":C1["id"],"start":j,"end":j+2})
check("저장된 메모에 밑줄 더하기",s==200 and len(b["item"]["highlights"])==3 and b["item"]["highlights"][2]["text"]=="시대",(s,b))
s,b=call("bk-api","/highlights/add",{"token":A,"note_id":C1["id"],"start":5,"end":5}); check("빈 밑줄 거부",s==400,(s,b))
s,b=call("bk-api","/highlights/add",{"token":B,"note_id":C1["id"],"start":0,"end":3}); check("남의 메모에 밑줄 불가",s==404,(s,b))
s,b=call("bk-api","/highlights/list",{"token":A}); H=b.get("items",[])
check("밑줄 모아 보기(책 · 쪽수 포함)",s==200 and len(H)==3 and H[0]["text"]=="시대" and H[0]["page"]==340 and H[0]["book"]["title"]=="사피엔스",(s,b))
s,b=call("bk-api","/highlights/list",{"token":A,"shelf_id":SA}); check("책별 밑줄",s==200 and len(b["items"])==3,(s,b))
s,b=call("bk-api","/highlights/remove",{"token":B,"highlight_id":H[0]["id"]}); check("남의 밑줄은 못 지움",s==404,(s,b))
s,b=call("bk-api","/highlights/remove",{"token":A,"highlight_id":H[0]["id"]}); check("밑줄 지우기",s==200 and sql("select count(*) from bk_highlights")=="2",(s,b))
s,b=call("bk-api","/notes/photo-remove",{"token":A,"note_id":C3["id"]}); check("글자 없는 메모는 사진만 지우기 거부",s==400,(s,b))
s,b=call("bk-api","/notes/photo-remove",{"token":A,"note_id":C1["id"]}); check("사진만 지우기 → 창고에서도 사라짐",s==200 and not b["item"]["has_photo"] and photos()==[f"{A_id}/{C3['id']}.jpg"],(s,photos()))
s,b=call("bk-api","/notes/add",{"token":A,"shelf_id":SA,"kind":"capture","body":"지울 메모","keep_photo":True,"photo":IMG,"highlights":[{"start":0,"end":2}]}); C4=b["item"]
s,b=call("bk-api","/notes/remove",{"token":B,"note_id":C4["id"]}); check("남의 메모는 못 지움",s==404,(s,b))
s,b=call("bk-api","/notes/remove",{"token":A,"note_id":C4["id"]}); check("메모 지우기 → 밑줄 · 사진도 지워짐",s==200 and sql(f"select count(*) from bk_highlights where note_id='{C4['id']}'")=="0" and not any(C4["id"] in p for p in photos()),(s,photos()))
s,b=call("bk-api","/shelf/list",{"token":A}); check("메모를 남긴 책은 서재 목록에서 위로",s==200 and b["items"][0]["id"]==SA,(s,b))
s,b=call("bk-api","/shelf/remove",{"token":A,"shelf_id":SA}); check("서재에서 빼면 메모 · 밑줄 · 사진 모두 지워짐",s==200 and sql(f"select count(*) from bk_notes where shelf_id='{SA}'")=="0" and sql("select count(*) from bk_highlights")=="0" and photos()==[],(s,photos()))

# ── 관리자: 사용량 ──
s,b=call("bk-admin","/usage",{"token":B}); check("일반 회원은 사용량 못 봄",s==403,(s,b))
s,b=call("bk-admin","/usage",{"token":A}); check("관리자 사용량(이번 달 11 · 오늘 8 · 실패 5 · 회원별)",s==200 and b["month"]==11 and b["today_count"]==8 and b["users"][0]["username"]=="reader_a" and b["users"][0]["month"]==8 and b["failed"]==5,(s,b))
sql("insert into bk_ocr_usage(user_id,ok) select id,true from bk_users, generate_series(1,1500) where username='reader_b'")
s,b=call("bk-admin","/usage",{"token":A}); check("사용량이 1000줄 넘어도 모두 셈(11+1500)",s==200 and b["month"]==1511,(s,b.get("month")))
sql("delete from bk_ocr_usage where error is null and image_bytes is null")

# ── 잠금 ──
st,raw,_=get(f"{GW}/rest/v1/bk_notes?select=*")
check("화면용 키 없이 표 직접 읽기 막힘(REST)",st in (401,403) or raw==b"[]",(st,raw[:100]))
print(f"\n{sum(res)}/{len(res)} 통과")
