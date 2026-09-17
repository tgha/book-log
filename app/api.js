// 서버(bk- 엣지함수)와 주고받는 곳. 출입증은 이 기기에만 저장합니다.
import { API_BASE } from "./config.js";

const TOKEN_KEY = "bk_token";

export class ApiError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const session = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  },
  set token(v) {
    try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* 저장 불가 */ }
  },
  clear() { this.token = ""; },
};

export async function call(fn, path, body = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/${fn}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, token: session.token }),
    });
  } catch {
    throw new ApiError(0, "인터넷 연결을 확인한 뒤 다시 해 주세요.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data.error || "요청을 처리하지 못했어요. 다시 해 주세요.", data.code || "");
    if (err.code === "LOGIN_REQUIRED" || err.code === "BLOCKED") {
      session.clear();
      window.dispatchEvent(new CustomEvent("bk:signed-out", { detail: err.message }));
    }
    throw err;
  }
  return data;
}

export const api = {
  signup: (username, password, display_name) => call("bk-auth", "/signup", { username, password, display_name }),
  login: (username, password) => call("bk-auth", "/login", { username, password }),
  me: () => call("bk-auth", "/me"),
  logout: () => call("bk-auth", "/logout"),
  changePassword: (current_password, new_password) => call("bk-auth", "/password", { current_password, new_password }),
  rename: (display_name) => call("bk-auth", "/profile", { display_name }),
  admin: {
    users: () => call("bk-admin", "/users"),
    approve: (user_id) => call("bk-admin", "/approve", { user_id }),
    reject: (user_id) => call("bk-admin", "/reject", { user_id }),
    disable: (user_id) => call("bk-admin", "/disable", { user_id }),
    enable: (user_id) => call("bk-admin", "/enable", { user_id }),
    resetPassword: (user_id) => call("bk-admin", "/reset-password", { user_id }),
    settings: () => call("bk-admin", "/settings"),
    setSetting: (key, value) => call("bk-admin", "/settings/set", { key, value }),
  },
};
