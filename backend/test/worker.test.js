import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

class MockDatabase {
  campaigns = new Map();
  limits = new Map();

  prepare(query) {
    const database = this;
    let values = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first() {
        if (query.includes("RETURNING count")) {
          const [fingerprint, windowStart] = values;
          const key = `${fingerprint}:${windowStart}`;
          const count = (database.limits.get(key) || 0) + 1;
          database.limits.set(key, count);
          return { count };
        }
        if (query.startsWith("SELECT delete_token_hash")) {
          const [id] = values;
          const campaign = database.campaigns.get(id);
          return campaign ? { delete_token_hash: campaign.delete_token_hash } : null;
        }
        return null;
      },
      async all() {
        if (query.includes("WHERE status = 'pending'")) {
          return { results: [...database.campaigns.values()].filter((row) => row.status === "pending") };
        }
        if (query.includes("WHERE status = 'approved'")) {
          return { results: [...database.campaigns.values()].filter((row) => row.status === "approved") };
        }
        return { results: [] };
      },
      async run() {
        if (query.startsWith("DELETE FROM rate_limits")) return { meta: { changes: 0 } };
        if (query.startsWith("INSERT INTO campaigns")) {
          const [id, title, description, amount, alias, bank_name, account_name, account_number, status, created_at, delete_token_hash] = values;
          database.campaigns.set(id, { id, title, description, amount, alias, bank_name, account_name, account_number, status, created_at, delete_token_hash });
          return { meta: { changes: 1 } };
        }
        if (query.startsWith("SELECT delete_token_hash")) {
          const [id] = values;
          const campaign = database.campaigns.get(id);
          return campaign ? { delete_token_hash: campaign.delete_token_hash } : null;
        }
        if (query.startsWith("UPDATE campaigns")) {
          const [status, reviewed_at, id] = values;
          const campaign = database.campaigns.get(id);
          if (!campaign || campaign.status !== "pending") return { meta: { changes: 0 } };
          Object.assign(campaign, { status, reviewed_at });
          return { meta: { changes: 1 } };
        }
        if (query.startsWith("DELETE FROM campaigns")) {
          const [id] = values;
          return { meta: { changes: database.campaigns.delete(id) ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      }
    };
  }
}

function setup() {
  const env = {
    DATABASE: new MockDatabase(),
    ALLOWED_ORIGIN: "https://ngockhanhyp.github.io",
    ADMIN_API_TOKEN: "test-admin-secret",
    RATE_LIMIT_SECRET: "test-rate-limit-secret"
  };
  const request = (path, method = "GET", data, headers = {}) => new Request(`https://api.example${path}`, {
    method,
    headers: {
      Origin: env.ALLOWED_ORIGIN,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    body: data ? JSON.stringify(data) : undefined
  });
  return { env, request, fetch: (req) => worker.fetch(req, env) };
}

const validSubmission = {
  title: "Giúp trang trải học phí",
  description: "Gia đình gặp khó khăn và cần hỗ trợ học phí kỳ này.",
  amount: 5_000_000,
  alias: "Bạn sinh viên",
  bankName: "Ngân hàng mẫu",
  accountName: "NGUYEN VAN A",
  accountNumber: "123456789012",
  consent: true
};

test("submissions are pending and excluded from public feed until approved", async () => {
  const app = setup();
  const post = app.request("/api/campaigns", "POST", validSubmission, { "CF-Connecting-IP": "203.0.113.8" });
  const created = await app.fetch(post);
  assert.equal(created.status, 201);
  const pending = await created.json();
  assert.equal(pending.status, "pending");
  assert.ok(pending.deleteToken);

  const publicBefore = await app.fetch(app.request("/api/campaigns"));
  assert.deepEqual((await publicBefore.json()).campaigns, []);

  const moderation = app.request(
    `/api/admin/submissions/${pending.id}/approve`,
    "POST",
    undefined,
    { Authorization: "Bearer test-admin-secret" }
  );
  assert.equal((await app.fetch(moderation)).status, 200);
  const publicAfter = await app.fetch(app.request("/api/campaigns"));
  const approved = await publicAfter.json();
  assert.equal(approved.campaigns[0].id, pending.id);
  assert.equal(approved.campaigns[0].account_number, "123456789012");
});

test("submitters can delete their own pending record with the one-time token", async () => {
  const app = setup();
  const created = await app.fetch(app.request(
    "/api/campaigns",
    "POST",
    validSubmission,
    { "CF-Connecting-IP": "203.0.113.11" }
  ));
  const submitted = await created.json();
  const deletion = await app.fetch(app.request(
    `/api/submissions/${submitted.id}`,
    "DELETE",
    undefined,
    { Authorization: `Bearer ${submitted.deleteToken}` }
  ));
  assert.equal(deletion.status, 200);
  assert.equal(app.env.DATABASE.campaigns.size, 0);
});

test("private information is rejected and never stored", async () => {
  const app = setup();
  const response = await app.fetch(app.request("/api/campaigns", "POST", {
    ...validSubmission,
    description: "Liên hệ tôi tại test.person@example.com để trao đổi thêm."
  }, { "CF-Connecting-IP": "203.0.113.9" }));
  assert.equal(response.status, 400);
  assert.equal(app.env.DATABASE.campaigns.size, 0);
});

test("bank-like digit sequences are rejected", async () => {
  const app = setup();
  const response = await app.fetch(app.request("/api/campaigns", "POST", {
    ...validSubmission,
    description: "Gia dinh gap kho khan va tai khoan 1234 5678 9012 dang can ho tro."
  }, { "CF-Connecting-IP": "203.0.113.12" }));
  assert.equal(response.status, 400);
  assert.equal(app.env.DATABASE.campaigns.size, 0);
});

test("the API applies the hourly submission limit", async () => {
  const app = setup();
  const send = () => app.fetch(app.request(
    "/api/campaigns",
    "POST",
    validSubmission,
    { "CF-Connecting-IP": "203.0.113.10" }
  ));
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 429);
});

test("admin moderation requires the secret token", async () => {
  const app = setup();
  const response = await app.fetch(app.request("/api/admin/submissions"));
  assert.equal(response.status, 401);
});

test("requests from an unapproved origin are rejected", async () => {
  const app = setup();
  const response = await app.fetch(app.request("/api/campaigns", "GET", undefined, {
    Origin: "https://attacker.example"
  }));
  assert.equal(response.status, 403);
});
