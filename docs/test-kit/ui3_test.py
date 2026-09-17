# 3단계 화면 시험 (1.3.0 간소화): 앱 안 카메라(무음) → 읽을 부분 감싸기(모서리 · 테두리 선) → 글자 읽기
#   → 첫 단어 · 끝 단어 고르기 → 쪽수 → 저장 · 메모 · 기록 탭(정렬 4가지 · 사진 모아 보기) · 글자 모양 설정 · 관리자
#   → 띄어쓰기 의심 빨간 밑줄 누르기 · 모두 붙이기 · 되돌리기 (1.4.0) · PC
import subprocess, os, json, urllib.request
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
QUAD = [(300, 150), (1350, 230), (1280, 1080), (260, 1000)]
def page_point(u, v):
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

# 카메라 사용 기록 (소리 · 끄기 확인용)
GUM = """
window.__gum = [];
if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); window.__gum.push({ c, s }); return s; };
}
"""
def stage_k(pg): return pg.locator("#stage").bounding_box()["width"] / pg.evaluate("window.__srcW || 0") if False else None
def center(pg, sel):
    b = pg.locator(sel).bounding_box(); return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
def drag_corner(pg, i, tx, ty, src_w):
    st = pg.locator("#stage").bounding_box(); k = st["width"] / src_w
    sx, sy = center(pg, f".handle[data-h='{i}']")
    pg.mouse.move(sx, sy); pg.mouse.down()
    pg.mouse.move((sx + st["x"] + tx * k) / 2, (sy + st["y"] + ty * k) / 2, steps=4)
    pg.mouse.move(st["x"] + tx * k, st["y"] + ty * k, steps=4); pg.mouse.up()
def tops(pg): return pg.evaluate("[...document.querySelectorAll('.handle')].map(h => { const r = h.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })")

with sync_playwright() as p:
    br = p.chromium.launch(args=["--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
    c = br.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ko-KR", permissions=["camera"])
    c.add_init_script(GUM)
    pg = c.new_page()
    pg.on("console", lambda m: m.type == "error" and "fonts.g" not in m.text and "status of 4" not in m.text
          and not (phase["ocr_fail"] and "status of 502" in m.text) and problems.append(m.text))
    pg.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
    phase = {"ocr_fail": False}

    pg.goto(URL + "#/login")
    check("로그인 [보기] 단추 모양 그대로", lambda: pg.evaluate("""(() => { const b=document.querySelector('button.peek'); const s=getComputedStyle(b);
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
    check("책 화면: [문장 찍기] · [메모 쓰기], 밑줄 글자 없음", lambda: (expect(pg.get_by_role("link", name="문장 찍기")).to_be_visible(), expect(pg.get_by_role("link", name="메모 쓰기")).to_be_visible(), pg.locator("main").inner_text().count("밑줄") == 0))

    # ── 1. 찍기: [문장 찍기] 누르면 바로 앱 안 카메라 ──
    pg.get_by_role("link", name="문장 찍기").click()
    check("바로 카메라 화면(찍기 단추 · 무음 안내)", lambda: (expect(pg.locator("#cam")).to_be_visible(timeout=6000), expect(pg.get_by_role("button", name="찍기 (소리 없음)")).to_be_visible(), expect(pg.locator("#cam-hint")).to_contain_text("소리 없이")))
    check("폰 기본 카메라 앱을 부르지 않음(capture 칸 없음)", lambda: pg.locator("input[capture]").count() == 0)
    check("카메라는 영상만, 소리(마이크) 안 씀", lambda: pg.evaluate("window.__gum.length===1 && window.__gum[0].c.audio===false && window.__gum[0].s.getAudioTracks().length===0"))
    check("사진첩에서 고르기도 있음", lambda: expect(pg.locator("label.file-btn", has_text="사진첩에서 고르기")).to_be_visible())
    pg.wait_for_timeout(500)
    pg.screenshot(path=f"{SHOTS}/01-camera.png", full_page=True)
    pg.get_by_role("button", name="찍기 (소리 없음)").click()
    check("찍으면 바로 「읽을 부분 감싸기」", lambda: expect(pg.get_by_role("heading", name="읽을 부분 감싸기")).to_be_visible())
    check("찍은 뒤 카메라가 꺼짐", lambda: pg.evaluate("window.__gum.every(g => g.s.getTracks().every(t => t.readyState === 'ended'))"))
    check("찍은 사진이 무대에 보임 + 모서리 4 · 테두리 선 4", lambda: (expect(pg.locator(".stage-img")).to_be_visible(), expect(pg.locator(".handle")).to_have_count(4), expect(pg.locator(".edge-handle")).to_have_count(4)))
    pg.get_by_role("button", name="다시 찍기").click()
    expect(pg.get_by_role("heading", name="문장 찍기")).to_be_visible()
    pg.locator("input[data-file]").set_input_files("/tmp/bktest/not_image.jpg")
    check("사진이 아닌 파일은 쉬운 말로 거절", lambda: expect(pg.locator("#pick-status")).to_contain_text("열 수 없어요"))
    pg.locator("input[data-file]").set_input_files(PHOTO)
    expect(pg.get_by_role("heading", name="읽을 부분 감싸기")).to_be_visible()
    check("사진첩 사진으로 바꾸면 카메라도 꺼짐", lambda: pg.evaluate("window.__gum.every(g => g.s.getTracks().every(t => t.readyState === 'ended'))"))
    pg.wait_for_timeout(300)

    # ── 2. 테두리 선 끌기 ──
    before = tops(pg)
    ex, ey = center(pg, ".edge-handle[data-e='0']")  # 위쪽 선
    pg.mouse.move(ex, ey); pg.mouse.down(); pg.mouse.move(ex + 10, ey + 20, steps=3); pg.mouse.move(ex + 10, ey + 40, steps=3)
    check("선을 끄는 동안 확대경", lambda: expect(pg.locator(".loupe")).to_be_visible())
    pg.screenshot(path=f"{SHOTS}/02-edge-drag.png")
    pg.mouse.up()
    after = tops(pg)
    check(f"위쪽 선을 끌면 위 모서리 둘이 같이 내려오고 아래는 그대로", lambda: all(abs((after[i][1] - before[i][1]) - 40) < 2 and abs((after[i][0] - before[i][0]) - 10) < 2 for i in (0, 1)) and all(abs(after[i][1] - before[i][1]) < 1 for i in (2, 3)))
    ex, ey = center(pg, ".edge-handle[data-e='3']")  # 왼쪽 선: 선 가운데가 아닌 곳을 잡아도 됨
    y0 = pg.locator(".handle[data-h='0']").bounding_box(); y3 = pg.locator(".handle[data-h='3']").bounding_box()
    grab_y = y0["y"] + 22 + (y3["y"] - y0["y"]) * 0.8
    grab_x = pg.evaluate(f"(() => {{ const a=document.querySelector('.handle[data-h=\"0\"]').getBoundingClientRect(), b=document.querySelector('.handle[data-h=\"3\"]').getBoundingClientRect(); const t=({grab_y}-(a.top+22))/((b.top+22)-(a.top+22)); return a.left+22+((b.left+22)-(a.left+22))*t; }})()")
    b2 = tops(pg)
    pg.mouse.move(grab_x + 6, grab_y); pg.mouse.down(); pg.mouse.move(grab_x + 36, grab_y, steps=5); pg.mouse.up()
    a2 = tops(pg)
    check("선의 아무 곳이나 잡아 끌 수 있음(왼쪽 선 → 왼쪽 모서리 둘이 오른쪽으로)", lambda: all(abs((a2[i][0] - b2[i][0]) - 30) < 2 for i in (0, 3)) and all(abs(a2[i][0] - b2[i][0]) < 1 for i in (1, 2)))
    pg.locator(".edge-handle[data-e='1']").focus(); pg.keyboard.press("ArrowLeft")
    check("선도 화살표 키로 옮김", lambda: tops(pg)[1][0] < a2[1][0] and tops(pg)[2][0] < a2[2][0])
    # 모서리를 페이지 네 귀퉁이에
    for i, (x, y) in enumerate(QUAD): drag_corner(pg, i, x, y, W0)
    pg.screenshot(path=f"{SHOTS}/03-area.png", full_page=True)
    check("[글자 읽기] 단추 · 오늘 사용량", lambda: (expect(pg.get_by_role("button", name="글자 읽기", exact=True)).to_be_visible(), expect(pg.locator("#quota")).to_contain_text("0 / 100")))

    # 글자 읽기 실패 → 이유 + [다시 시도] · [직접 입력], 저절로 다시 시도 안 함
    calls0 = vision("err500")["calls"]; phase["ocr_fail"] = True
    pg.get_by_role("button", name="글자 읽기", exact=True).click()
    check("실패하면 이유와 [다시 시도] · [직접 입력]", lambda: (expect(pg.locator("#ocr-error")).to_be_visible(timeout=8000), expect(pg.locator("#ocr-error").get_by_role("button", name="다시 시도")).to_be_visible(), expect(pg.locator("#ocr-error").get_by_role("button", name="직접 입력")).to_be_visible()))
    pg.wait_for_timeout(2500)
    check("저절로 다시 시도하지 않음", lambda: vision("err500")["calls"] == calls0 + 1)
    check("실패도 1번으로 셈", lambda: expect(pg.locator("#quota")).to_contain_text("1 / 100"))
    pg.screenshot(path=f"{SHOTS}/04-ocr-fail.png", full_page=True)
    vision("ok"); phase["ocr_fail"] = False
    pg.locator("#retry").click()

    # ── 3. 문장 고르기 ──
    check("[다시 시도] → 문장 고르기", lambda: expect(pg.get_by_role("heading", name="문장 고르기")).to_be_visible(timeout=8000))
    v = vision("ok")["last"]
    check(f"구글로 보낸 사진은 줄인 JPEG (base64 {v['bytes']//1024}KB)", lambda: 1000 < v["bytes"] < 1400000 * 1.4)
    check("안내: 첫 단어를 누르세요", lambda: expect(pg.locator("#pick-help")).to_contain_text("첫 단어"))
    check("읽은 글은 줄이 이어진 단어 단추로(영어 하이픈도 붙음)", lambda: (expect(pg.locator("#chooser button.w", has_text="conversation")).to_have_count(1), pg.locator("#chooser button.w").count() == 19))
    pg.wait_for_timeout(800)
    probe = pg.evaluate("""(() => { const im=document.querySelector('#shot-img'); const c=document.createElement('canvas'); c.width=im.naturalWidth; c.height=im.naturalHeight;
        const g=c.getContext('2d'); g.drawImage(im,0,0); const W=c.width,H=c.height;
        const lum=(x,y)=>{const d=g.getImageData(Math.round(x),Math.round(y),1,1).data; return (d[0]+d[1]+d[2])/3;};
        const corners=[[.03,.03],[.97,.03],[.97,.97],[.03,.97]].map(([u,v])=>lum(u*W,v*H));
        const bar=[]; for(let u=.12;u<=.88;u+=.04) bar.push(lum(u*W,.5*H));
        const gap=[]; for(let u=.12;u<=.88;u+=.04) gap.push(lum(u*W,.375*H));
        return {ratio:W/H, corners, barMax:Math.max(...bar), gapMin:Math.min(...gap)}; })()""")
    check(f"편 사진 비율 = 페이지 비율(≈1.23, 실제 {probe['ratio']:.3f})", lambda: abs(probe["ratio"] - 1053 / 853) < 0.03)
    check(f"편 사진 네 모서리가 흰 종이 {[round(x) for x in probe['corners']]}", lambda: min(probe["corners"]) > 200)
    check(f"글줄이 반듯한 가로줄(줄 {probe['barMax']:.0f} 검정 · 사이 {probe['gapMin']:.0f} 흰색)", lambda: probe["barMax"] < 90 and probe["gapMin"] > 200)
    w = lambda t: pg.locator("#chooser button.w", has_text=t).first
    w("현재의").click()
    check("첫 단어 → 「현재의」부터 안내", lambda: expect(pg.locator("#pick-help")).to_contain_text("「현재의」부터"))
    w("보면,").click()
    check("끝 단어 → 사이 색칠(3단어) + 고른 문장", lambda: (pg.locator("#chooser button.w.sel").count() == 3, expect(pg.locator("#chosen-text")).to_have_text("현재의 눈으로 보면,")))
    w("그").click(); w("쉽다.").click()
    check("다시 누르면 새로 고름", lambda: expect(pg.locator("#chosen-text")).to_have_text("그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다."))
    pg.screenshot(path=f"{SHOTS}/05-choose.png", full_page=True)
    pg.get_by_role("button", name="글자 고치기").click()
    check("[글자 고치기] 편집칸에 고른 문장", lambda: expect(pg.get_by_label("고른 문장 고치기")).to_have_value("그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다."))
    pg.get_by_label("고른 문장 고치기").fill("그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다!")
    # 뒤로 → 같은 자리면 [다음] (구글을 다시 부르지 않음)
    calls1 = vision("ok")["calls"]
    pg.get_by_role("button", name="← 뒤로").click()
    check("감싸기로 돌아가면 [다음] (이미 읽음)", lambda: expect(pg.locator("#read")).to_have_text("다음"))
    pg.locator(".handle[data-h='2']").focus(); pg.keyboard.press("ArrowLeft")
    check("자리를 바꾸면 다시 [글자 읽기]", lambda: expect(pg.locator("#read")).to_have_text("글자 읽기"))
    pg.keyboard.press("ArrowRight")
    check("되돌리면 다시 [다음]", lambda: expect(pg.locator("#read")).to_have_text("다음"))
    pg.locator("#read").click()
    check("[다음]은 구글을 부르지 않고, 고친 글자도 그대로", lambda: (expect(pg.get_by_label("고른 문장 고치기")).to_have_value("그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다!"), vision("ok")["calls"] == calls1))

    # ── 저장 ──
    check("쪽수 칸이 바로 보임", lambda: expect(pg.get_by_label("쪽수")).to_be_visible())
    pg.get_by_label("쪽수").fill("abc"); pg.get_by_role("button", name="저장", exact=True).click()
    check("쪽수 숫자 확인", lambda: expect(pg.get_by_role("alert")).to_contain_text("쪽수"))
    pg.get_by_label("쪽수").fill("339")
    pg.locator("#more summary").click()
    check("[더 하기] 안: 내 생각 · 사진도 남기기(처음 꺼짐) · 찍은 부분 사진", lambda: (expect(pg.get_by_label("내 생각 한마디 (선택)")).to_be_visible(), expect(pg.get_by_role("switch", name="사진도 남기기")).not_to_be_checked(), expect(pg.locator("#shot-img")).to_be_visible()))
    pg.get_by_label("내 생각 한마디 (선택)").fill("지금 내 이야기 같다")
    pg.locator("label.switch").click()
    check("[더 하기] 제목에 고른 것 표시", lambda: expect(pg.locator("#more-state")).to_have_text(" · 사진 남김 · 내 생각"))
    pg.screenshot(path=f"{SHOTS}/06-save.png", full_page=True)
    pg.get_by_role("button", name="저장", exact=True).click()
    check("저장하면 책 화면으로", lambda: (expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible(timeout=8000), pg.url == book_url))
    check("책 메모 목록에 방금 메모", lambda: expect(pg.locator(".note-row")).to_contain_text("339쪽 · 찍은 문장 · 사진"))
    check("DB: 고른(고친) 문장만 저장 · 쪽수 · 한마디 · 밑줄 없음", lambda: sql("select body||'/'||page||'/'||thought||'/'||(select count(*) from bk_highlights) from bk_notes") == "그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다!/339/지금 내 이야기 같다/0")
    check("[사진도 남기기] 기억 · 창고에 한 장", lambda: sql("select keep_photo from bk_users") == "t" and len(photos()) == 1)
    check("사용량 2번(실패 1 + 성공 1)", lambda: sql("select count(*)||'/'||count(*) filter (where ok) from bk_ocr_usage") == "2/1")

    # ── 메모 자세히 ──
    pg.locator(".note-row").first.click()
    check("메모 자세히: 문장 · 내 생각, 밑줄 기능 없음", lambda: (expect(pg.locator("#note-body")).to_have_text("그 시대 사람들이 무엇을 생각했는지 놓치기 쉽다!"), expect(pg.locator(".note-thought-full")).to_contain_text("지금 내 이야기 같다"), pg.locator("main").inner_text().count("밑줄") == 0))
    pg.get_by_role("button", name="사진 보기").click()
    check("[사진 보기] 누르면 서명 주소로 사진", lambda: (pg.wait_for_timeout(1500), pg.evaluate("document.querySelector('#kept-photo img').naturalWidth") > 100, "token=" in pg.locator("#kept-photo img").get_attribute("src")) and pg.evaluate("document.querySelector('#kept-photo img').naturalWidth") > 100)
    pg.get_by_role("button", name="글 · 쪽수 고치기").click()
    pg.get_by_label("쪽수 (선택)").fill("340"); pg.get_by_role("button", name="고친 내용 저장").click()
    check("고치기 → 340쪽", lambda: expect(pg.locator(".note-meta-top")).to_contain_text("340쪽"))
    note_url = pg.url

    # ── 글자 모양: [나]에서 한 번 ──
    pg.goto(URL + "#/me")
    check("[나]에 글자 모양(글꼴 · 크기 · 미리 보기)", lambda: (expect(pg.get_by_role("heading", name="글자 모양")).to_be_visible(), expect(pg.locator("#read-font label.chip")).to_have_count(2), expect(pg.locator("#read-size label.chip")).to_have_count(5)))
    pg.locator("#read-font label.chip", has_text="고딕").click()
    pg.locator("#read-size label.chip", has_text="아주 크게").click()
    check("미리 보기가 바로 바뀜(고딕 · 26px)", lambda: pg.evaluate("(() => { const s=getComputedStyle(document.querySelector('.read-preview')); return s.fontFamily.includes('IBM Plex') && s.fontSize==='26px'; })()"))
    pg.screenshot(path=f"{SHOTS}/07-reading-settings.png", full_page=True)
    pg.goto(note_url); pg.reload()
    check("다시 열어도 메모 글에 그대로(고딕 · 26px)", lambda: (expect(pg.locator("#note-body")).to_be_visible(), pg.evaluate("(() => { const s=getComputedStyle(document.querySelector('#note-body')); return s.fontFamily.includes('IBM Plex') && s.fontSize==='26px'; })()")))
    pg.screenshot(path=f"{SHOTS}/08-note-big.png", full_page=True)

    # ── 두 번째 찍기: 한도 다 씀 → 직접 입력, 기억값 · 지난 쪽수 ──
    pg.goto(book_url); expect(pg.get_by_role("link", name="문장 찍기")).to_be_visible()
    sql("update bk_settings set value='2' where key='ocr_daily_limit'")
    pg.get_by_role("link", name="문장 찍기").click()
    pg.locator("input[data-file]").set_input_files("/tmp/bktest/page_small.jpg")
    expect(pg.get_by_role("heading", name="읽을 부분 감싸기")).to_be_visible()
    check("한도를 다 쓰면 [글자 읽기] 잠김 + 직접 입력 안내", lambda: (expect(pg.locator("#quota")).to_contain_text("2 / 2"), expect(pg.locator("#read")).to_be_disabled(), expect(pg.locator("#quota")).to_contain_text("직접 입력")))
    pg.get_by_role("button", name="글자 읽지 않고 직접 입력").click()
    check("직접 입력: 「문장 적기」 편집칸(설정한 글꼴 · 크기)", lambda: (expect(pg.get_by_role("heading", name="문장 적기")).to_be_visible(), expect(pg.get_by_label("책의 문장")).to_be_visible(), pg.evaluate("getComputedStyle(document.querySelector('#cap-body')).fontSize") == "26px"))
    pg.get_by_label("책의 문장").fill("손으로 옮겨 적은 문장.")
    check("지난 쪽수 안내", lambda: expect(pg.get_by_text("지난번에 339쪽을 적었어요")).to_be_visible())
    check("[더 하기] 제목에 사진 남김(지난 선택 기억)", lambda: expect(pg.locator("#more-state")).to_have_text(" · 사진 남김"))
    pg.locator("#more summary").click(); pg.locator("label.switch").click()
    pg.get_by_role("button", name="저장", exact=True).click()
    expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible(timeout=8000)
    check("끄고 저장 → 사진 안 올라감 · 선택 기억(꺼짐) · 사용량 그대로", lambda: len(photos()) == 1 and sql("select keep_photo from bk_users") == "f" and sql("select count(*) from bk_ocr_usage") == "2")

    # 내 생각 메모 · 목록
    pg.get_by_role("link", name="메모 쓰기").click()
    pg.get_by_label("떠오른 생각").fill("역사를 볼 때는\n그 시대의 눈으로."); pg.get_by_label("쪽수 (선택)").fill("12")
    pg.get_by_role("button", name="메모 저장").click()
    metas = lambda: [m.split(" · ")[0] for m in pg.locator(".note-row .note-meta").all_inner_texts()]
    check("책 메모 3개, 기본 최신순(12쪽 메모가 맨 위)", lambda: (expect(pg.locator(".note-row")).to_have_count(3), expect(pg.locator("[data-sort-select]")).to_have_value("new"), metas()[0] == "12쪽"))
    pg.locator("[data-sort-select]").select_option("old")
    check("오래된순(340쪽 → 찍은 문장 → 12쪽)", lambda: metas() == ["340쪽", "찍은 문장", "12쪽"])
    pg.locator("[data-sort-select]").select_option("page")
    check("쪽수순(12 → 340 → 쪽 없음)", lambda: metas() == ["12쪽", "340쪽", "찍은 문장"])
    pg.locator("[data-sort-select]").select_option("page_desc")
    check("쪽수 역순(340 → 12 → 쪽 없음)", lambda: metas() == ["340쪽", "12쪽", "찍은 문장"])

    # 기록 탭
    pg.goto(URL + "#/notes")
    check("기록 탭: [메모 3] [사진 1], 책 고르기, 정렬은 기억(쪽수 역순)", lambda: (expect(pg.get_by_role("button", name="메모 3")).to_be_visible(), expect(pg.get_by_role("button", name="사진 1")).to_be_visible(), pg.locator("main").inner_text().count("밑줄") == 0, expect(pg.locator("#shelf-pick")).to_be_visible(), expect(pg.locator("[data-sort-select]")).to_have_value("page_desc")))
    check("기록 탭 글도 설정한 크기", lambda: pg.evaluate("getComputedStyle(document.querySelector('.note-text')).fontSize") == "26px")
    pg.screenshot(path=f"{SHOTS}/09-notes-tab.png", full_page=True)
    pg.get_by_role("button", name="사진 1").click()
    check("[사진] 보기: 사진 1장이 격자로 · 책 이름 · 쪽", lambda: (expect(pg.locator(".photo-tile")).to_have_count(1), expect(pg.locator(".photo-cap")).to_have_text("사피엔스 · 340쪽")))
    pg.wait_for_timeout(1200)
    check("사진이 실제로 보임(잠깐 열리는 주소)", lambda: pg.evaluate("document.querySelector('.photo-tile img').naturalWidth") > 100 and "token=" in pg.locator(".photo-tile img").get_attribute("src"))
    pg.screenshot(path=f"{SHOTS}/10-photos-tab.png", full_page=True)
    pg.locator(".photo-tile").click()
    check("사진을 누르면 크게 보기 + [메모 보기]", lambda: (expect(pg.locator("dialog.photo-dialog img")).to_be_visible(), expect(pg.locator("dialog").get_by_role("link", name="메모 보기")).to_be_visible()))
    pg.wait_for_timeout(600)
    pg.screenshot(path=f"{SHOTS}/11-photo-viewer.png")
    pg.locator("dialog").get_by_role("link", name="메모 보기").click()
    check("[메모 보기] → 그 메모", lambda: (expect(pg.locator("#note-body")).to_contain_text("놓치기 쉽다!"), expect(pg.locator("dialog")).not_to_be_visible()))
    pg.go_back()
    check("돌아오면 사진 보기 그대로", lambda: expect(pg.locator(".photo-tile")).to_have_count(1))
    pg.get_by_role("button", name="메모 3").click()

    pg.goto(URL + "#/admin")
    check("관리자 화면 글자 읽기 사용량", lambda: (expect(pg.locator(".usage-big")).to_contain_text("2"), expect(pg.locator("#usage")).to_contain_text("실패 1")))

    pg.goto(book_url)
    pg.locator("[data-sort-select]").select_option("new")
    pg.locator(".note-row", has_text="사진").click()
    pg.get_by_role("button", name="메모 지우기").click()
    pg.locator("dialog").get_by_role("button", name="지우기").click()
    check("메모 지우기 → 사진도 창고에서 지워짐", lambda: (expect(pg.locator(".note-row")).to_have_count(2), photos() == []))
    # ── 1.4.0 띄어쓰기 의심: 빨간 밑줄 누르면 붙음 ──
    sql("update bk_settings set value='100' where key='ocr_daily_limit'")
    vision("layout")
    pg.goto(book_url); pg.get_by_role("link", name="문장 찍기").click()
    pg.locator("input[data-file]").set_input_files("/tmp/bktest/page_small.jpg")
    expect(pg.get_by_role("heading", name="읽을 부분 감싸기")).to_be_visible()
    pg.locator("#read").click()
    expect(pg.get_by_role("heading", name="문장 고르기")).to_be_visible(timeout=8000)
    words = lambda: pg.locator("#chooser button.w").all_inner_texts()
    check("띄어쓰기 의심 2곳에 빨간 밑줄 + 안내", lambda: (expect(pg.locator("#chooser .gap-fix")).to_have_count(2), expect(pg.locator("#fix-help")).to_contain_text("빨간 밑줄 2곳")))
    check("자신 없는 단어는 빨간 점선 + 안내", lambda: (expect(pg.locator("#chooser button.w.doubt")).to_have_text(["사람들이"]), expect(pg.locator("#fix-help")).to_contain_text("빨간 점선 단어 1개")))
    check("표시 글자는 화면에 안 보임", lambda: "\ue000" not in pg.locator("#chooser").inner_text() and "\ue001" not in pg.locator("#chooser").inner_text())
    pg.screenshot(path=f"{SHOTS}/12-gap-fix.png", full_page=True)
    pg.locator("#chooser .gap-fix").first.click()
    check("빨간 밑줄을 누르면 붙음(사 건을 → 사건을)", lambda: (expect(pg.locator("#chooser .gap-fix")).to_have_count(1), "사건을" in words() and "사" not in words()))
    pg.get_by_role("button", name="되돌리기").click()
    check("[되돌리기]", lambda: (expect(pg.locator("#chooser .gap-fix")).to_have_count(2), "사" in words()))
    w("우리가").click(); w("사람들이").click()
    pg.get_by_role("button", name="모두 붙이기").click()
    check("[모두 붙이기] → 밑줄 0 · 고른 범위도 그대로 따라감", lambda: (expect(pg.locator("#chooser .gap-fix")).to_have_count(0), expect(pg.locator("#chosen-text")).to_have_text("우리가 어떤 사건을 현재의 눈으로 보면, 그 시대 사람들이"), expect(pg.locator("#fix-help")).to_contain_text("모두 고쳤어요")))
    pg.get_by_label("쪽수").fill("20")
    pg.get_by_role("button", name="저장", exact=True).click()
    expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible(timeout=8000)
    check("저장된 글에는 표시 글자 없이 고친 띄어쓰기", lambda: sql("select body from bk_notes where page=20") == "우리가 어떤 사건을 현재의 눈으로 보면, 그 시대 사람들이")
    vision("ok")
    check("자바스크립트 오류 · 보안 규칙 위반 없음", lambda: (_ for _ in ()).throw(Exception(problems)) if problems else True)
    c.close()

    # ── PC: 파일 올리기가 먼저, 웹캠은 눌러야 켜짐 ──
    c2 = br.new_context(viewport={"width": 1280, "height": 900}, locale="ko-KR", permissions=["camera"])
    c2.add_init_script(GUM)
    pg2 = c2.new_page()
    pg2.goto(URL + "#/login")
    pg2.get_by_label("아이디").fill("owner_1"); pg2.get_by_label("비밀번호", exact=True).fill("reading2026")
    pg2.get_by_role("button", name="로그인").click()
    expect(pg2.get_by_role("heading", name="태관님의 서재")).to_be_visible()
    pg2.goto(book_url)
    pg2.get_by_role("link", name="문장 찍기").click()
    check("PC: [사진 파일 올리기] · [웹캠으로 찍기], 카메라는 저절로 안 켜짐", lambda: (expect(pg2.locator("label.file-btn", has_text="사진 파일 올리기")).to_be_visible(), expect(pg2.get_by_role("button", name="웹캠으로 찍기")).to_be_visible(), pg2.evaluate("window.__gum.length") == 0))
    pg2.get_by_role("button", name="웹캠으로 찍기").click()
    check("PC: 웹캠 켜고 찍기", lambda: expect(pg2.get_by_role("button", name="찍기 (소리 없음)")).to_be_visible(timeout=6000))
    pg2.locator("label.file-btn input").set_input_files(PHOTO)
    expect(pg2.get_by_role("heading", name="읽을 부분 감싸기")).to_be_visible()
    pg2.wait_for_timeout(300)
    check("PC: 사진 무대가 폰 너비 안 · 웹캠 꺼짐", lambda: pg2.locator("#stage").bounding_box()["width"] <= 34 * 16 and pg2.evaluate("window.__gum.every(g => g.s.getTracks().every(t => t.readyState === 'ended'))"))
    pg2.screenshot(path=f"{SHOTS}/13-pc-area.png")
    br.close()
print(f"\n{sum(res)}/{len(res)} 통과")
