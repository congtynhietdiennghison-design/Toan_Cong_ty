// Cloudflare Pages Function: /api
// R2.4.11 CF PROXY AUTO RETRY
// Nền: R2.4.10 CF PROXY TAB QUEUE.
// Chỉ vá lớp proxy: nếu Google tạm trả HTML/non-JSON hoặc HTTP hạ tầng tạm thời,
// tự thử lại 1 lần với các action đọc/an toàn. Không đụng logic nghiệp vụ Apps Script.
// Upstream cố định để endpoint này KHÔNG trở thành open proxy.

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw7fHZBn_Bzfma2td2PoP72JhrfasO1h_BYn_mF5o87Vx7Af85DgmCh3Tivaypc-L9yxA/exec";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // đủ cho ảnh minh chứng đã nén/base64
const RETRY_DELAY_MS = 450;

// Chỉ tự retry những action không làm phát sinh thay đổi nghiệp vụ đáng kể.
// login được phép retry vì đây là lỗi người dùng vừa gặp: lần đầu HTML, lần sau vào bình thường.
const SAFE_RETRY_ACTIONS = new Set([
  "getPublicBranding",
  "login",
  "checkSession",
  "getBootstrap",
  "getUsers",
  "getCoreBootstrap",
  "getSystemDiag",
  "getAuditLogs",
  "getSystemHealth",
  "getAnnualLeaveTriggerStatus",
  "getUserPrivilegeData",
  "getCompanyScheduleData",
  "getStartupBundle",
  "getRegistrationGuardBundle",
  "getRefreshBundle",
  "getTabBundle",
  "getAll",
  "getTransfers",
  "getLeaves",
  "getLeaveBalance",
  "getAllLeaveBalances",
  "getLeaveHistory",
  "telegramShiftStatus",
  "telegramLeaveStatus"
]);

// Các thao tác ghi dưới đây đã có clientRequestId + chống lặp ở Code.gs.
// Chỉ cho retry khi request thực sự mang clientRequestId.
const IDEMPOTENT_WRITE_ACTIONS = new Set([
  "add",
  "updateStatus",
  "addDispatchBatch",
  "addTransfer",
  "addTransferBatch",
  "submitLeave",
  "cancelLeave",
  "approveLeaveWeb",
  "rejectLeaveWeb",
  "resetPin"
]);

// HTTP tạm thời. 404 được giữ vì hệ thống thực tế đã ghi nhận 404 chập chờn từ Apps Script.
const RETRYABLE_HTTP = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-ChamCong-Proxy": "cloudflare-pages-r2.4.11",
      ...extraHeaders,
    },
  });
}

function sameOriginBrowserRequest(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // cho phép công cụ kiểm tra/server-side không gửi Origin
  try {
    return origin === new URL(request.url).origin;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

function looksLikeHtml(text, contentType = "") {
  const head = String(text || "").slice(0, 1200).trim().toLowerCase();
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("text/html") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.includes("<head") ||
    head.includes("window['ppconfig']") ||
    head.includes('window["ppconfig"]');
}

function canRetryAction(action, params) {
  if (SAFE_RETRY_ACTIONS.has(action)) return true;
  return IDEMPOTENT_WRITE_ACTIONS.has(action) && !!params.get("clientRequestId");
}

async function callAppsScript(body, attempt) {
  // Tạo request MỚI, không chuyển tiếp Cookie/Authorization của người dùng sang Google.
  // redirect:'follow' để Cloudflare tự theo redirect do Apps Script/ContentService trả về.
  const upstream = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "ChamCongNghiSon-CloudflareProxy/2.4.11",
      "X-ChamCong-Proxy-Attempt": String(attempt),
    },
    body,
    redirect: "follow",
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get("Content-Type") || "";
  const parsed = tryParseJson(text);

  return {
    upstream,
    text,
    contentType,
    validJson: parsed.ok,
    parsedJson: parsed.value,
    htmlLike: looksLikeHtml(text, contentType),
  };
}

function upstreamHost(response) {
  try {
    return response && response.url ? new URL(response.url).hostname : "";
  } catch (_) {
    return "";
  }
}

export function onRequestGet() {
  // Ping nhẹ để xác nhận Pages Function đã được Cloudflare nhận route /api.
  return jsonResponse({
    ok: true,
    proxy: "cloudflare-pages",
    version: "R2.4.11-CF-PROXY-AUTO-RETRY",
    retry: "1 lan cho loi ket noi/HTML tam thoi o action an toan",
    message: "Cloudflare API proxy is ready",
  });
}

export async function onRequestPost(context) {
  const { request } = context;
  const started = Date.now();

  if (!sameOriginBrowserRequest(request)) {
    return jsonResponse({ error: "Origin không hợp lệ." }, 403);
  }

  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return jsonResponse({ error: "Content-Type không được hỗ trợ." }, 415);
  }

  let body;
  try {
    body = await request.text();
  } catch (err) {
    return jsonResponse({ error: "Không đọc được dữ liệu gửi lên proxy." }, 400);
  }

  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Dữ liệu gửi lên quá lớn." }, 413);
  }

  let params;
  try {
    params = new URLSearchParams(body);
  } catch (_) {
    params = new URLSearchParams();
  }

  const action = params.get("action") || request.headers.get("X-Client-Action") || "API";
  const retryAllowed = canRetryAction(action, params);
  let attempt = 1;
  let lastFailure = null;

  while (attempt <= (retryAllowed ? 2 : 1)) {
    try {
      const result = await callAppsScript(body, attempt);
      const status = result.upstream.status;
      const temporaryHttp = RETRYABLE_HTTP.has(status);
      const invalidPayload = !result.validJson;
      const shouldRetry = retryAllowed && attempt === 1 && (temporaryHttp || invalidPayload);

      if (shouldRetry) {
        lastFailure = {
          kind: invalidPayload ? (result.htmlLike ? "html" : "non_json") : "http",
          status,
          host: upstreamHost(result.upstream),
        };
        await sleep(RETRY_DELAY_MS);
        attempt += 1;
        continue;
      }

      const elapsed = Date.now() - started;

      // Apps Script doPost chuẩn luôn trả JSON. Nếu sau lần cuối vẫn là HTML/non-JSON,
      // chuẩn hóa thành JSON ngắn gọn thay vì đẩy cả trang HTML Google ra màn hình đăng nhập.
      if (!result.validJson) {
        return jsonResponse({
          error: retryAllowed && attempt > 1
            ? "Google Apps Script trả về phản hồi không hợp lệ sau khi proxy đã tự thử lại."
            : "Google Apps Script trả về phản hồi không hợp lệ.",
          action,
          responseType: result.htmlLike ? "HTML" : "NON_JSON",
          upstreamStatus: status,
          attempts: attempt,
          proxyMs: elapsed,
        }, 502, {
          "X-ChamCong-Action": String(action).slice(0, 80),
          "X-ChamCong-Upstream-Status": String(status),
          "X-ChamCong-Proxy-Attempts": String(attempt),
          "X-ChamCong-Proxy-Ms": String(elapsed),
        });
      }

      // JSON hợp lệ: trả thẳng cho frontend. Không retry lỗi nghiệp vụ nằm trong JSON.
      return new Response(result.text, {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "X-ChamCong-Proxy": "cloudflare-pages-r2.4.11",
          "X-ChamCong-Action": String(action).slice(0, 80),
          "X-ChamCong-Upstream-Status": String(status),
          "X-ChamCong-Proxy-Attempts": String(attempt),
          "X-ChamCong-Proxy-Ms": String(elapsed),
          ...(lastFailure ? { "X-ChamCong-Retry-Recovered": "1" } : {}),
        },
      });
    } catch (err) {
      const elapsed = Date.now() - started;
      const canTryAgain = retryAllowed && attempt === 1;
      if (canTryAgain) {
        lastFailure = {
          kind: "fetch_error",
          detail: err && err.message ? String(err.message) : String(err || "Unknown fetch error"),
        };
        await sleep(RETRY_DELAY_MS);
        attempt += 1;
        continue;
      }

      return jsonResponse({
        error: retryAllowed && attempt > 1
          ? "Cloudflare không gọi được Apps Script sau khi đã tự thử lại."
          : "Cloudflare không gọi được Apps Script.",
        action,
        detail: err && err.message ? String(err.message) : String(err || "Unknown proxy error"),
        attempts: attempt,
        proxyMs: elapsed,
      }, 502, {
        "X-ChamCong-Action": String(action).slice(0, 80),
        "X-ChamCong-Proxy-Attempts": String(attempt),
        "X-ChamCong-Proxy-Ms": String(elapsed),
      });
    }
  }

  // Không kỳ vọng tới đây, giữ fail-safe dạng JSON.
  return jsonResponse({
    error: "Proxy không hoàn tất được yêu cầu.",
    action,
    attempts: attempt - 1,
    proxyMs: Date.now() - started,
  }, 502);
}
