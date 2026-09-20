import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "../src/server.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let base;
let server;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sign-api-"));
  server = createServer(dir);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw };
}

const reportBody = (overrides = {}) => ({
  photo: {
    data_url: `data:image/png;base64,${PNG_1PX}`,
    dhash: "0123456789abcdef",
    masks: [{ x: 0, y: 0, w: 0.2, h: 0.2 }],
  },
  language: "English",
  suggestion: "出口译名拼写错误",
  norm_clauses: ["GB/T 30240"],
  setting_unit: "市园林中心",
  contact: "secret-contact-123",
  location_authorized: true,
  precision: "street",
  lat: 26.074508,
  lng: 119.296494,
  ...overrides,
});

test("完整闭环：报错→译法→审定→整改→复查，公众只见公开字段", async () => {
  // 市民提交
  const submitted = await call("/api/reports", { method: "POST", body: reportBody() });
  assert.equal(submitted.status, 200);
  const { report_id, reporter_token, sign_id } = submitted.body;
  assert.ok(reporter_token);

  // 公开列表不含联系方式与令牌
  const publicList = await call("/api/signs/public");
  assert.equal(publicList.status, 200);
  assert.ok(!publicList.raw.includes("secret-contact-123"));
  assert.ok(!publicList.raw.includes(reporter_token));

  // 公开详情位置被限制在街道级
  const detail = await call(`/api/signs/${sign_id}/public`);
  assert.deepEqual(detail.body.location, { lat: 26.075, lng: 119.296, precision: "street" });

  // 未授权接口
  assert.equal((await call("/api/analytics")).status, 401);
  assert.equal((await call("/api/queue/expert", { token: "volunteer-demo" })).status, 403);

  // 志愿者提交译法
  const proposal = await call(`/api/signs/${sign_id}/proposals`, {
    method: "POST",
    token: "volunteer-demo",
    body: { language: "English", translation: "Exit", note: "按规范译写" },
  });
  assert.equal(proposal.status, 200);

  // 利益冲突专家被拒之门外
  const conflict = await call(`/api/proposals/${proposal.body.id}/review`, {
    method: "POST",
    token: "expert-conflict-demo",
    body: { decision: "通过" },
  });
  assert.equal(conflict.status, 403);

  // 合格专家审定通过
  const review = await call(`/api/proposals/${proposal.body.id}/review`, {
    method: "POST",
    token: "expert-en-demo",
    body: { decision: "通过", comment: "符合规范" },
  });
  assert.equal(review.status, 200);

  // 单位接受并上传更换证明（形成新现场版本）
  await call(`/api/signs/${sign_id}/respond`, {
    method: "POST",
    token: "unit-demo",
    body: { action: "accept" },
  });
  const proof = await call(`/api/signs/${sign_id}/respond`, {
    method: "POST",
    token: "unit-demo",
    body: {
      action: "proof",
      note: "已更换新版面",
      photo: {
        data_url: `data:image/png;base64,${PNG_1PX}`,
        dhash: "fedcba9876543210",
        masks: [],
        no_mask_confirmed: true,
      },
    },
  });
  assert.equal(proof.status, 200);

  // 主管复查办结
  const closed = await call(`/api/signs/${sign_id}/close`, {
    method: "POST",
    token: "supervisor-demo",
    body: {},
  });
  assert.equal(closed.body.status, "已办结");

  // 举报人凭令牌看到进展与最终规范译法，且不含联系方式
  const progress = await call(`/api/reports/${report_id}/progress?token=${reporter_token}`);
  assert.equal(progress.body.status, "已办结");
  assert.equal(progress.body.sign.standard_translation, "Exit");
  assert.equal(progress.body.sign.site_versions, 2);
  assert.ok(!progress.raw.includes("secret-contact-123"));

  // 统计接口对主管开放
  const stats = await call("/api/analytics", { token: "supervisor-demo" });
  assert.equal(stats.status, 200);
  assert.ok(Array.isArray(stats.body.regions));
});

test("合并候选须经主管裁决，公众接口不暴露内部信息", async () => {
  await call("/api/reports", { method: "POST", body: reportBody({ suggestion: "第一报" }) });
  await call("/api/reports", { method: "POST", body: reportBody({ suggestion: "疑似重复" }) });
  const candidates = await call("/api/merge-candidates", { token: "supervisor-demo" });
  const pending = candidates.body.filter((c) => c.status === "待裁决");
  assert.ok(pending.length >= 1);
  const resolved = await call(`/api/merge-candidates/${pending[0].id}/resolve`, {
    method: "POST",
    token: "supervisor-demo",
    body: { action: "keep" },
  });
  assert.equal(resolved.body.status, "已保留各自独立");
  // 两条线索仍然都在
  const list = await call("/api/signs/public");
  assert.ok(list.body.length >= 2);
});

test("静态页面与健康检查", async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /外语标识纠错平台/);
  const health = await call("/health");
  assert.equal(health.body.状态, "服务已启动");
});
