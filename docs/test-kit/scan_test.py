import subprocess
from playwright.sync_api import sync_playwright, expect
def sql(q): return subprocess.run(["su","postgres","-c",f"psql -h /tmp/pgtest -p 55432 -U postgres -Atq -c \"{q}\""],capture_output=True,text=True).stdout.strip()
sql("delete from bk_users; delete from bk_books;")
FAKE = """
window.__detectCalls = 0;
window.BarcodeDetector = class { static async getSupportedFormats(){ return ['ean_13','qr_code']; }
  constructor(o){ this.o=o; }
  async detect(v){ window.__detectCalls++; return window.__detectCalls > 60 ? [{rawValue:'9788934972464'}] : []; } };
"""
ok=0; total=0
def check(n, fn):
    global ok,total; total+=1
    try: fn(); ok+=1; print("PASS",n)
    except Exception as e: print("FAIL",n,"->",str(e).splitlines()[0][:200])
with sync_playwright() as p:
    br=p.chromium.launch(args=["--no-proxy-server","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"])
    c=br.new_context(viewport={"width":412,"height":915}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ko-KR", permissions=["camera"])
    c.add_init_script(FAKE)
    pg=c.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8080/#/signup")
    pg.get_by_label("아이디").fill("owner_1"); pg.get_by_label("이름").fill("태관")
    pg.get_by_label("비밀번호", exact=True).fill("reading2026"); pg.get_by_label("비밀번호 한 번 더").fill("reading2026")
    pg.get_by_role("button", name="가입 신청 보내기").click()
    expect(pg.get_by_role("heading", name="승인을 기다리고 있어요")).to_be_visible()
    sql("update bk_users set status='approved'")
    pg.reload(); expect(pg.get_by_role("heading", name="태관님의 서재")).to_be_visible()
    pg.get_by_role("link", name="＋ 책 등록하기").click(); pg.get_by_role("link", name="바코드 찍기").click(); pg.wait_for_timeout(1500)
    check("카메라 화면 켜짐", lambda: expect(pg.locator("#scanner")).to_be_visible())
    check("찍는 중에는 [다시 찍기] 숨김", lambda: expect(pg.get_by_role("button", name="다시 찍기")).to_be_hidden())
    check("새 안내 문구", lambda: expect(pg.locator("#scan-help")).to_contain_text("가득 차게"))
    pg.wait_for_timeout(300)
    box=pg.locator(".scan-frame").bounding_box(); sc=pg.locator("#scanner").bounding_box()
    print("  네모 크기:", round(box["width"]), "x", round(box["height"]), "/ 카메라 칸:", round(sc["width"]), "x", round(sc["height"]))
    check("네모가 화면 폭의 85% 이상", lambda: None if box["width"] >= sc["width"]*0.85 else (_ for _ in ()).throw(Exception(box)))
    pg.screenshot(path="/tmp/bktest/shots2/07-scanner.png")
    check("인식되면 자동으로 책 확인 화면", lambda: expect(pg.get_by_role("heading", name="사피엔스")).to_be_visible(timeout=6000))
    check("카메라 꺼짐(화면 이동 후)", lambda: pg.wait_for_function("!document.querySelector('#cam')", timeout=3000))
    check("자바스크립트 오류 없음", lambda: None if not errs else (_ for _ in ()).throw(Exception(errs)))
    br.close()
print(f"{ok}/{total} 통과")
