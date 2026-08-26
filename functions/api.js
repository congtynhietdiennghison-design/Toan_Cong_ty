// Cloudflare Pages Function: /api
// R2.4.10 CF PROXY TAB QUEUE
// Mục tiêu: browser chỉ gọi cùng domain Cloudflare; Function gọi Apps Script server-side.
// Upstream cố định để endpoint này KHÔNG trở thành open proxy.

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw7fHZBn_Bzfma2td2PoP72JhrfasO1h_BYn_mF5o87Vx7Af85DgmCh3Tivaypc-L9yxA/exec";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // đủ cho ảnh minh chứng đã nén/base64

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-ChamCong-Proxy": "cloudflare-pages-r2.4.10",
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

export function onRequestGet() {
  // Ping nhẹ để xác nhận Pages Function đã được Cloudflare nhận route /api.
  return jsonResponse({
    ok: true,
    proxy: "cloudflare-pages",
    version: "R2.4.10-CF-PROXY-TAB-QUEUE",
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

  let action = request.headers.get("X-Client-Action") || "API";
  try {
    const parsed = new URLSearchParams(body);
    action = parsed.get("action") || action;
  } catch (_) {}

  try {
    // Tạo request MỚI, không chuyển tiếp Cookie/Authorization của người dùng sang Google.
    // redirect:'follow' để Cloudflare tự theo redirect do Apps Script/ContentService trả về.
    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "ChamCongNghiSon-CloudflareProxy/2.4.10",
      },
      body,
      redirect: "follow",
    });

    const text = await upstream.text();
    const elapsed = Date.now() - started;

    // Không cache dữ liệu nghiệp vụ/phiên. Trả nguyên status upstream để frontend chẩn đoán đúng.
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-ChamCong-Proxy": "cloudflare-pages-r2.4.10",
        "X-ChamCong-Action": String(action).slice(0, 80),
        "X-ChamCong-Upstream-Status": String(upstream.status),
        "X-ChamCong-Proxy-Ms": String(elapsed),
      },
    });
  } catch (err) {
    const elapsed = Date.now() - started;
    return jsonResponse({
      error: "Cloudflare không gọi được Apps Script.",
      action,
      detail: err && err.message ? String(err.message) : String(err || "Unknown proxy error"),
      proxyMs: elapsed,
    }, 502, {
      "X-ChamCong-Action": String(action).slice(0, 80),
      "X-ChamCong-Proxy-Ms": String(elapsed),
    });
  }
}
