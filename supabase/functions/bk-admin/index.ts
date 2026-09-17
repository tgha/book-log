// bk-admin — 독서 앱 관리자 기능 (v1, 2026-09-17)
//   /users            회원 목록 (승인 대기 먼저)
//   /approve          승인
//   /reject           거절 (출입증 지움)
//   /disable          사용 중지 (출입증 지움)
//   /enable           다시 승인
//   /reset-password   임시 비밀번호 발급 (한 번만 보여 줌, 출입증 지움)
//   /settings         설정값 보기
//   /settings/set     설정값 바꾸기 (지금은 글자 읽기 하루 한도만)
import {
  hashPassword, json, requireApproved, serve, str, supa, tempPassword, UserError, type BkUser,
} from "./common.ts";

async function requireAdmin(body: Record<string, unknown>) {
  const su = await requireApproved(body);
  if (!su.user.is_admin) throw new UserError(403, "관리자만 쓸 수 있어요.", "NOT_ADMIN");
  return su;
}

async function targetUser(body: Record<string, unknown>, adminId: string): Promise<BkUser> {
  const id = str(body, "user_id", 40);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new UserError(400, "회원을 골라 주세요.");
  if (id === adminId) throw new UserError(400, "내 계정에는 쓸 수 없는 기능입니다.");
  const { data } = await supa.from("bk_users").select("*").eq("id", id).maybeSingle();
  if (!data) throw new UserError(404, "회원을 찾을 수 없어요.");
  return data as BkUser;
}

function row(u: BkUser) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, status: u.status,
    is_admin: u.is_admin, created_at: u.created_at, approved_at: u.approved_at,
    locked: !!(u.locked_until && new Date(u.locked_until) > new Date()),
  };
}

async function setStatus(body: Record<string, unknown>, status: BkUser["status"], allowFrom: BkUser["status"][]) {
  const { user: admin } = await requireAdmin(body);
  const t = await targetUser(body, admin.id);
  if (!allowFrom.includes(t.status)) throw new UserError(409, "이미 처리된 회원입니다. 목록을 새로 불러와 주세요.");
  const upd: Record<string, unknown> = { status };
  if (status === "approved") {
    upd.approved_at = new Date().toISOString();
    upd.approved_by = admin.id;
    upd.failed_attempts = 0;
    upd.locked_until = null;
  }
  const { data, error } = await supa.from("bk_users").update(upd).eq("id", t.id).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "상태 저장 실패");
  if (status === "rejected" || status === "disabled") {
    await supa.from("bk_sessions").delete().eq("user_id", t.id);
  }
  return json(200, { user: row(data as BkUser) });
}

serve("bk-admin", {
  "/users": async (_req, body) => {
    await requireAdmin(body);
    const { data, error } = await supa.from("bk_users").select("*").order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const order = { pending: 0, approved: 1, disabled: 2, rejected: 3 } as const;
    const users = (data as BkUser[]).map(row).sort((a, b) => order[a.status] - order[b.status]);
    return json(200, { users });
  },

  "/approve": (_req, body) => setStatus(body, "approved", ["pending"]),
  "/reject": (_req, body) => setStatus(body, "rejected", ["pending"]),
  "/disable": (_req, body) => setStatus(body, "disabled", ["approved"]),
  "/enable": (_req, body) => setStatus(body, "approved", ["disabled", "rejected"]),

  "/reset-password": async (_req, body) => {
    const { user: admin } = await requireAdmin(body);
    const t = await targetUser(body, admin.id);
    const temp = tempPassword();
    const { error } = await supa.from("bk_users").update({
      password_hash: await hashPassword(temp), failed_attempts: 0, locked_until: null,
    }).eq("id", t.id);
    if (error) throw new Error(error.message);
    await supa.from("bk_sessions").delete().eq("user_id", t.id);
    return json(200, { username: t.username, temp_password: temp });
  },

  "/settings": async (_req, body) => {
    await requireAdmin(body);
    const { data } = await supa.from("bk_settings").select("key, value");
    const settings: Record<string, unknown> = {};
    for (const r of data ?? []) settings[r.key] = r.value;
    return json(200, { settings });
  },

  "/settings/set": async (_req, body) => {
    const { user: admin } = await requireAdmin(body);
    const key = str(body, "key", 40);
    if (key !== "ocr_daily_limit") throw new UserError(400, "바꿀 수 없는 설정입니다.");
    const n = Number(body.value);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UserError(400, "하루 한도는 1~1000 사이 숫자로 적어 주세요.");
    const { error } = await supa.from("bk_settings").upsert({
      key, value: n, updated_at: new Date().toISOString(), updated_by: admin.id,
    });
    if (error) throw new Error(error.message);
    return json(200, { ok: true, key, value: n });
  },
});
