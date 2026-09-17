// book-log 엣지함수 공통 코드 (bk-auth · bk-admin 에 똑같이 복사해 씀)
// · 모든 표 접근은 service role 로만 한다. (bk_ 표는 RLS + 권한 회수로 화면에서 막혀 있음)
// · 열쇠는 코드에 없다. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase 가 자동으로 넣어 준다.
import { createClient } from "npm:@supabase/supabase-js@2";

export const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-client-info, apikey",
  "Access-Control-Max-Age": "86400",
};

export const PBKDF2_ITER = 210000;
export const SESSION_DAYS = 30;
export const LOCK_AFTER_FAILS = 5;
export const LOCK_MINUTES = 15;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

/** 사용자에게 보여 줄 오류 (status + 쉬운 말 메시지) */
export class UserError extends Error {
  constructor(public status: number, message: string, public code = "") {
    super(message);
  }
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function str(body: Record<string, unknown>, key: string, max = 200): string {
  const v = body[key];
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// ── 암호화 ─────────────────────────────────────────────────────────
function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(dk)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterS, saltB, hashB] = stored.split("$");
    if (scheme !== "pbkdf2") return false;
    const dk = new Uint8Array(await pbkdf2(password, unb64(saltB), parseInt(iterS, 10)));
    const expect = unb64(hashB);
    if (dk.length !== expect.length) return false;
    let diff = 0;
    for (let i = 0; i < dk.length; i++) diff |= dk[i] ^ expect[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/** 아이디가 없을 때도 비슷한 시간이 걸리게 해서, 아이디가 있는지 없는지 알아채지 못하게 함 */
export const DUMMY_HASH = "pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function randToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function validPassword(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "비밀번호는 8자 이상이어야 합니다.";
  if (pw.length > 72) return "비밀번호는 72자 이하로 정해 주세요.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "비밀번호에 영문과 숫자를 모두 넣어 주세요.";
  return null;
}

export function tempPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = letters + letters.toUpperCase() + digits;
  const a = crypto.getRandomValues(new Uint8Array(10));
  const chars = Array.from(a, (b) => all[b % all.length]);
  chars[0] = letters[a[0] % letters.length];
  chars[9] = digits[a[9] % digits.length];
  return chars.join("");
}

// ── 회원 · 출입증 ────────────────────────────────────────────────────
export type BkUser = {
  id: string; username: string; password_hash: string; display_name: string;
  status: "pending" | "approved" | "rejected" | "disabled"; is_admin: boolean;
  failed_attempts: number; locked_until: string | null; keep_photo: boolean;
  created_at: string; approved_at: string | null;
};

export function publicUser(u: BkUser) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, status: u.status,
    is_admin: u.is_admin, keep_photo: u.keep_photo, created_at: u.created_at,
  };
}

export async function createSession(userId: string, req: Request): Promise<string> {
  const token = randToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const { error } = await supa.from("bk_sessions").insert({
    token_hash: await sha256hex(token),
    user_id: userId,
    expires_at: expires,
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 200),
  });
  if (error) throw new Error("출입증 저장 실패: " + error.message);
  return token;
}

/** 출입증으로 회원 찾기. 만료·없음이면 null */
export async function sessionUser(token: string): Promise<{ user: BkUser; tokenHash: string } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const tokenHash = await sha256hex(token);
  const { data: sess } = await supa.from("bk_sessions")
    .select("user_id, expires_at, last_used_at").eq("token_hash", tokenHash).maybeSingle();
  if (!sess) return null;
  if (new Date(sess.expires_at) < new Date()) {
    await supa.from("bk_sessions").delete().eq("token_hash", tokenHash);
    return null;
  }
  const { data: user } = await supa.from("bk_users").select("*").eq("id", sess.user_id).maybeSingle();
  if (!user) return null;
  // 마지막 사용 시각은 1시간에 한 번만 적는다 (DB 부담 줄이기)
  if (Date.now() - new Date(sess.last_used_at).getTime() > 3600000) {
    await supa.from("bk_sessions").update({ last_used_at: new Date().toISOString() }).eq("token_hash", tokenHash);
  }
  return { user: user as BkUser, tokenHash };
}

/** 승인된 회원만 통과 */
export async function requireApproved(body: Record<string, unknown>) {
  const su = await sessionUser(str(body, "token", 100));
  if (!su) throw new UserError(401, "다시 로그인해 주세요.", "LOGIN_REQUIRED");
  if (su.user.status !== "approved") {
    throw new UserError(403, "관리자 승인 후에 쓸 수 있어요.", "NOT_APPROVED");
  }
  return su;
}

export function kstToday(): string {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

/** 모든 bk- 함수의 공통 틀: OPTIONS 처리, 경로 나누기, 오류를 쉬운 말로 */
export function serve(fnName: string, routes: Record<string, (req: Request, body: Record<string, unknown>) => Promise<Response>>) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json(405, { error: "POST 요청만 받습니다." });
    const path = new URL(req.url).pathname.replace(new RegExp(`^.*/${fnName}`), "") || "/";
    const handler = routes[path];
    if (!handler) return json(404, { error: "없는 기능입니다: " + path });
    const body = await readBody(req);
    try {
      return await handler(req, body);
    } catch (e) {
      if (e instanceof UserError) return json(e.status, { error: e.message, code: e.code });
      console.error(`[${fnName}${path}]`, e);
      return json(500, { error: "서버에서 문제가 생겼어요. 잠시 뒤 다시 해 주세요." });
    }
  });
}

// ── 책 검색 (카카오) · ISBN ─────────────────────────────────────────
// 열쇠는 Supabase 비밀값 BK_KAKAO_REST_KEY 에만 있다. 화면으로는 절대 내보내지 않는다.
export type BookInfo = {
  isbn13: string | null; title: string; authors: string[]; translators: string[];
  publisher: string | null; published_on: string | null; cover_url: string | null; description: string | null;
};

/** ISBN-13 모양과 끝자리 검산 */
export function validIsbn13(s: string): boolean {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  const d = s.split("").map(Number);
  const sum = d.slice(0, 12).reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalizeKakao(d: Record<string, unknown>): BookInfo {
  const isbn13 = String(d.isbn ?? "").split(/\s+/).find((x) => /^\d{13}$/.test(x)) ?? null;
  const thumb = clean(d.thumbnail, 500);
  const dt = clean(d.datetime, 40);
  return {
    isbn13,
    title: clean(d.title, 200),
    authors: (Array.isArray(d.authors) ? d.authors : []).map((a) => clean(a, 60)).filter(Boolean).slice(0, 10),
    translators: (Array.isArray(d.translators) ? d.translators : []).map((a) => clean(a, 60)).filter(Boolean).slice(0, 10),
    publisher: clean(d.publisher, 100) || null,
    published_on: /^\d{4}-\d{2}-\d{2}/.test(dt) ? dt.slice(0, 10) : null,
    cover_url: thumb ? thumb.replace(/^http:\/\//, "https://") : null,
    description: clean(d.contents, 1000) || null,
  };
}

export async function kakaoSearch(query: string, target: "title" | "isbn" | "", page = 1, size = 20): Promise<{ books: BookInfo[]; is_end: boolean }> {
  const key = Deno.env.get("BK_KAKAO_REST_KEY");
  if (!key) throw new UserError(503, "책 검색 준비가 아직 안 됐어요. 관리자에게 알려 주세요.", "NO_KAKAO_KEY");
  const base = Deno.env.get("BK_KAKAO_BASE") ?? "https://dapi.kakao.com";
  const u = new URL(base + "/v3/search/book");
  u.searchParams.set("query", query);
  if (target) u.searchParams.set("target", target);
  u.searchParams.set("page", String(page));
  u.searchParams.set("size", String(size));
  let r: Response;
  try {
    r = await fetch(u, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error("[kakao] fetch failed", e);
    throw new UserError(502, "책 검색 서버에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.", "KAKAO_DOWN");
  }
  if (r.status === 401 || r.status === 403) {
    console.error("[kakao] auth", r.status, (await r.text()).slice(0, 200));
    throw new UserError(502, "책 검색 열쇠가 맞지 않아요. 관리자에게 알려 주세요.", "KAKAO_AUTH");
  }
  if (!r.ok) {
    console.error("[kakao] status", r.status, (await r.text()).slice(0, 200));
    throw new UserError(502, "책 검색 서버가 응답하지 않아요. 잠시 뒤 다시 해 주세요.", "KAKAO_DOWN");
  }
  const j = await r.json();
  const docs: Record<string, unknown>[] = Array.isArray(j?.documents) ? j.documents : [];
  return {
    books: docs.map(normalizeKakao).filter((b) => b.title),
    is_end: j?.meta?.is_end !== false,
  };
}
