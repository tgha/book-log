# 3단계 화면 시험: 문장 찍기(사진 → 네 귀퉁이 → 펴기 → 자르기·돌리기 → 글자 읽기 → 고치기 → 밑줄 → 저장) · 메모 · 기록 탭
import subprocess, os, json, io, urllib.request, urllib.parse
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect
SHOTS = "/tmp/bktest/shots3"; os.makedirs(SHOTS, exist_ok=True)
GW = "http://127.0.0.1:8000"; URL = "http://127.0.0.1:8080/"
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def sql(q): return subprocess.run(["su","postgres","-c",f"psql -h /tmp/pgtest -p 55432 -U postgres -Atq -c \"{q}\""],capture_output=True,text=True).stdout.strip()
def vision(mode="ok"): return json.loads(op.open(f"{GW}/__vision?mode={mode}").read())
def photos(clear=False): return json.loads(op.open(f"{GW}/__photos" + ("?clear=1" if clear else "")).read())["paths"]
res = []; problems = []
def check(n, fn):
    try:
        r = fn()
        if r is False: raise Exception("조건 불만족")
        res.append(True); print("PASS", n)
    except Exception as e: res.append(False); print("FAIL", n, "->", str(e).splitlines()[0][:240])

# ── 가짜 사진: 어두운 책상 위에 비스듬히 놓인 흰 페이지 (검은 가로 막대 3줄 = 글줄) ──
W0, H0 = 1600, 1200
QUAD = [(300, 150), (1350, 230), (1280, 1080), (260, 1000)]  # 왼쪽 위부터 시계 방향
def page_point(u, v):  # 페이지 안 (u,v∈[0,1]) → 사진 속 좌표 (쌍선형, 시험용 근사)
    (ax, ay), (bx, by), (cx, cy), (dx, dy) = QUAD
    top = (ax + (bx - ax) * u, ay + (by - ay) * u); bot = (dx + (cx - dx) * u, dy + (cy - dy) * u)
    return (top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v)
im = Image.new("RGB", (W0, H0), (40, 44, 52)); d = ImageDraw.Draw(im)
d.polygon(QUAD, fill=(250, 248, 240))
for v in (0.25, 0.5, 0.75):
    d.polygon([page_point(0.08, v - 0.03), page_point(0.92, v - 0.03), page_point(0.92, v + 0.03), page_point(0.08, v + 0.03)], fill=(20, 20, 20))
PHOTO = "/tmp/bktest/page_photo.jpg"; im.save(PHOTO, "JPEG", quality=90)
im.resize((800, 600)).save("/tmp/bktest/page_small.jpg", "JPEG", quality=85)
open("/tmp/bktest/not_image.jpg", "wb").write(b"this is not a picture at all" * 10)

sql("delete from bk_users; delete from bk_books; update bk_settings set value='100' where key='ocr_daily_limit';")
vision("ok"); photos(clear=True)

def drag(pg, handle_i, tx, ty):
    """사진 좌표(tx,ty)로 i번 동그라미를 끌기 (마우스 = 포인터 이벤트)"""
    h = pg.locator(f".handle[data-h='{handle_i}']").bounding_box()
    st = pg.locator("#stage").bounding_box()
    k = st["width"] / W0  # 화면 1px 당 사진 몇 px (사진은 2400px 이하라 원래 크기 그대로 열림)
    sx, sy = h["x"] + h["width"] / 2, h["y"] + h["height"] / 2
    pg.mouse.move(sx, sy); pg.mouse.down()
    pg.mouse.move((sx + st["x"] + tx * k) / 2, (sy + st["y"] + ty * k) / 2, steps=4)
    pg.mouse.move(st["x"] + tx * k, st["y"] + ty * k, steps=4)
    return k

with sync_playwright() as p:
    br = p.chromium.launch(args=["--no-proxy-server"])
    c = br.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ko-KR")
    pg = c.new_page()
    phase = {"ocr_fail": False}  # 일부러 글자 읽기를 실패시키는 동안의 502 기록은 정상
    pg.on("console", lambda m: m.type == "error" and "fonts.g" not in m.text and "status of 4" not in m.text
          and not (phase["ocr_fail"] and "status of 502" in m.text) and problems.append(m.text))
    pg.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))

    # 로그인 화면의 [보기] 단추가 3단계 스타일에 깨지지 않았는지 (이름 겹침 사고 방지)
    pg.goto(URL + "#/login")
    check("로그인 [보기] 단추 모양 그대로(입력칸 안 오른쪽)", lambda: pg.evaluate("""(() => { const b=document.querySelector('button.peek'); const s=getComputedStyle(b);
        const i=document.querySelector('#password').getBoundingClientRect(); const r=b.getBoundingClientRect();
        return s.position==='absolute' && s.backgroundColor==='rgba(0, 0, 0, 0)' && r.top>=i.top && r.bottom<=i.bottom+1 && r.right<=i.right+1; })()"""))

    pg.goto(URL + "#/signup")
    pg.get_by_label("아이디").fill("owner_1"); pg.get_by_label("이름").fill("태관")
    pg.get_by_label("비밀번호", exact=True).fill("reading2026"); pg.get_by_label("비밀번호 한 번 더").fill("reading2026")
    pg.get_by_role("button", name="가입 신청 보내기").click()
    expect(pg.get_by_role("heading", name="승인을 기다리고 있어요")).to_be_visible()
    sql("update bk_users set status='approved', is_admin=true")
    pg.get_by_role("button", name="지금 확인하기").click()
    expect(pg.get_by_role("heading", name="태관님의 서재")).to_be_visible()
    pg.get_by_role("link", name="＋ 책 등록하기").click()
    pg.get_by_label("제목이나 저자로 찾기").fill("사피엔스"); pg.get_by_role("button", name="찾기", exact=True).click()
    pg.locator("#results .book-row", has_text="사피엔스").click()
    pg.get_by_label("전체 쪽수 (선택)").fill("636"); pg.get_by_role("button", name="서재에 넣기").click()
    expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible()
    book_url = pg.url

    check("책 화면: [문장 찍기] · [메모 쓰기] 열림, 메모 없음 안내", lambda: (expect(pg.get_by_role("link", name="문장 찍기")).to_be_visible(), expect(pg.get_by_text("아직 남긴 메모가 없어요")).to_be_visible()))
    check("[독서 시작]은 아직 잠김(4단계)", lambda: expect(pg.get_by_role("button", name="독서 시작")).to_be_disabled())
    pg.get_by_role("link", name="문장 찍기").click()
    check("사진 고르기 화면(폰: 카메라 · 사진첩)", lambda: (expect(pg.get_by_role("heading", name="문장 찍기")).to_be_visible(), expect(pg.locator("label.file-btn", has_text="카메라로 찍기")).to_be_visible(), expect(pg.locator("label.file-btn", has_text="사진첩에서 고르기")).to_be_visible()))
    check("카메라 단추는 뒤 카메라로 바로 찍기", lambda: pg.locator("label.file-btn", has_text="카메라로 찍기").locator("input").get_attribute("capture") == "environment")
    pg.screenshot(path=f"{SHOTS}/01-pick.png", full_page=True)
    pg.locator("label.file-btn", has_text="사진첩에서 고르기").locator("input").set_input_files("/tmp/bktest/not_image.jpg")
    check("사진이 아닌 파일은 쉬운 말로 거절", lambda: expect(pg.locator("#pick-status")).to_contain_text("열 수 없어요"))

    pg.locator("label.file-btn", has_text="카메라로 찍기").locator("input").set_input_files(PHOTO)
    check("네 귀퉁이 화면 + 동그라미 4개", lambda: (expect(pg.get_by_role("heading", name="네 귀퉁이 맞추기")).to_be_visible(), expect(pg.locator(".handle")).to_have_count(4)))
    pg.wait_for_timeout(300)
    check("동그라미는 처음에 가장자리 조금 안쪽", lambda: pg.evaluate("""(() => { const s=document.querySelector('#stage').getBoundingClientRect(); const h=document.querySelector('.handle[data-h="0"]').getBoundingClientRect();
        const x=(h.left+h.width/2-s.left)/s.width, y=(h.top+h.height/2-s.top)/s.height; return x>0.03&&x<0.1&&y>0.03&&y<0.1; })()"""))
    # 확대경: 끄는 동안만 보임
    for i, (x, y) in enumerate(QUAD):
        drag(pg, i, x, y)
        if i == 0:
            check("끄는 동안 확대경이 뜸", lambda: expect(pg.locator(".loupe")).to_be_visible())
            pg.screenshot(path=f"{SHOTS}/02-corners-drag.png")
        pg.mouse.up()
    check("손을 떼면 확대경이 사라짐", lambda: expect(pg.locator(".loupe")).to_be_hidden())
    pg.screenshot(path=f"{SHOTS}/03-corners.png", full_page=True)
    # 키보드로도 옮길 수 있음 (접근성) — 한 칸 옮겼다 되돌림
    pg.locator(".handle[data-h='2']").focus(); pg.keyboard.press("ArrowLeft"); pg.keyboard.press("ArrowRight")
    pg.get_by_role("button", name="펴기").click()
    check("[펴기] → 자르기 화면", lambda: expect(pg.get_by_role("heading", name="자르기 · 돌리기")).to_be_visible(timeout=8000))
    pg.wait_for_timeout(200)
    ratio = pg.evaluate("(() => { const c=document.querySelector('.stage-img'); return c.width/c.height; })()")
    check(f"편 사진 비율이 페이지 비율과 같음(1053x853≈1.23, 실제 {ratio:.3f})", lambda: abs(ratio - 1053 / 853) < 0.03)
    probe = pg.evaluate("""(() => { const c=document.querySelector('.stage-img'); const g=c.getContext('2d'); const W=c.width,H=c.height;
        const lum=(x,y)=>{const d=g.getImageData(Math.round(x),Math.round(y),1,1).data; return (d[0]+d[1]+d[2])/3;};
        const corners=[[.03,.03],[.97,.03],[.97,.97],[.03,.97]].map(([u,v])=>lum(u*W,v*H));
        const bar=[]; for(let u=.12;u<=.88;u+=.04) bar.push(lum(u*W,.5*H));
        const gapRow=[]; for(let u=.12;u<=.88;u+=.04) gapRow.push(lum(u*W,.375*H));
        return {corners, barMax:Math.max(...bar), gapMin:Math.min(...gapRow)}; })()""")
    check(f"편 사진 네 모서리가 모두 흰 종이(바깥 책상이 안 들어옴) {probe['corners']}", lambda: min(probe["corners"]) > 200)
    check(f"글줄이 반듯한 가로줄로 펴짐(가운데 줄 전체가 검정 {probe['barMax']:.0f}, 줄 사이 전체가 흰색 {probe['gapMin']:.0f})", lambda: probe["barMax"] < 80 and probe["gapMin"] > 200)
    pg.screenshot(path=f"{SHOTS}/04-crop.png", full_page=True)

    # 뒤로 → 귀퉁이 위치가 그대로 남아 있음 → 다시 앞으로
    pg.get_by_role("button", name="← 뒤로").click()
    check("[뒤로] 하면 맞춘 귀퉁이가 그대로", lambda: pg.evaluate("""(() => { const s=document.querySelector('#stage').getBoundingClientRect(); const h=document.querySelector('.handle[data-h="1"]').getBoundingClientRect();
        return Math.abs((h.left+h.width/2-s.left)/s.width - 1350/1600) < 0.01; })()"""))
    pg.get_by_role("button", name="펴기").click()
    expect(pg.get_by_role("heading", name="자르기 · 돌리기")).to_be_visible(timeout=8000)

    # 돌리기: 한 번 돌리면 가로세로가 바뀌고, 반대로 돌리면 돌아옴
    w1 = pg.evaluate("document.querySelector('.stage-img').width/document.querySelector('.stage-img').height")
    pg.get_by_role("button", name="↻ 오른쪽으로 돌리기").click(); pg.wait_for_timeout(200)
    w2 = pg.evaluate("document.querySelector('.stage-img').width/document.querySelector('.stage-img').height")
    check("90° 돌리면 가로 · 세로가 바뀜", lambda: abs(w2 - 1 / w1) < 0.03)
    pg.get_by_role("button", name="↺ 왼쪽으로 돌리기").click(); pg.wait_for_timeout(200)
    # 자르기: 오른쪽 아래 동그라미를 안쪽으로 → 왼쪽 아래 · 오른쪽 위가 네모를 유지하며 따라옴
    sw = pg.evaluate("document.querySelector('.stage-img').width/Math.min(2,devicePixelRatio)")
    st = pg.locator("#stage").bounding_box()
    h2 = pg.locator(".handle[data-h='2']").bounding_box()
    pg.mouse.move(h2["x"] + 22, h2["y"] + 22); pg.mouse.down(); pg.mouse.move(st["x"] + st["width"] * 0.8, st["y"] + st["height"] * 0.85, steps=6); pg.mouse.up()
    check("자르기는 늘 반듯한 네모", lambda: pg.evaluate("""(() => { const b=[...document.querySelectorAll('.handle')].map(h=>{const r=h.getBoundingClientRect(); return [r.left,r.top];});
        return Math.abs(b[1][0]-b[2][0])<1 && Math.abs(b[2][1]-b[3][1])<1 && Math.abs(b[0][0]-b[3][0])<1 && Math.abs(b[0][1]-b[1][1])<1; })()"""))
    check("오늘 글자 읽기 사용량 표시", lambda: expect(pg.locator("#quota")).to_contain_text("0 / 100"))

    # 글자 읽기 실패 → 이유 + [다시 시도] [직접 입력], 저절로 다시 시도하지 않음
    calls0 = vision("err500")["calls"]; phase["ocr_fail"] = True
    pg.get_by_role("button", name="글자 읽기", exact=True).click()
    check("실패하면 이유와 [다시 시도] · [직접 입력]", lambda: (expect(pg.locator("#ocr-error")).to_be_visible(timeout=8000), expect(pg.locator("#ocr-error-text")).to_contain_text("다시 시도"), expect(pg.locator("#ocr-error").get_by_role("button", name="직접 입력")).to_be_visible()))
    pg.wait_for_timeout(2500)
    check("저절로 다시 시도하지 않음(구글 호출 1번뿐)", lambda: vision("err500")["calls"] == calls0 + 1)
    check("실패해도 사진은 그대로(자르기 화면 유지)", lambda: expect(pg.locator(".stage-img")).to_be_visible())
    check("실패도 1번으로 셈(1 / 100)", lambda: expect(pg.locator("#quota")).to_contain_text("1 / 100"))
    pg.screenshot(path=f"{SHOTS}/05-ocr-fail.png", full_page=True)
    vision("ok"); phase["ocr_fail"] = False
    pg.locator("#retry").click()
    check("[다시 시도] → 글자 고치기 화면", lambda: expect(pg.get_by_role("heading", name="글자 고치기")).to_be_visible(timeout=8000))
    v = vision("ok")["last"]
    check(f"구글로 보낸 사진은 알맞게 줄인 JPEG (base64 {v['bytes']//1024}KB)", lambda: 1000 < v["bytes"] < 1400000 * 1.4)
    ta = pg.locator("#cap-text")
    check("읽은 글자가 편집칸에", lambda: expect(ta).to_have_value("우리가 어떤 사건을 현재의 눈으로\n보면, 그 시대 사람들이 무엇을\n생각했는지 놓치기 쉽다.\nHistory is a con-\nversation with the past."))
    check("위에 찍은 사진(확대 가능)", lambda: (expect(pg.locator("#peek-img")).to_be_visible(), pg.wait_for_function("document.querySelector('#peek-img').naturalWidth>100")))
    pg.get_by_role("button", name="크게").click()
    check("[크게] 누르면 사진 2배", lambda: pg.evaluate("document.querySelector('#peek-img').style.width") == "200%")
    pg.screenshot(path=f"{SHOTS}/06-edit.png", full_page=True)
    pg.get_by_role("button", name="줄 이어 붙이기").click()
    JOINED = "우리가 어떤 사건을 현재의 눈으로 보면, 그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다.\nHistory is a conversation with the past."
    check("[줄 이어 붙이기]: 끊긴 줄은 잇고, 문단 끝 줄바꿈은 남기고, 영어 하이픈은 붙임", lambda: expect(ta).to_have_value(JOINED))
    pg.get_by_role("button", name="되돌리기").click()
    check("[되돌리기]", lambda: expect(ta).to_contain_text("눈으로\n보면") if False else ta.input_value().startswith("우리가 어떤 사건을 현재의 눈으로\n보면"))
    pg.get_by_role("button", name="줄 이어 붙이기").click()
    pg.get_by_role("button", name="공백 없애기", exact=True).click()
    check("공백 없애기 모드: 공백마다 누르는 점", lambda: pg.locator("#gaps-view button.gap").count() >= 12)
    pg.screenshot(path=f"{SHOTS}/07-gaps.png", full_page=True)
    ngaps = pg.locator("#gaps-view button.gap").count()
    pg.locator("#gaps-view button.gap[data-s='10']").click()  # "사건을 현재의" 사이
    check("공백을 누르면 그 공백 하나만 사라짐", lambda: pg.locator("#gaps-view button.gap").count() == ngaps - 1)
    pg.get_by_role("button", name="공백 없애기", exact=True).click()
    check("편집칸에도 반영", lambda: "사건을현재의" in ta.input_value())
    pg.get_by_role("button", name="되돌리기").click()
    ta.fill(JOINED.replace("쉽다.", "쉽다.   "))  # 줄 끝 공백은 저장할 때 정리됨
    pg.get_by_role("button", name="다음: 밑줄 긋기").click()

    check("밑줄 화면: 단어 단추", lambda: (expect(pg.get_by_role("heading", name="밑줄 긋기")).to_be_visible(), pg.locator("#picker button.w").count() >= 15))
    w = lambda t: pg.locator("#picker button.w", has_text=t).first
    w("현재의").click()
    check("시작 단어 누르면 안내가 바뀜", lambda: expect(pg.locator("#pick-help")).to_contain_text("「현재의」부터"))
    w("보면,").click()
    check("끝 단어 누르면 사이가 색칠됨(3단어)", lambda: pg.locator("#picker button.w.sel").count() == 3)
    pg.screenshot(path=f"{SHOTS}/08-underline-pick.png", full_page=True)
    pg.get_by_role("button", name="밑줄 저장").click()
    check("밑줄 목록에 1개", lambda: expect(pg.locator("#hl-list .hl-text")).to_have_text(["현재의 눈으로 보면,"]))
    w("past.").click(); w("History").click()  # 거꾸로 눌러도 됨
    pg.get_by_role("button", name="밑줄 저장").click()
    check("거꾸로 눌러도 되고, 밑줄 여러 개(2개)", lambda: expect(pg.locator("#hl-list .hl-text")).to_have_text(["현재의 눈으로 보면,", "History is a conversation with the past."]))
    check("그은 밑줄은 형광펜 표시(3+7단어)", lambda: pg.locator("#picker button.w.hl").count() == 10)
    pg.locator("#hl-list [data-del='1']").click()
    check("밑줄 지우기", lambda: expect(pg.locator("#hl-list .hl-text")).to_have_count(1))
    w("History").click(); w("past.").click(); pg.get_by_role("button", name="밑줄 저장").click()
    pg.screenshot(path=f"{SHOTS}/09-underline.png", full_page=True)
    # 고치기로 돌아가 글을 바꾸면 밑줄 자리를 다시 찾음
    pg.get_by_role("button", name="← 뒤로").click()
    expect(pg.get_by_role("heading", name="글자 고치기")).to_be_visible()
    ta.fill("[머리말] " + ta.input_value())
    pg.get_by_role("button", name="다음: 밑줄 긋기").click()
    check("글 앞에 글자를 더해도 밑줄 2개 유지", lambda: (expect(pg.locator("#hl-list .hl-text")).to_have_count(2), pg.locator("#picker button.w.hl").count() == 10))
    pg.get_by_role("button", name="다음: 저장하기").click()

    check("저장 화면: 미리보기에 형광펜 2곳", lambda: (expect(pg.get_by_role("heading", name="저장하기")).to_be_visible(), expect(pg.locator(".save-preview mark.hl")).to_have_count(2)))
    check("[사진도 남기기] 처음엔 꺼짐", lambda: expect(pg.get_by_role("switch", name="사진도 남기기")).not_to_be_checked())
    pg.get_by_label("쪽수 (선택)").fill("abc"); pg.get_by_role("button", name="저장", exact=True).click()
    check("쪽수 숫자 확인", lambda: expect(pg.get_by_role("alert")).to_contain_text("쪽수"))
    pg.get_by_label("쪽수 (선택)").fill("339")
    pg.get_by_label("내 생각 한마디 (선택)").fill("지금 내 이야기 같다")
    pg.locator("label.switch").click()
    pg.screenshot(path=f"{SHOTS}/10-save.png", full_page=True)
    pg.get_by_role("button", name="저장", exact=True).click()
    check("저장하면 책 화면으로 돌아옴", lambda: (expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible(timeout=8000), pg.url == book_url))
    check("책 화면 메모 목록에 방금 메모", lambda: expect(pg.locator(".note-row")).to_contain_text("339쪽 · 찍은 문장 · 밑줄 2 · 사진"))
    check("DB: 쪽수 · 한마디 · 글 끝 공백 정리 · 밑줄 2", lambda: sql("select page||'/'||thought||'/'||(body like '%쉽다.'||chr(10)||'History%')::text||'/'||(select count(*) from bk_highlights) from bk_notes") == "339/지금 내 이야기 같다/true/2")
    check("DB: 밑줄 문장은 따로 복사", lambda: sql("select string_agg(text,'|' order by start_offset) from bk_highlights") == "현재의 눈으로 보면,|History is a conversation with the past.")
    check("[사진도 남기기] 선택을 계정에 기억", lambda: sql("select keep_photo from bk_users") == "t")
    check("사진 창고에 회원 폴더/메모번호.jpg 한 장", lambda: (lambda ps, uid: len(ps) == 1 and ps[0].startswith(uid + "/") and ps[0].endswith(".jpg"))(photos(), sql("select id from bk_users")))
    check("사용량 2번(실패 1 + 성공 1)", lambda: sql("select count(*)||'/'||count(*) filter (where ok) from bk_ocr_usage") == "2/1")
    pg.screenshot(path=f"{SHOTS}/11-book-notes.png", full_page=True)

    # 메모 자세히: 사진 보기 · 밑줄 더하기/지우기 · 고치기
    pg.locator(".note-row").first.click()
    check("메모 자세히: 형광펜 2곳 · 내 생각", lambda: (expect(pg.locator("#note-body mark.hl")).to_have_count(2), expect(pg.locator(".note-thought-full")).to_contain_text("지금 내 이야기 같다")))
    pg.get_by_role("button", name="사진 보기").click()
    check("[사진 보기] 누르면 그때 사진을 받아 보여 줌", lambda: (expect(pg.locator("#kept-photo img")).to_be_visible(), pg.wait_for_function("document.querySelector('#kept-photo img').naturalWidth>100", timeout=5000)))
    check("사진 주소는 잠깐만 열리는 서명 주소", lambda: "token=" in pg.locator("#kept-photo img").get_attribute("src"))
    pg.screenshot(path=f"{SHOTS}/12-note.png", full_page=True)
    pg.get_by_role("button", name="밑줄 긋기").click()
    pg.locator("#picker button.w", has_text="시대").first.click(); pg.locator("#picker button.w", has_text="무엇을").first.click()
    pg.get_by_role("button", name="밑줄 저장").click()
    check("저장된 메모에 밑줄 더하기(3개)", lambda: expect(pg.locator(".hl-list .hl-text")).to_have_count(3))
    pg.get_by_role("button", name="끝내기").click()
    pg.locator("[data-hl-remove]").first.click()
    pg.locator("dialog").get_by_role("button", name="지우기").click()
    check("밑줄 지우기(확인 창)", lambda: expect(pg.locator(".hl-list .hl-text")).to_have_count(2))
    pg.get_by_role("button", name="글 · 쪽수 고치기").click()
    pg.locator("#edit-body").fill(pg.locator("#edit-body").input_value().replace("[머리말] ", ""))
    pg.get_by_label("쪽수 (선택)").fill("340")
    pg.get_by_role("button", name="고친 내용 저장").click()
    check("고친 내용 저장 → 쪽수 340, 밑줄 자리 유지", lambda: (expect(pg.locator(".note-meta-top")).to_contain_text("340쪽"), expect(pg.locator("#note-body mark.hl")).to_have_count(2)))

    # 두 번째 찍기: 기억한 [사진도 남기기]=켜짐, 한도 다 씀 → [직접 입력]
    pg.goto(book_url); expect(pg.get_by_role("link", name="문장 찍기")).to_be_visible()
    sql("update bk_settings set value='2' where key='ocr_daily_limit'")
    pg.get_by_role("link", name="문장 찍기").click()
    # (시험용 크롬은 [뒤로 가기] 뒤 터치 흉내가 풀려 PC 모양이 나올 수 있음 → 카메라 아닌 파일 칸을 씀)
    pg.locator("input[data-file]:not([capture])").set_input_files("/tmp/bktest/page_small.jpg")
    expect(pg.get_by_role("heading", name="네 귀퉁이 맞추기")).to_be_visible()
    pg.get_by_role("button", name="펴지 않고 넘어가기").click()
    expect(pg.get_by_role("heading", name="자르기 · 돌리기")).to_be_visible()
    check("한도를 다 쓰면 [글자 읽기] 잠김 + 직접 입력 안내", lambda: (expect(pg.locator("#quota")).to_contain_text("2 / 2"), expect(pg.get_by_role("button", name="글자 읽기", exact=True)).to_be_disabled(), expect(pg.locator("#quota")).to_contain_text("직접 입력")))
    pg.screenshot(path=f"{SHOTS}/13-limit.png", full_page=True)
    pg.get_by_role("button", name="글자 읽지 않고 직접 입력").click()
    expect(pg.get_by_role("heading", name="글자 고치기")).to_be_visible()
    check("직접 입력: 빈 편집칸 + 사진은 보임", lambda: (expect(ta).to_have_value(""), expect(pg.locator("#peek-img")).to_be_visible()))
    ta.fill("손으로 옮겨 적은 문장.")
    pg.get_by_role("button", name="다음: 밑줄 긋기").click(); pg.get_by_role("button", name="다음: 저장하기").click()
    check("[사진도 남기기] 지난번 선택(켜짐)을 기억", lambda: expect(pg.get_by_role("switch", name="사진도 남기기")).to_be_checked())
    check("쪽수 칸에 지난번 쪽수", lambda: expect(pg.get_by_label("쪽수 (선택)")).to_have_value("339"))
    pg.locator("label.switch").click()
    pg.get_by_role("button", name="저장", exact=True).click()
    expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible(timeout=8000)
    check("끄고 저장 → 사진은 안 올라가고 선택도 기억(꺼짐)", lambda: len(photos()) == 1 and sql("select keep_photo from bk_users") == "f")
    check("한도 넘은 요청은 없음(사용량 그대로 2)", lambda: sql("select count(*) from bk_ocr_usage") == "2")

    # 내 생각 메모
    pg.get_by_role("link", name="메모 쓰기").click()
    pg.get_by_role("button", name="메모 저장").click()
    check("빈 메모 막음", lambda: expect(pg.get_by_role("alert")).to_contain_text("메모 내용"))
    pg.get_by_label("떠오른 생각").fill("역사를 볼 때는\n그 시대의 눈으로."); pg.get_by_label("쪽수 (선택)").fill("12")
    pg.get_by_role("button", name="메모 저장").click()
    check("책 화면 메모 3개 + 정렬 단추", lambda: (expect(pg.locator(".note-row")).to_have_count(3), expect(pg.get_by_role("button", name="쪽수순")).to_be_visible()))
    pg.get_by_role("button", name="쪽수순").click()
    check("쪽수순: 12쪽 → 339쪽", lambda: pg.locator(".note-row .note-meta").first.inner_text().startswith("12쪽"))

    # 기록 탭
    pg.goto(URL + "#/notes")
    check("기록 탭: 메모 3 · 밑줄 2", lambda: (expect(pg.get_by_role("button", name="메모 3")).to_be_visible(), expect(pg.get_by_role("button", name="밑줄 2")).to_be_visible()))
    check("기록 탭 메모에 책 이름", lambda: expect(pg.locator(".note-row").first).to_contain_text("사피엔스"))
    pg.screenshot(path=f"{SHOTS}/14-notes-tab.png", full_page=True)
    pg.get_by_role("button", name="밑줄 2").click()
    check("밑줄만 보기", lambda: expect(pg.locator(".hl-row")).to_have_count(2))
    pg.get_by_role("button", name="쪽수순").click()
    check("밑줄 쪽수순 + 책 · 쪽 표시", lambda: expect(pg.locator(".hl-row .note-meta").first).to_contain_text("사피엔스 · 340쪽"))
    pg.screenshot(path=f"{SHOTS}/15-marks-tab.png", full_page=True)
    pg.locator(".hl-row").first.click()
    check("밑줄 누르면 그 메모로", lambda: expect(pg.locator("#note-body mark.hl").first).to_be_visible())

    # 관리자: 사용량
    pg.goto(URL + "#/admin")
    check("관리자 화면에 글자 읽기 사용량", lambda: (expect(pg.locator(".usage-big")).to_contain_text("2"), expect(pg.locator("#usage")).to_contain_text("실패 1")))
    pg.screenshot(path=f"{SHOTS}/16-admin.png", full_page=True)

    # 메모 지우기 → 사진도 지워짐
    pg.goto(book_url)
    pg.get_by_role("button", name="작성순").click()
    pg.locator(".note-row", has_text="사진").click()
    pg.get_by_role("button", name="메모 지우기").click()
    pg.locator("dialog").get_by_role("button", name="지우기").click()
    check("메모 지우기 → 책 화면 · 사진도 창고에서 지워짐", lambda: (expect(pg.locator(".note-row")).to_have_count(2), photos() == []))
    check("자바스크립트 오류 · 보안 규칙 위반 없음", lambda: (_ for _ in ()).throw(Exception(problems)) if problems else True)
    c.close()

    # PC 화면: 사진 파일 올리기
    c2 = br.new_context(viewport={"width": 1280, "height": 900}, locale="ko-KR")
    pg2 = c2.new_page()
    pg2.goto(URL + "#/login")
    pg2.get_by_label("아이디").fill("owner_1"); pg2.get_by_label("비밀번호", exact=True).fill("reading2026")
    pg2.get_by_role("button", name="로그인").click()
    expect(pg2.get_by_role("heading", name="태관님의 서재")).to_be_visible()
    pg2.goto(book_url)
    pg2.get_by_role("link", name="문장 찍기").click()
    check("PC: [사진 파일 올리기] · 끌어다 놓기 안내", lambda: (expect(pg2.locator("label.file-btn", has_text="사진 파일 올리기")).to_be_visible(), expect(pg2.get_by_text("끌어다 놓아도")).to_be_visible()))
    pg2.locator("label.file-btn input").set_input_files(PHOTO)
    expect(pg2.get_by_role("heading", name="네 귀퉁이 맞추기")).to_be_visible()
    pg2.wait_for_timeout(300)
    check("PC: 사진 무대가 폰 너비 안에 들어감", lambda: pg2.locator("#stage").bounding_box()["width"] <= 34 * 16)
    pg2.screenshot(path=f"{SHOTS}/17-pc-corners.png")
    br.close()
print(f"\n{sum(res)}/{len(res)} 통과")
