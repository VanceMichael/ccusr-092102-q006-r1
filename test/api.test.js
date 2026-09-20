import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const T = {
  admin: "demo-admin",
  volunteer: "demo-volunteer",
  expertChen: "demo-expert-chen",
  expertWang: "demo-expert-wang",
  mgrGarden: "demo-manager",
  mgrGov: "demo-manager-gov",
  mgrBlock: "demo-manager-block",
};

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const photo = () => ({ data_url: `data:image/png;base64,${PNG_1x1}`, boxes: [], width: 1, height: 1 });

function submit(base, over = {}) {
  return call(base, "/api/reports", {
    method: "POST",
    body: {
      title: "Test Sign",
      language: "English",
      clause: "GB/T 30240.1-2013",
      suggestion: "建议修改",
      location_precision: "none",
      location_authorized: false,
      photos: [photo()],
      dhashes: ["eeee000011112222"],
      ...over,
    },
  });
}

// ---------------- 基础与上报 ----------------

test("健康检查可用", async () => withServer(async (base) => {
  const r = await call(base, "/health");
  assert.equal(r.status, 200);
}));

test("市民上报：无位置授权时不保存任何坐标", async () => withServer(async (base) => {
  const r = await submit(base, { contact: "13800000000" });
  assert.equal(r.status, 201);
  assert.match(r.data.track_token, /^rtk-/);
  const tr = await call(base, "/api/track", { method: "POST", body: { token: r.data.track_token } });
  assert.equal(tr.status, 200);
  assert.equal(tr.data.my_report.point, null);
  // 本人可看到自己留存的联系方式
  assert.equal(tr.data.my_report.reporter_contact, "13800000000");
}));

test("市民上报：精确授权保存精确点，街区授权只存模糊点", async () => withServer(async (base) => {
  const exact = await submit(base, {
    location_precision: "exact", location_authorized: true, lat: 26.0905, lng: 119.297, contact: null,
  });
  const tr1 = await call(base, "/api/track", { method: "POST", body: { token: exact.data.track_token } });
  assert.deepEqual(tr1.data.my_report.point, { lat: 26.0905, lng: 119.297 });

  const street = await submit(base, {
    title: "Street Level", location_precision: "street", location_authorized: true, lat: 26.0905, lng: 119.297,
    dhashes: ["7777000011112222"],
  });
  const tr2 = await call(base, "/api/track", { method: "POST", body: { token: street.data.track_token } });
  assert.notDeepEqual(tr2.data.my_report.point, { lat: 26.0905, lng: 119.297 });
  assert.ok(Math.abs(tr2.data.my_report.point.lat - 26.0905) < 0.02);
}));

test("查询号错误返回 404", async () => withServer(async (base) => {
  const r = await call(base, "/api/track", { method: "POST", body: { token: "rtk-nope" } });
  assert.equal(r.status, 404);
}));

test("相似图片+邻近坐标只产生合并候选，提交不被阻塞", async () => withServer(async (base) => {
  const a = await submit(base, {
    title: "Same Pool Sign", dhashes: ["eeee000011112222"],
    location_precision: "exact", location_authorized: true, lat: 26.07, lng: 119.31,
  });
  assert.deepEqual(a.data.merge_candidates, []);
  const b = await submit(base, {
    title: "Same Pool Sign", dhashes: ["eeee000011112223"], // 汉明距离 2
    location_precision: "exact", location_authorized: true, lat: 26.07002, lng: 119.31002,
  });
  assert.equal(b.status, 201);
  assert.equal(b.data.merge_candidates.length, 1);
  // 两条线索各自独立存在
  const ga = await call(base, `/api/signs/${a.data.sign_id}`);
  const gb = await call(base, `/api/signs/${b.data.sign_id}`);
  assert.equal(ga.status, 200);
  assert.equal(gb.status, 200);
  assert.notEqual(a.data.sign_id, b.data.sign_id);
}));

// ---------------- 隐私边界 ----------------

test("匿名公众视图：无联系方式、无坐标、无意见明细", async () => withServer(async (base) => {
  const r = await call(base, "/api/signs/sign-seed-001");
  assert.equal(r.status, 200);
  assert.equal("reports" in r.data, false);
  assert.equal("location" in r.data, false);
  assert.ok(!JSON.stringify(r.data).includes("reporter_contact"));
}));

test("照片访问按角色与本人令牌授权", async () => withServer(async (base) => {
  const url = "/api/photos/ph-seed-001";
  assert.equal((await fetch(base + url)).status, 403); // 匿名
  assert.equal((await call(base, url, { token: "tok-seed-rp-002" })).status, 403); // 别的举报人
  assert.equal((await call(base, url, { token: T.mgrBlock })).status, 403); // 外单位
  assert.equal((await call(base, url, { token: T.mgrGarden })).status, 200); // 本单位
  assert.equal((await fetch(`${base}${url}?t=tok-seed-rp-001`)).status, 200); // 本人令牌（img 标签场景）
}));

test("设置单位看不到举报人联系方式，只看到是否已留", async () => withServer(async (base) => {
  const r = await call(base, "/api/manager/queue", { token: T.mgrGarden });
  const s1 = r.data.signs.find((s) => s.id === "sign-seed-001");
  assert.ok(s1);
  assert.ok(!JSON.stringify(s1).includes("reporter_contact"));
  assert.equal(s1.reports[0].contact_provided, true);
  // 外单位标识根本不出现在队列
  assert.equal(r.data.signs.some((s) => s.id === "sign-seed-002"), false);
}));

test("外单位不能查看或处置非本单位标识", async () => withServer(async (base) => {
  assert.equal((await call(base, "/api/signs/sign-seed-001", { token: T.mgrBlock })).status, 403);
  const r = await call(base, "/api/signs/sign-seed-001/respond", {
    token: T.mgrBlock, method: "POST", body: { action: "accept" },
  });
  assert.equal(r.status, 403);
}));

// ---------------- 派发防重与合并不删除 ----------------

test("存在未决合并候选时禁止派发；separate 后两条路牌都保留且可派发", async () => withServer(async (base) => {
  // 造一对新线索
  await submit(base, {
    title: "Pair Sign A", dhashes: ["aaaa0000bbbb1111"],
    location_precision: "exact", location_authorized: true, lat: 26.055, lng: 119.33,
  });
  const b = await submit(base, {
    title: "Pair Sign A", dhashes: ["aaaa0000bbbb1110"],
    location_precision: "exact", location_authorized: true, lat: 26.05502, lng: 119.33002,
  });
  const blocked = await call(base, `/api/signs/${b.data.sign_id}/dispatch`, {
    token: T.admin, method: "POST", body: { owner_org: "鼓楼区园林中心" },
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.details.candidate_ids[0], /^mc-/);

  const mc = blocked.data.details.candidate_ids[0];
  const separate = await call(base, `/api/admin/merge-candidates/${mc}/decision`, {
    token: T.admin, method: "POST", body: { decision: "separate" },
  });
  assert.equal(separate.status, 200);
  const after = await call(base, `/api/signs/${b.data.sign_id}/dispatch`, {
    token: T.admin, method: "POST", body: { owner_org: "鼓楼区园林中心" },
  });
  assert.equal(after.status, 200);
  assert.equal(after.data.status, "open");
  // 判为不同路牌后，两条标识都仍然保留可查
  assert.equal((await call(base, `/api/signs/${b.data.sign_id}`)).status, 200);
}));

test("merge 只做归集标记：源标识与线索均不删除", async () => withServer(async (base) => {
  const r = await call(base, "/api/admin/merge-candidates/mc-seed-001/decision", {
    token: T.admin, method: "POST", body: { decision: "merge" },
  });
  assert.equal(r.status, 200);
  // 源标识仍可查，状态为已合并并指向目标
  const src = await call(base, "/api/signs/sign-seed-007", { token: T.admin });
  assert.equal(src.data.status, "merged");
  assert.equal(src.data.merged_into, "sign-seed-006");
  // 第二条线索的记录归入目标标识
  const target = await call(base, "/api/signs/sign-seed-006", { token: T.admin });
  assert.ok(target.data.reports.some((rp) => rp.id === "rp-seed-007"));
  // 目标候选已决，可正常派发
  const d = await call(base, "/api/signs/sign-seed-006/dispatch", {
    token: T.admin, method: "POST", body: { owner_org: "鼓楼区园林中心" },
  });
  assert.equal(d.status, 200);
}));

// ---------------- 译法 → 审定 → 整改 → 复查发布 ----------------

test("完整办理闭环：派发→志愿译法→专家审定→单位接受→证明→复查通过→向举报人发布规范译法", async () => withServer(async (base) => {
  // 主管部门分派（s1 无未决候选）
  const d = await call(base, "/api/signs/sign-seed-001/dispatch", {
    token: T.admin, method: "POST", body: { owner_org: "鼓楼区园林中心" },
  });
  assert.equal(d.status, 200);

  // 志愿者无权直接审定
  assert.equal((await call(base, "/api/proposals/pp-seed-001/review", {
    token: T.volunteer, method: "POST", body: { verdict: "approved" },
  })).status, 403);

  // 志愿者提交译法
  const p = await call(base, "/api/signs/sign-seed-001/proposals", {
    token: T.volunteer, method: "POST",
    body: { language: "English", text: "West Lake Park (South Gate)", rationale: "Gate 为规范用词" },
  });
  assert.equal(p.status, 201);

  // 陈静远与园林中心无冲突，可以审定
  const rv = await call(base, `/api/proposals/${p.data.id}/review`, {
    token: T.expertChen, method: "POST", body: { verdict: "approved", note: "规范" },
  });
  assert.equal(rv.status, 201);

  // 设置单位接受并上传更换证明
  const acc = await call(base, "/api/signs/sign-seed-001/respond", {
    token: T.mgrGarden, method: "POST", body: { action: "accept" },
  });
  assert.equal(acc.status, 201);
  const proof = await call(base, "/api/signs/sign-seed-001/proof", {
    token: T.mgrGarden, method: "POST", body: { note: "已换牌", photos: [photo()] },
  });
  assert.equal(proof.status, 201);

  // 复查必须拍新现场照片
  const noPhoto = await call(base, "/api/signs/sign-seed-001/recheck", {
    token: T.admin, method: "POST", body: { pass: true, photos: [] },
  });
  assert.equal(noPhoto.status, 400);

  // 复查通过 → 新现场版本 + 规范译法发布
  const ok = await call(base, "/api/signs/sign-seed-001/recheck", {
    token: T.admin, method: "POST",
    body: { pass: true, note: "与规范译法一致", photos: [photo()] },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.sign.status, "rectified");
  assert.equal(ok.data.sign.version_count, 2);
  assert.equal(ok.data.sign.canonical_translation.text, "West Lake Park (South Gate)");

  // 举报人进展中可见最终规范译法
  const tr = await call(base, "/api/track", { method: "POST", body: { token: "tok-seed-rp-001" } });
  assert.equal(tr.data.canonical_translation.text, "West Lake Park (South Gate)");
  assert.ok(tr.data.timeline.some((e) => e.type === "done"));

  // 公众也能看到已发布译法
  const pub = await call(base, "/api/signs/sign-seed-001");
  assert.equal(pub.data.canonical_translation.text, "West Lake Park (South Gate)");
}));

test("利益冲突专家被拒绝审定；复查不通过形成新版本并累计退回", async () => withServer(async (base) => {
  // s4 属市政工程管理处；陈静远须回避
  const p = await call(base, "/api/signs/sign-seed-004/proposals", {
    token: T.volunteer, method: "POST",
    body: { language: "English", text: "Danger! High Voltage（修订）", rationale: "通用警示" },
  });
  assert.equal(p.status, 201);

  const denied = await call(base, `/api/proposals/${p.data.id}/review`, {
    token: T.expertChen, method: "POST", body: { verdict: "approved" },
  });
  assert.equal(denied.status, 403);
  assert.ok(denied.data.details.join("；").includes("利益冲突"));

  const allowed = await call(base, `/api/proposals/${p.data.id}/review`, {
    token: T.expertWang, method: "POST", body: { verdict: "approved" },
  });
  assert.equal(allowed.status, 201);

  // 单位上传更换证明，复查不通过 → 第 3 版现场记录，退回次数 +1
  await call(base, "/api/signs/sign-seed-004/proof", {
    token: T.mgrGov, method: "POST", body: { note: "已换", photos: [photo()] },
  });
  const fail = await call(base, "/api/signs/sign-seed-004/recheck", {
    token: T.admin, method: "POST",
    body: { pass: false, note: "仍是中式英语", photos: [photo()] },
  });
  assert.equal(fail.status, 201);
  assert.equal(fail.data.sign.status, "reopened");
  assert.equal(fail.data.sign.version_count, 3);
  assert.equal(fail.data.sign.reopen_count, 2);
}));

test("单位申诉与主管裁决流程", async () => withServer(async (base) => {
  // s2 有待审定日语译法：王雅文（懂日语）审定通过
  const rv = await call(base, "/api/proposals/pp-seed-001/review", {
    token: T.expertWang, method: "POST", body: { verdict: "approved", note: "通过" },
  });
  assert.equal(rv.status, 201);
  const appeal = await call(base, "/api/signs/sign-seed-002/respond", {
    token: T.mgrBlock, method: "POST", body: { action: "appeal", note: "街区改造暂缓" },
  });
  assert.equal(appeal.status, 201);
  // 非主管部门不能裁决
  assert.equal((await call(base, "/api/signs/sign-seed-002/appeal-decision", {
    token: T.mgrBlock, method: "POST", body: { uphold: false },
  })).status, 403);
  const decide = await call(base, "/api/signs/sign-seed-002/appeal-decision", {
    token: T.admin, method: "POST", body: { uphold: false },
  });
  assert.equal(decide.status, 200);
  assert.equal(decide.data.status, "expert_approved");
}));

// ---------------- 监管分析 ----------------

test("主管分析：长期未整改/反复出错/专家不足；且仅主管可访问", async () => withServer(async (base) => {
  assert.equal((await call(base, "/api/admin/analytics", { token: T.expertWang })).status, 403);
  const r = await call(base, "/api/admin/analytics", { token: T.admin });
  assert.equal(r.status, 200);
  // s4 自 7 月挂起至今且被反复退回
  assert.ok(r.data.long_standing.some((x) => x.sign_id === "sign-seed-004"));
  assert.ok(r.data.repeat_errors_by_org.some((x) => x.org === "福州市市政工程管理处"));
  // 韩语线索在台江区无合格专家
  assert.ok(r.data.expert_shortage.some((x) => x.language === "Korean" && x.district === "台江区"));
  // 分析结果不含联系方式等个人字段
  assert.ok(!JSON.stringify(r.data).includes("reporter_contact"));
}));
