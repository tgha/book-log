# 5단계 화면 시험: 책 공개 스위치 · 둘러보기(회원 · 최근 문장 · 공개 책 보기) · 통계(달 넘기기 · 달력 · 표지) · 서재 이어서 읽은 날
import subprocess, os, datetime
from playwright.sync_api import sync_playwright, expect
SHOTS = "/tmp/bktest/shots5"; os.makedirs(SHOTS, exist_ok=True)
URL = "http://127.0.0.1:8080/"
def sql(q): return subprocess.run(["su","postgres","-c",f"psql -h /tmp/pgtest -p 55432 -U postgres -Atq -c \"{q}\""],capture_output=True,text=True).stdout.strip()
res = []; problems = []
def check(n, fn):
    try:
        r = fn()
        if r is False: raise Exception("조건 불만족")
        res.append(True); print("PASS", n)
    except Exception as e: res.append(False); print("FAIL", n, "->", str(e).splitlines()[0][:240])
today = datetime.date.fromisoformat(sql("select (now() at time zone 'Asia/Seoul')::date"))
d = lambda n: (today - datetime.timedelta(days=n)).isoformat()
sql("delete from bk_users; delete from bk_books;")

def login(pg, user, name):
    pg.goto(URL + "#/signup")
    pg.get_by_label("아이디").fill(user); pg.get_by_label("이름").fill(name)
    pg.get_by_label("비밀번호", exact=True).fill("reading2026"); pg.get_by_label("비밀번호 한 번 더").fill("reading2026")
    pg.get_by_role("button", name="가입 신청 보내기").click()
    expect(pg.get_by_role("heading", name="승인을 기다리고 있어요")).to_be_visible()
    sql("update bk_users set status='approved'")
    pg.get_by_role("button", name="지금 확인하기").click()
    expect(pg.get_by_role("heading", name=f"{name}님의 서재")).to_be_visible()

def add_book(pg, q, name, pages=None):
    pg.goto(URL + "#/add"); pg.get_by_label("제목이나 저자로 찾기").fill(q); pg.get_by_role("button", name="찾기", exact=True).click()
    pg.locator("#results .book-row", has_text=name).click()
    if pages: pg.get_by_label("전체 쪽수 (선택)").fill(pages)
    pg.get_by_role("button", name="서재에 넣기").click()
    expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible()
    return pg.url

with sync_playwright() as p:
    br = p.chromium.launch(args=["--no-proxy-server"])
    c = br.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ko-KR")
    pg = c.new_page()
    pg.on("console", lambda m: m.type == "error" and "fonts.g" not in m.text and "status of 4" not in m.text and problems.append(m.text))
    pg.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
    login(pg, "owner_1", "태관")
    book_url = add_book(pg, "사피엔스", "사피엔스", "636")
    money_url = add_book(pg, "심리", "돈의 심리학")
    SA = book_url.split("/")[-1]; SM = money_url.split("/")[-1]
    # 메모 · 사진 · 독서 시간 (시험을 빨리 하려고 서버 경로로 직접 넣지 않고 화면으로 넣음)
    pg.goto(book_url)
    pg.get_by_role("link", name="메모 쓰기").click()
    pg.get_by_label("떠오른 생각").fill("공개해도 좋은 문장이에요."); pg.get_by_label("쪽수 (선택)").fill("10")
    pg.get_by_role("button", name="메모 저장").click()
    expect(pg.locator(".note-row")).to_have_count(1)
    for i, (day, mins) in enumerate([(d(0), 30), (d(1), 45), (d(2), 20), (d(35), 60)]):
        pg.get_by_role("link", name="시간 적기").click()
        expect(pg.get_by_role("heading", name="독서 시간 적기")).to_be_visible()
        pg.get_by_label("읽은 날").fill(day)
        pg.get_by_label("읽은 시간 (분)").fill(str(mins))
        expect(pg.get_by_label("읽은 날")).to_have_value(day)
        pg.get_by_role("button", name="저장").click()
        expect(pg.locator(".log-row")).to_have_count(i + 1)

    # ── 공개 스위치 ──
    check("책 화면에 [이 책 공개하기] · 설명", lambda: (expect(pg.get_by_role("switch", name="이 책 공개하기")).not_to_be_checked(), expect(pg.get_by_text("승인된 회원이 [둘러보기]에서")).to_be_visible()))
    pg.locator("#public-block label.switch").click()
    check("공개 켜면 저장됨", lambda: (expect(pg.get_by_text("이 책을 공개했어요.")).to_be_visible(), sql(f"select is_public from bk_shelf where id='{SA}'") == "t"))
    pg.screenshot(path=f"{SHOTS}/01-public-switch.png", full_page=True)
    pg.reload()
    check("다시 열어도 켜진 채", lambda: expect(pg.get_by_role("switch", name="이 책 공개하기")).to_be_checked())

    # ── 서재: 이어서 읽은 날 ──
    pg.goto(URL + "#/shelf")
    check("서재 「이어서 읽은 날 3일째」 · 오늘 읽은 시간", lambda: (expect(pg.locator("#streak-days")).to_contain_text("3"), expect(pg.locator("#streak-note")).to_contain_text("오늘 30분 읽었어요")))
    pg.screenshot(path=f"{SHOTS}/02-shelf-streak.png")
    check("읽는 중 카드에 빠른 단추 [독서 시작] · [문장 찍기]", lambda: (expect(pg.locator(".row-quick")).to_have_count(2), expect(pg.locator(".row-quick").first.get_by_role("button", name="독서 시작")).to_be_visible(), expect(pg.locator(".row-quick").first.get_by_role("link", name="문장 찍기")).to_be_visible()))
    pg.locator(".row-quick").first.get_by_role("button", name="독서 시작").click()
    check("서재에서 바로 타이머 시작", lambda: expect(pg.locator("#clock")).to_be_visible())
    pg.get_by_role("button", name="멈춤").click(); pg.get_by_role("button", name="기록하지 않고 끝내기").click()
    pg.locator("dialog").get_by_role("button", name="끝내기").click()
    expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible()

    # ── 통계 ──
    pg.goto(URL + "#/stats")
    check("통계: 이번 달 · 큰 숫자 4개", lambda: (expect(pg.locator(".month-nav h2")).to_have_text(f"{today.year}년 {today.month}월"), expect(pg.locator(".stat-cards li")).to_have_count(4)))
    this_month_total = sum(m for day, m in [(d(0), 30), (d(1), 45), (d(2), 20), (d(35), 60)] if day[:7] == today.isoformat()[:7])
    check(f"이번 달 읽은 시간 합계", lambda: expect(pg.locator(".stat-cards li", has_text="읽은 시간")).to_contain_text("시간" if this_month_total >= 60 else "분"))
    check("하루 평균은 오늘까지 날수 기준", lambda: expect(pg.locator(".stat-cards li", has_text="하루 평균")).to_contain_text(f"({today.day}일 기준)"))
    check("이어서 읽은 날 3일째 · 최고 기록", lambda: (expect(pg.locator(".streak-big")).to_contain_text("3"), expect(pg.locator(".streak-row .hint")).to_contain_text("가장 길었던 기록 3일")))
    check("달력에 오늘 표시 · 읽은 날 색칠", lambda: (expect(pg.locator(".cal-cell.today")).to_have_count(1), pg.locator(".cal-cell:not(.level-0):not(.empty)").count() >= 1))
    check("조금이라도 읽은 책 1권 · 다 읽은 책 0권", lambda: (expect(pg.locator(".stat-cards li", has_text="조금이라도 읽은 책")).to_contain_text("1"), expect(pg.locator(".stat-cards li", has_text="다 읽은 책")).to_contain_text("0")))
    check("읽는 중인 책 목록에 2권", lambda: expect(pg.locator(".note-list .note-row")).to_have_count(2))
    pg.screenshot(path=f"{SHOTS}/03-stats.png", full_page=True)
    pg.get_by_role("link", name="앞 달").click()
    last = (today.replace(day=1) - datetime.timedelta(days=1))
    check("[◀] 지난달로", lambda: expect(pg.locator(".month-nav h2")).to_have_text(f"{last.year}년 {last.month}월"))
    check("지난달은 그 달 날수로 나눔", lambda: expect(pg.locator(".stat-cards li", has_text="하루 평균")).to_contain_text(f"({(today.replace(day=1) - datetime.timedelta(days=1)).day}일 기준)"))
    pg.get_by_role("link", name="다음 달").click()
    check("[▶]로 이번 달, 이번 달에선 다음 달 없음", lambda: (expect(pg.locator(".month-nav h2")).to_have_text(f"{today.year}년 {today.month}월"), expect(pg.get_by_role("link", name="다음 달")).to_have_count(0)))
    # 다 읽음으로 바꾸면 표지 모음에
    pg.goto(book_url); pg.locator("label.chip", has_text="다 읽음").click()
    expect(pg.get_by_text("저장했어요.")).to_be_visible()   # 서버 저장이 끝난 뒤에 통계로
    pg.goto(URL + "#/stats")
    expect(pg.locator(".month-nav h2")).to_be_visible()
    check("다 읽은 책 표지 모음에 나타남", lambda: (expect(pg.locator(".cover-grid li")).to_have_count(1), expect(pg.locator(".cover-title")).to_have_text("사피엔스")))
    pg.locator(".cover-grid a").click()
    check("표지를 누르면 그 책으로", lambda: expect(pg.get_by_role("button", name="서재에서 빼기")).to_be_visible())

    # ── 둘러보기 (다른 회원 계정) ──
    c2 = br.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ko-KR")
    pg2 = c2.new_page()
    pg2.on("pageerror", lambda e: problems.append("pageerror2: " + str(e)))
    login(pg2, "reader_2", "영희")
    pg2.goto(URL + "#/explore")
    check("둘러보기: [회원] [최근 문장]", lambda: (expect(pg2.get_by_role("button", name="회원")).to_be_visible(), expect(pg2.get_by_role("button", name="최근 문장")).to_be_visible()))
    check("공개한 회원 목록(태관 · 1권)", lambda: expect(pg2.locator(".note-row").first).to_contain_text("태관"))
    pg2.screenshot(path=f"{SHOTS}/04-explore.png", full_page=True)
    pg2.get_by_role("button", name="최근 문장").click()
    check("최근 공개 문장", lambda: (expect(pg2.locator(".note-row")).to_have_count(1), expect(pg2.locator(".note-text")).to_have_text("공개해도 좋은 문장이에요."), expect(pg2.locator(".note-meta").first).to_contain_text("태관 · 사피엔스 · 10쪽")))
    pg2.locator(".note-row").first.click()
    check("공개 책 화면: 주인 · 메모 · 독서 시간", lambda: (expect(pg2.get_by_role("heading", name="사피엔스")).to_be_visible(), expect(pg2.locator(".shared-notes .note-body")).to_have_text("공개해도 좋은 문장이에요."), expect(pg2.locator(".log-list li")).to_have_count(4)))
    check("보기만 가능(고치기 · 지우기 단추 없음)", lambda: pg2.get_by_role("button", name="메모 지우기").count() == 0 and pg2.get_by_role("button", name="독서 시작").count() == 0)
    check("남의 기록이라는 안내", lambda: expect(pg2.get_by_text("공개한 기록이에요. 보기만 할 수 있어요.")).to_be_visible())
    pg2.screenshot(path=f"{SHOTS}/05-shared-book.png", full_page=True)
    pg2.get_by_role("link", name="← 태관님의 책장").click()
    check("책장 화면(공개한 책만 · 메모 수)", lambda: (expect(pg2.get_by_role("heading", name="태관님이 공개한 책")).to_be_visible(), expect(pg2.locator(".book-row")).to_have_count(1), expect(pg2.locator(".book-row .note-meta")).to_contain_text("메모 1개")))
    # 비공개 책은 주소를 알아도 못 봄
    pg2.goto(URL + f"#/shared-book/{SM}")
    check("비공개 책은 주소로도 못 봄", lambda: expect(pg2.get_by_text("지금은 볼 수 없는 책이에요")).to_be_visible())
    # 공개를 끄면 바로 사라짐
    pg.goto(book_url); pg.locator("#public-block label.switch").click()
    expect(pg.get_by_text("공개를 껐어요.")).to_be_visible()
    pg2.goto(URL + "#/explore"); pg2.reload()
    check("공개를 끄면 둘러보기에서 사라짐", lambda: expect(pg2.get_by_text("아직 공개한 책이 없어요")).to_be_visible())
    pg2.goto(URL + f"#/shared-book/{SA}")
    check("보던 주소도 막힘", lambda: expect(pg2.get_by_text("지금은 볼 수 없는 책이에요")).to_be_visible())
    check("자바스크립트 오류 없음", lambda: (_ for _ in ()).throw(Exception(problems)) if problems else True)
    br.close()
print(f"\n{sum(res)}/{len(res)} 통과")
