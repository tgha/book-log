// bk-ocr — 글자 읽기 (v1, 2026-09-17 · 3단계)
//   /quota  오늘 [글자 읽기]를 몇 번 썼는지 · 하루 한도
//   /read   사진 → 구글 Vision 「문서용 글자 읽기」(한국어 우선) → 글자
//
// 약속
//   · 열쇠는 Supabase 비밀값 BK_GOOGLE_VISION_KEY 에만 있다. 화면으로 절대 내보내지 않는다.
//   · 한 사람 하루 한도(bk_settings.ocr_daily_limit, 한국 날짜 기준)를 넘으면 구글을 부르지 않는다.
//   · 「1번」= 구글에 실제로 사진을 보낸 [글자 읽기] 한 번. 성공 · 실패 모두 bk_ocr_usage 에 적는다.
//     (사진이 잘못됐거나 · 한도를 넘었거나 · 열쇠가 아예 없어서 구글을 부르지 않은 경우는 세지 않음)
//   · 실패해도 저절로 다시 시도하지 않는다. 이유를 쉬운 말로 돌려준다.
//   · BK_VISION_BASE 는 시험용 가짜 구글 주소. 비밀값에 넣지 않으면 진짜 구글을 쓴다.
import { decodeImage, json, kstToday, requireApproved, serve, supa, UserError } from "./common.ts";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 화면은 보통 0.3~0.9MB 로 줄여 보냄
const VISION_TIMEOUT_MS = 20000;

async function dailyLimit(): Promise<number> {
  const { data, error } = await supa.from("bk_settings").select("value").eq("key", "ocr_daily_limit").maybeSingle();
  if (error) throw new Error("한도 읽기 실패: " + error.message);
  const n = Number(data?.value);
  return Number.isInteger(n) && n > 0 ? n : 100;
}

/** 오늘 쓴 횟수. upToId 를 주면 그 줄까지(먼저 누른 것부터)만 센다 */
async function usedToday(userId: string, upToId?: number): Promise<number> {
  let q = supa.from("bk_ocr_usage")
    .select("id", { count: "exact", head: true }).eq("user_id", userId).eq("used_on", kstToday());
  if (upToId !== undefined) q = q.lte("id", upToId);
  const { count, error } = await q;
  if (error) throw new Error("사용량 읽기 실패: " + error.message);
  return count ?? 0;
}

async function finish(rowId: number, ok: boolean, error: string | null) {
  const { error: e } = await supa.from("bk_ocr_usage").update({ ok, error }).eq("id", rowId);
  if (e) console.error("[bk-ocr] 사용 기록 고치기 실패", e.message);
}

/** Vision 이 돌려준 글자 정리: 줄바꿈 통일, 끝 공백 · 빈 줄 정리 */
function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000);
}

serve("bk-ocr", {
  "/quota": async (_req, body) => {
    const { user } = await requireApproved(body);
    const [used, limit] = await Promise.all([usedToday(user.id), dailyLimit()]);
    // [사진도 남기기] 마지막 선택도 함께 (다른 기기에서 바꿨을 수 있어서 찍을 때마다 새로 알려 줌)
    return json(200, { used, limit, keep_photo: user.keep_photo });
  },

  "/read": async (_req, body) => {
    const { user } = await requireApproved(body);
    const img = decodeImage(body.image, MAX_IMAGE_BYTES);
    const key = Deno.env.get("BK_GOOGLE_VISION_KEY");
    if (!key) throw new UserError(503, "글자 읽기 준비가 아직 안 됐어요. 관리자에게 알려 주세요.", "NO_VISION_KEY");

    // 한도: 먼저 한 줄 적어 순번을 받고, 오늘 나보다 먼저 적힌 줄까지 센다
    //       → 동시에 여러 번 눌러도 먼저 누른 순서대로 한도만큼만 통과
    const limit = await dailyLimit();
    const { data: row, error: insErr } = await supa.from("bk_ocr_usage")
      .insert({ user_id: user.id, ok: false, image_bytes: img.bytes.length, error: "읽는 중" }).select("id").single();
    if (insErr || !row) throw new Error("사용 기록 실패: " + insErr?.message);
    const used = await usedToday(user.id, row.id);
    if (used > limit) {
      await supa.from("bk_ocr_usage").delete().eq("id", row.id);
      throw new UserError(429, `오늘 글자 읽기를 ${limit}번 모두 썼어요. 내일 다시 쓰거나 [직접 입력]으로 적어 주세요.`, "OCR_LIMIT");
    }

    const base = Deno.env.get("BK_VISION_BASE") ?? "https://vision.googleapis.com";
    const started = Date.now();
    let r: Response;
    try {
      // 열쇠는 주소(?key=)가 아니라 머리글로 보낸다 → 주소가 기록에 남아도 열쇠는 안 남음
      r = await fetch(`${base}/v1/images:annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({
          requests: [{
            image: { content: img.b64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["ko", "en"] },
          }],
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
    } catch (e) {
      console.error("[bk-ocr] vision fetch failed", String(e));
      await finish(row.id, false, "VISION_DOWN");
      throw new UserError(502, "글자 읽기 서버에 연결하지 못했어요. 인터넷을 확인하고 [다시 시도]를 눌러 주세요.", "VISION_DOWN");
    }

    let j: Record<string, unknown> = {};
    try { j = await r.json(); } catch { /* 빈 응답 */ }
    const apiErr = (j.error ?? {}) as { code?: number; status?: string; message?: string };
    if (!r.ok) {
      // 열쇠 문제(틀림 · API 꺼짐 · 사용 제한)는 사용자님이 고칠 일이라 따로 알린다. 메시지에 열쇠 값은 들어가지 않음
      console.error("[bk-ocr] vision status", r.status, apiErr.status, (apiErr.message ?? "").slice(0, 300));
      const msg = (apiErr.message ?? "").toLowerCase();
      if (r.status === 401 || r.status === 403 || msg.includes("api key") || apiErr.status === "PERMISSION_DENIED") {
        await finish(row.id, false, "VISION_AUTH");
        throw new UserError(502, "글자 읽기 열쇠에 문제가 있어요. 관리자에게 알려 주세요. 지금은 [직접 입력]으로 적을 수 있어요.", "VISION_AUTH");
      }
      if (r.status === 429) {
        await finish(row.id, false, "VISION_QUOTA");
        throw new UserError(502, "구글 글자 읽기의 하루 사용량이 다 찼어요. 잠시 뒤나 내일 다시 해 주세요.", "VISION_QUOTA");
      }
      if (r.status === 400) {
        await finish(row.id, false, "BAD_IMAGE");
        throw new UserError(400, "구글이 이 사진을 읽지 못했어요. 다시 찍어 주세요.", "BAD_IMAGE");
      }
      await finish(row.id, false, "VISION_DOWN");
      throw new UserError(502, "글자 읽기 서버가 응답하지 않아요. 잠시 뒤 [다시 시도]를 눌러 주세요.", "VISION_DOWN");
    }

    const res0 = (Array.isArray(j.responses) ? j.responses[0] : null) as Record<string, unknown> | null;
    const resErr = res0?.error as { message?: string } | undefined;
    if (resErr) {
      console.error("[bk-ocr] vision response error", (resErr.message ?? "").slice(0, 300));
      await finish(row.id, false, "BAD_IMAGE");
      throw new UserError(400, "구글이 이 사진을 읽지 못했어요. 다시 찍어 주세요.", "BAD_IMAGE");
    }
    const text = tidy(String((res0?.fullTextAnnotation as { text?: string } | undefined)?.text ?? ""));
    if (!text) {
      await finish(row.id, true, "NO_TEXT");
      throw new UserError(422, "사진에서 글자를 찾지 못했어요. 글자가 크고 또렷하게 나오게 다시 찍어 주세요.", "NO_TEXT");
    }
    await finish(row.id, true, null);
    return json(200, { text, used, limit, ms: Date.now() - started });
  },
});
