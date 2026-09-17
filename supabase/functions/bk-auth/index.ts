// bk-auth — 독서 앱 가입 · 로그인 (v1, 2026-09-17)
//   /signup    아이디·비밀번호·이름 → 대기 상태로 가입, 출입증 발급
//   /login     아이디·비밀번호 → 출입증 발급 (5번 틀리면 15분 잠금)
//   /me        출입증 → 내 정보
//   /logout    출입증 지우기
//   /password  비밀번호 바꾸기 (다른 기기 출입증은 모두 지움)
//   /profile   보이는 이름 바꾸기
import {
  createSession, DUMMY_HASH, hashPassword, json, LOCK_AFTER_FAILS, LOCK_MINUTES,
  publicUser, serve, sessionUser, str, supa, UserError, validPassword, verifyPassword,
  type BkUser,
} from "./common.ts";

const MAX_PENDING = 30; // 승인 안 된 가입 신청이 이만큼 쌓이면 새 가입을 막음 (장난 가입 방지)

function checkUsername(raw: string): string {
  const u = raw.toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) {
    throw new UserError(400, "아이디는 영문 소문자·숫자·밑줄(_)로 3~20자입니다.");
  }
  return u;
}

function checkName(raw: string): string {
  const n = raw.replace(/\s+/g, " ").trim();
  if (n.length < 1 || n.length > 20) throw new UserError(400, "이름은 1~20자로 적어 주세요.");
  return n;
}

serve("bk-auth", {
  "/signup": async (req, body) => {
    const username = checkUsername(str(body, "username", 40));
    const password = typeof body.password === "string" ? body.password : "";
    const pwErr = validPassword(password);
    if (pwErr) throw new UserError(400, pwErr);
    const displayName = checkName(str(body, "display_name", 40));

    const { count } = await supa.from("bk_users")
      .select("id", { count: "exact", head: true }).eq("status", "pending");
    if ((count ?? 0) >= MAX_PENDING) {
      throw new UserError(429, "지금은 가입 신청을 받을 수 없어요. 관리자에게 문의해 주세요.");
    }
    const { data: dup } = await supa.from("bk_users").select("id").eq("username", username).maybeSingle();
    if (dup) throw new UserError(409, "이미 쓰고 있는 아이디입니다. 다른 아이디를 골라 주세요.");

    const { data: user, error } = await supa.from("bk_users").insert({
      username, password_hash: await hashPassword(password), display_name: displayName,
    }).select("*").single();
    if (error || !user) {
      if (error?.code === "23505") throw new UserError(409, "이미 쓰고 있는 아이디입니다. 다른 아이디를 골라 주세요.");
      throw new Error("가입 저장 실패: " + (error?.message ?? ""));
    }
    const token = await createSession(user.id, req);
    return json(200, { token, user: publicUser(user as BkUser) });
  },

  "/login": async (req, body) => {
    const username = str(body, "username", 40).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) throw new UserError(400, "아이디와 비밀번호를 입력해 주세요.");
    const wrong = "아이디 또는 비밀번호가 맞지 않습니다.";

    const { data } = await supa.from("bk_users").select("*").eq("username", username).maybeSingle();
    const user = data as BkUser | null;
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw new UserError(401, wrong);
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const min = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      throw new UserError(423, `비밀번호를 여러 번 틀려 잠겼어요. ${min}분 뒤에 다시 해 주세요.`);
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const fails = (user.failed_attempts ?? 0) + 1;
      if (fails >= LOCK_AFTER_FAILS) {
        await supa.from("bk_users").update({
          failed_attempts: 0,
          locked_until: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(),
        }).eq("id", user.id);
        throw new UserError(423, `비밀번호를 ${LOCK_AFTER_FAILS}번 틀려 ${LOCK_MINUTES}분 동안 잠겼어요.`);
      }
      await supa.from("bk_users").update({ failed_attempts: fails }).eq("id", user.id);
      throw new UserError(401, `${wrong} (${fails}/${LOCK_AFTER_FAILS}번)`);
    }
    // 비밀번호가 맞은 뒤에만 계정 상태를 알려 준다
    if (user.status === "rejected") throw new UserError(403, "가입이 승인되지 않은 계정입니다. 관리자에게 문의해 주세요.");
    if (user.status === "disabled") throw new UserError(403, "사용이 중지된 계정입니다. 관리자에게 문의해 주세요.");

    await supa.from("bk_users").update({ failed_attempts: 0, locked_until: null }).eq("id", user.id);
    await supa.from("bk_sessions").delete().eq("user_id", user.id).lt("expires_at", new Date().toISOString());
    const token = await createSession(user.id, req);
    return json(200, { token, user: publicUser({ ...user, failed_attempts: 0, locked_until: null }) });
  },

  "/me": async (_req, body) => {
    const su = await sessionUser(str(body, "token", 100));
    if (!su) throw new UserError(401, "다시 로그인해 주세요.", "LOGIN_REQUIRED");
    if (su.user.status === "rejected" || su.user.status === "disabled") {
      await supa.from("bk_sessions").delete().eq("token_hash", su.tokenHash);
      throw new UserError(403, "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.", "BLOCKED");
    }
    return json(200, { user: publicUser(su.user) });
  },

  "/logout": async (_req, body) => {
    const su = await sessionUser(str(body, "token", 100));
    if (su) await supa.from("bk_sessions").delete().eq("token_hash", su.tokenHash);
    return json(200, { ok: true });
  },

  "/password": async (_req, body) => {
    const su = await sessionUser(str(body, "token", 100));
    if (!su) throw new UserError(401, "다시 로그인해 주세요.", "LOGIN_REQUIRED");
    const current = typeof body.current_password === "string" ? body.current_password : "";
    const next = typeof body.new_password === "string" ? body.new_password : "";
    if (!(await verifyPassword(current, su.user.password_hash))) {
      throw new UserError(401, "지금 비밀번호가 맞지 않습니다.");
    }
    const pwErr = validPassword(next);
    if (pwErr) throw new UserError(400, pwErr);
    if (next === current) throw new UserError(400, "새 비밀번호가 지금 비밀번호와 같아요.");
    const { error } = await supa.from("bk_users")
      .update({ password_hash: await hashPassword(next) }).eq("id", su.user.id);
    if (error) throw new Error(error.message);
    await supa.from("bk_sessions").delete().eq("user_id", su.user.id).neq("token_hash", su.tokenHash);
    return json(200, { ok: true });
  },

  "/profile": async (_req, body) => {
    const su = await sessionUser(str(body, "token", 100));
    if (!su) throw new UserError(401, "다시 로그인해 주세요.", "LOGIN_REQUIRED");
    const displayName = checkName(str(body, "display_name", 40));
    const { data, error } = await supa.from("bk_users")
      .update({ display_name: displayName }).eq("id", su.user.id).select("*").single();
    if (error || !data) throw new Error(error?.message ?? "이름 저장 실패");
    return json(200, { user: publicUser(data as BkUser) });
  },
});
