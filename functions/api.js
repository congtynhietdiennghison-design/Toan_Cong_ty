// Cloudflare Pages Function: /api
// R2.4.13 CF PROXY DIAGNOSTIC — HYBRID FALLBACK
// Nền: R2.4.12 DIAGNOSTIC + R2.4.10 TAB QUEUE.
// Chỉ tăng chẩn đoán lớp Cloudflare -> Google Apps Script:
// - phân biệt TIMEOUT / HTTP / GOOGLE_HTML / NON_JSON / FETCH_ERROR;
// - proxy chỉ gọi upstream 1 lần; frontend R2.4.13 đã dùng Apps Script trực tiếp trước rồi mới fallback /api;
// - không ghi/không trả PIN, token, body request hay nội dung HTML Google;
// - trả traceId + thông tin từng lần thử khi vẫn lỗi sau retry.
// Upstream cố định để endpoint này KHÔNG trở thành open proxy.

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw7fHZBn_Bzfma2td2PoP72JhrfasO1h_BYn_mF5o87Vx7Af85DgmCh3Tivaypc-L9yxA/exec";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RETRY_DELAY_MS = 0; // R2.4.13: không retry bên proxy
// Các API đọc/login thực tế thường dưới 20s theo log vận hành. Cho 38s/lần để
// nếu cần retry vẫn kết thúc trước timeout 90s của frontend.
const RETRYABLE_ATTEMPT_TIMEOUT_MS = 42000;
// Action không retry chỉ có một lượt nên cho dư thời gian hơn.
const SINGLE_ATTEMPT_TIMEOUT_MS = 42000;
const PROXY_VERSION = "R2.4.13-CF-PROXY-DIAGNOSTIC-HYBRID-FALLBACK";

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

// Các thao tác ghi này chỉ được retry khi request có clientRequestId.
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

// 404 được giữ vì hệ thống thực tế đã ghi nhận 404 chập chờn ở đường Apps Script.
const RETRYABLE_HTTP = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

function makeTraceId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
  } catch (_) {}
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 16);
}

function safeShort(value, max = 100) {
  return String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-ChamCong-Proxy": "cloudflare-pages-r2.4.13",
      ...extraHeaders,
    },
  });
}

function sameOriginBrowserRequest(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
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

function upstreamHost(response) {
  try {
    return response && response.url ? new URL(response.url).hostname : "";
  } catch (_) {
    return "";
  }
}

function contentTypeLabel(contentType) {
  return safeShort(String(contentType || "").split(";")[0], 60);
}

function classifyResult(result) {
  const status = Number(result.upstream && result.upstream.status || 0);
  if (result.htmlLike) return "GOOGLE_HTML";
  if (!result.validJson) return "NON_JSON";
  if (status >= 400) return "HTTP_" + status;
  return "OK";
}

function diagRecordFromResult(attempt, result, elapsedMs) {
  return {
    attempt,
    kind: classifyResult(result),
    httpStatus: Number(result.upstream && result.upstream.status || 0),
    host: upstreamHost(result.upstream),
    contentType: contentTypeLabel(result.contentType),
    ms: elapsedMs,
  };
}

function diagRecordFromError(attempt, err, elapsedMs, timeoutMs) {
  const timeout = !!(err && (err._proxyTimeout || err.name === "AbortError"));
  return {
    attempt,
    kind: timeout ? "TIMEOUT" : "FETCH_ERROR",
    httpStatus: 0,
    host: "",
    contentType: "",
    ms: elapsedMs,
    timeoutMs: timeout ? timeoutMs : undefined,
    detail: timeout ? "Upstream timeout" : safeShort(err && err.message ? err.message : err, 120),
  };
}

function humanAttemptDiag(d) {
  if (!d) return "không rõ nguyên nhân";
  if (d.kind === "GOOGLE_HTML") {
    return `Google trả HTML thay vì JSON${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ""}`;
  }
  if (d.kind === "NON_JSON") {
    return `Google trả dữ liệu không phải JSON${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ""}`;
  }
  if (d.kind === "TIMEOUT") {
    return `Apps Script phản hồi quá ${Math.round((d.timeoutMs || 0) / 1000)} giây`;
  }
  if (String(d.kind || "").startsWith("HTTP_")) {
    return `Google/Apps Script trả HTTP ${d.httpStatus || String(d.kind).slice(5)}`;
  }
  if (d.kind === "FETCH_ERROR") {
    return "Cloudflare không kết nối được tới Google Apps Script";
  }
  return d.kind || "không rõ nguyên nhân";
}

function diagnosticSummary(diags) {
  return (diags || []).map(d => `L${d.attempt}: ${humanAttemptDiag(d)}`).join("; ");
}

async function callAppsScript(body, attempt, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch (_) {}
  }, timeoutMs);

  try {
    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "ChamCongNghiSon-CloudflareProxy/2.4.12",
        "X-ChamCong-Proxy-Attempt": String(attempt),
      },
      body,
      redirect: "follow",
      signal: controller.signal,
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
  } catch (err) {
    if (timedOut || (err && err.name === "AbortError")) {
      try { err._proxyTimeout = true; } catch (_) {}
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function failureHeaders(action, traceId, attempts, totalMs, failureKind) {
  return {
    "X-ChamCong-Action": safeShort(action, 80),
    "X-ChamCong-Trace-Id": traceId,
    "X-ChamCong-Proxy-Attempts": String(attempts),
    "X-ChamCong-Proxy-Ms": String(totalMs),
    "X-ChamCong-Proxy-Failure": safeShort(failureKind || "UNKNOWN", 80),
  };
}

export function onRequestGet(context) {
  const request = context && context.request;
  const url = request ? new URL(request.url) : null;
  return jsonResponse({
    ok: true,
    proxy: "cloudflare-pages",
    version: PROXY_VERSION,
    diagnostic: true,
    retry: "khong retry ben proxy; frontend dung Apps Script truc tiep roi fallback /api",
    timeoutPerRetryableAttemptMs: RETRYABLE_ATTEMPT_TIMEOUT_MS,
    message: url && url.searchParams.get("diag") === "1"
      ? "Proxy diagnostic is ready; chi tiet loi duoc tra theo tung request, khong luu PIN/token/body."
      : "Cloudflare API proxy is ready",
  });
}

export async function onRequestPost(context) {
  const { request } = context;
  const started = Date.now();
  const traceId = makeTraceId();

  if (!sameOriginBrowserRequest(request)) {
    return jsonResponse({ error: "Origin không hợp lệ.", traceId }, 403);
  }

  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return jsonResponse({ error: "Content-Type không được hỗ trợ.", traceId }, 415);
  }

  let body;
  try {
    body = await request.text();
  } catch (_) {
    return jsonResponse({ error: "Không đọc được dữ liệu gửi lên proxy.", traceId }, 400);
  }

  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Dữ liệu gửi lên quá lớn.", traceId }, 413);
  }

  let params;
  try {
    params = new URLSearchParams(body);
  } catch (_) {
    params = new URLSearchParams();
  }

  const action = params.get("action") || request.headers.get("X-Client-Action") || "API";
  const retryAllowed = false; // R2.4.13: tránh retry chồng tầng; frontend đã có 2 transport độc lập.
  const maxAttempts = 1;
  const attemptTimeoutMs = SINGLE_ATTEMPT_TIMEOUT_MS;
  const diagnostics = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStarted = Date.now();
    try {
      const result = await callAppsScript(body, attempt, attemptTimeoutMs);
      const status = Number(result.upstream.status || 0);
      const diag = diagRecordFromResult(attempt, result, Date.now() - attemptStarted);
      diagnostics.push(diag);

      const temporaryHttp = RETRYABLE_HTTP.has(status);
      const invalidPayload = !result.validJson;
      const shouldRetry = retryAllowed && attempt < maxAttempts && (temporaryHttp || invalidPayload);

      if (shouldRetry) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const totalMs = Date.now() - started;

      if (!result.validJson) {
        const summary = diagnosticSummary(diagnostics);
        const reason = humanAttemptDiag(diag);
        return jsonResponse({
          error: `Kết nối Cloudflare → Apps Script chưa ổn định: ${reason}. ${maxAttempts > 1 ? `Đã thử ${attempt} lần.` : "Không tự retry action này."} Mã chẩn đoán ${traceId}.`,
          action,
          diagnosticCode: diag.kind,
          traceId,
          attempts: attempt,
          proxyMs: totalMs,
          diagnosticSummary: summary,
          diagnostic: {
            retryAllowed,
            attemptTimeoutMs,
            attempts: diagnostics,
          },
        }, 502, failureHeaders(action, traceId, attempt, totalMs, diag.kind));
      }

      // JSON hợp lệ: trả nguyên văn cho frontend. Không retry lỗi nghiệp vụ trong JSON.
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-ChamCong-Proxy": "cloudflare-pages-r2.4.13",
        "X-ChamCong-Action": safeShort(action, 80),
        "X-ChamCong-Trace-Id": traceId,
        "X-ChamCong-Upstream-Status": String(status),
        "X-ChamCong-Proxy-Attempts": String(attempt),
        "X-ChamCong-Proxy-Ms": String(totalMs),
      };
      if (attempt > 1 && diagnostics.length > 1) {
        headers["X-ChamCong-Retry-Recovered"] = "1";
        headers["X-ChamCong-Retry-First-Failure"] = safeShort(diagnostics[0].kind, 80);
      }
      return new Response(result.text, { status, headers });

    } catch (err) {
      const diag = diagRecordFromError(attempt, err, Date.now() - attemptStarted, attemptTimeoutMs);
      diagnostics.push(diag);

      if (retryAllowed && attempt < maxAttempts) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const totalMs = Date.now() - started;
      const summary = diagnosticSummary(diagnostics);
      const reason = humanAttemptDiag(diag);
      return jsonResponse({
        error: `Kết nối Cloudflare → Apps Script chưa ổn định: ${reason}. ${maxAttempts > 1 ? `Đã thử ${attempt} lần.` : "Không tự retry action này."} Mã chẩn đoán ${traceId}.`,
        action,
        diagnosticCode: diag.kind,
        traceId,
        attempts: attempt,
        proxyMs: totalMs,
        diagnosticSummary: summary,
        diagnostic: {
          retryAllowed,
          attemptTimeoutMs,
          attempts: diagnostics,
        },
      }, 502, failureHeaders(action, traceId, attempt, totalMs, diag.kind));
    }
  }

  const totalMs = Date.now() - started;
  return jsonResponse({
    error: `Proxy không hoàn tất được yêu cầu. Mã chẩn đoán ${traceId}.`,
    action,
    traceId,
    attempts: diagnostics.length,
    proxyMs: totalMs,
    diagnostic: { retryAllowed, attemptTimeoutMs, attempts: diagnostics },
  }, 502, failureHeaders(action, traceId, diagnostics.length, totalMs, "UNKNOWN"));
}
