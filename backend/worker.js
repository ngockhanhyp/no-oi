const MAX_BODY_BYTES = 4096;
const MAX_SUBMISSIONS_PER_HOUR = 3;
const MAX_CAMPAIGNS_PER_PAGE = 50;
const CAMPAIGN_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const PRIVATE_DATA_PATTERN = [
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
  /(?:^|\D)(?:\+?84|0)(?:[\s().-]*\d){8,10}(?:\D|$)/,
  /(?:^|\D)(?:\d[\s().-]*){8,}(?:\D|$)/
];

function headersFor(origin, env) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
  });
  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "600");
    headers.set("Vary", "Origin");
  }
  return headers;
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: headersFor(origin, env)
  });
}

function hasPrivateData(value) {
  return PRIVATE_DATA_PATTERN.some((pattern) => pattern.test(value));
}

function validCampaign(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "accountName,accountNumber,alias,amount,bankName,consent,description,title") return false;
  return typeof body.consent === "boolean" &&
    body.consent === true &&
    typeof body.title === "string" &&
    typeof body.description === "string" &&
    typeof body.alias === "string" &&
    typeof body.bankName === "string" &&
    typeof body.accountName === "string" &&
    typeof body.accountNumber === "string" &&
    Number.isSafeInteger(body.amount) &&
    body.amount > 0 &&
    body.amount <= 1_000_000_000;
}

function cleanText(value) {
  return value.trim().replace(/\s+/g, " ");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateCampaign(body) {
  if (!validCampaign(body)) return "Vui lòng kiểm tra các trường bắt buộc và xác nhận đồng ý.";
  const title = cleanText(body.title);
  const description = cleanText(body.description);
  const alias = cleanText(body.alias);
  const bankName = cleanText(body.bankName);
  const accountName = cleanText(body.accountName);
  const accountNumber = cleanText(body.accountNumber);
  if (title.length < 5 || title.length > 80) return "Tiêu đề cần dài từ 5 đến 80 ký tự.";
  if (description.length < 20 || description.length > 500) return "Mô tả cần dài từ 20 đến 500 ký tự.";
  if (alias.length < 2 || alias.length > 40) return "Tên hiển thị cần dài từ 2 đến 40 ký tự.";
  if (bankName.length < 2 || bankName.length > 50) return "Vui lòng kiểm tra tên ngân hàng.";
  if (accountName.length < 2 || accountName.length > 80) return "Vui lòng kiểm tra tên chủ tài khoản.";
  if (!/^[0-9]{6,20}$/.test(accountNumber)) return "Số tài khoản cần có từ 6 đến 20 chữ số.";
  if ([title, description, alias, bankName, accountName].some(hasPrivateData)) {
    return "Không gửi email, số điện thoại hoặc dãy số định danh trong phần mô tả.";
  }
  return null;
}

async function fingerprint(ip, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeSubmission(env, request, now) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.RATE_LIMIT_SECRET) return false;
  const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
  const key = await fingerprint(ip, env.RATE_LIMIT_SECRET);
  await env.DATABASE.prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(windowStart - 86_400_000)
    .run();
  const result = await env.DATABASE.prepare(
    `INSERT INTO rate_limits (fingerprint, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT (fingerprint, window_start)
     DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(key, windowStart).first();
  return result.count <= MAX_SUBMISSIONS_PER_HOUR;
}

function authorized(request, env) {
  const expected = env.ADMIN_API_TOKEN?.trim() || "";
  const provided = request.headers.get("Authorization") || "";
  if (!expected || !provided.startsWith("Bearer ")) return false;
  const token = provided.slice(7).trim();
  let mismatch = token.length ^ expected.length;
  const length = Math.max(token.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (token.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function parseBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { error: "Chỉ chấp nhận nội dung JSON." };
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return { error: "Nội dung gửi lên quá lớn." };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { error: "Nội dung gửi lên quá lớn." };
  }
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: "Nội dung JSON không hợp lệ." };
  }
}

async function handleAdmin(request, env, url, origin) {
  if (!authorized(request, env)) {
    return jsonResponse({ error: "Không được phép." }, 401, origin, env);
  }
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/admin/submissions") {
    const result = await env.DATABASE.prepare(
      `SELECT id, title, description, amount, alias, bank_name, account_name,
              account_number, status, created_at
       FROM campaigns WHERE status = 'pending'
       ORDER BY created_at ASC LIMIT 100`
    ).all();
    return jsonResponse({ submissions: result.results || [] }, 200, origin, env);
  }

  const match = path.match(/^\/api\/admin\/submissions\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if (request.method === "POST" && match && CAMPAIGN_ID_PATTERN.test(match[1])) {
    const status = match[2].toLowerCase() === "approve" ? "approved" : "rejected";
    const result = await env.DATABASE.prepare(
      `UPDATE campaigns SET status = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(status, new Date().toISOString(), match[1]).run();
    if (!result.meta?.changes) {
      return jsonResponse({ error: "Không tìm thấy hồ sơ chờ duyệt." }, 404, origin, env);
    }
    return jsonResponse({ id: match[1], status }, 200, origin, env);
  }

  const deletion = path.match(/^\/api\/admin\/submissions\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && deletion && CAMPAIGN_ID_PATTERN.test(deletion[1])) {
    const result = await env.DATABASE.prepare("DELETE FROM campaigns WHERE id = ?")
      .bind(deletion[1]).run();
    if (!result.meta?.changes) {
      return jsonResponse({ error: "Không tìm thấy hồ sơ." }, 404, origin, env);
    }
    return jsonResponse({ id: deletion[1], deleted: true }, 200, origin, env);
  }
  return jsonResponse({ error: "Không tìm thấy API." }, 404, origin, env);
}

async function handleUserDeletion(request, env, url, origin) {
  const match = url.pathname.match(/^\/api\/submissions\/([0-9a-f-]{36})$/i);
  if (request.method !== "DELETE" || !match || !CAMPAIGN_ID_PATTERN.test(match[1])) {
    return jsonResponse({ error: "Không tìm thấy API." }, 404, origin, env);
  }
  const provided = request.headers.get("Authorization") || "";
  if (!provided.startsWith("Bearer ")) {
    return jsonResponse({ error: "Cần mã xóa hồ sơ." }, 401, origin, env);
  }
  const stored = await env.DATABASE.prepare(
    "SELECT delete_token_hash FROM campaigns WHERE id = ?"
  ).bind(match[1]).first();
  if (!stored || stored.delete_token_hash !== await hashToken(provided.slice(7))) {
    return jsonResponse({ error: "Mã xóa không hợp lệ." }, 403, origin, env);
  }
  await env.DATABASE.prepare("DELETE FROM campaigns WHERE id = ?").bind(match[1]).run();
  return jsonResponse({ id: match[1], deleted: true }, 200, origin, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return jsonResponse({ error: "Origin không được phép." }, 403, null, env);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headersFor(origin, env) });
    }

    try {
      if (!env.DATABASE) return jsonResponse({ error: "Cơ sở dữ liệu chưa được cấu hình." }, 503, origin, env);
      if (url.pathname.startsWith("/api/admin/")) {
        return await handleAdmin(request, env, url, origin);
      }
      if (url.pathname.startsWith("/api/submissions/")) {
        return await handleUserDeletion(request, env, url, origin);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({ status: "ok" }, 200, origin, env);
      }
      if (request.method === "GET" && url.pathname === "/api/campaigns") {
        const result = await env.DATABASE.prepare(
          `SELECT id, title, description, amount, alias, bank_name, account_name,
                  account_number, created_at
           FROM campaigns WHERE status = 'approved'
           ORDER BY created_at DESC LIMIT ?`
        ).bind(MAX_CAMPAIGNS_PER_PAGE).all();
        return jsonResponse({ campaigns: result.results || [] }, 200, origin, env);
      }
      if (request.method === "POST" && url.pathname === "/api/campaigns") {
        if (!env.RATE_LIMIT_SECRET) {
          return jsonResponse({ error: "Dịch vụ chưa sẵn sàng nhận hồ sơ." }, 503, origin, env);
        }
        const parsed = await parseBody(request);
        if (parsed.error) return jsonResponse({ error: parsed.error }, 400, origin, env);
        const validationError = validateCampaign(parsed.body);
        if (validationError) return jsonResponse({ error: validationError }, 400, origin, env);
        if (!await consumeSubmission(env, request, Date.now())) {
          return jsonResponse({ error: "Đã đạt giới hạn gửi hồ sơ. Vui lòng thử lại sau." }, 429, origin, env);
        }

        const campaign = {
          id: crypto.randomUUID(),
          title: cleanText(parsed.body.title),
          description: cleanText(parsed.body.description),
          amount: parsed.body.amount,
          alias: cleanText(parsed.body.alias),
          bank_name: cleanText(parsed.body.bankName),
          account_name: cleanText(parsed.body.accountName),
          account_number: cleanText(parsed.body.accountNumber),
          status: "pending",
          created_at: new Date().toISOString(),
          delete_token: crypto.randomUUID()
        };
        campaign.delete_token_hash = await hashToken(campaign.delete_token);
        await env.DATABASE.prepare(
          `INSERT INTO campaigns
           (id, title, description, amount, alias, bank_name, account_name, account_number,
            status, created_at, delete_token_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          campaign.id,
          campaign.title,
          campaign.description,
          campaign.amount,
          campaign.alias,
          campaign.bank_name,
          campaign.account_name,
          campaign.account_number,
          campaign.status,
          campaign.created_at,
          campaign.delete_token_hash
        ).run();
        return jsonResponse(
          {
            id: campaign.id,
            status: campaign.status,
            deleteToken: campaign.delete_token,
            message: "Hồ sơ đã được gửi để kiểm duyệt."
          },
          201,
          origin,
          env
        );
      }
      return jsonResponse({ error: "Không tìm thấy API." }, 404, origin, env);
    } catch (error) {
      console.error("API request failed:", error);
      return jsonResponse({ error: "Có lỗi khi xử lý yêu cầu. Vui lòng thử lại sau." }, 500, origin, env);
    }
  }
};
