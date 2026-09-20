import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { SignService, HttpError, seedUsers } from "../src/domain.js";
import { stripMetadata, hammingDistance } from "../src/image.js";
import { truncateCoords, publicCoords } from "../src/geo.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "sign-test-"));
  const store = new Store(join(dir, "store.json")).load();
  seedUsers(store);
  const service = new SignService(store, join(dir, "photos"));
  return { store, service };
}

const photo = (dhash = "0000000000000000") => ({
  data_url: `data:image/png;base64,${PNG_1PX}`,
  dhash,
  masks: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
});

const reportInput = (overrides = {}) => ({
  photo: photo(),
  language: "English",
  suggestion: "译名拼写有误",
  norm_clauses: ["GB/T 30240"],
  setting_unit: "市园林中心",
  contact: "13800000000",
  location_authorized: true,
  precision: "street",
  lat: 26.074508,
  lng: 119.296494,
  ...overrides,
});

const user = (store, id) => store.data.users.find((u) => u.id === id);

test("位置精度按授权截断，未授权不保留坐标", () => {
  assert.deepEqual(truncateCoords(26.074508, 119.296494, "street"), {
    lat: 26.075,
    lng: 119.296,
    precision: "street",
  });
  assert.equal(truncateCoords(26.074508, 119.296494, "none"), null);
  // 公众视图最多街道级，即使授权了精确坐标
  assert.deepEqual(
    publicCoords({ authorized: true, precision: "exact", lat: 26.074508, lng: 119.296494 }),
    { lat: 26.075, lng: 119.296, precision: "street" },
  );
  assert.equal(publicCoords({ authorized: false, precision: "none", lat: null, lng: null }), null);
});

test("提交报错：创建标识、首个现场版本与线索，坐标按精度截断", () => {
  const { store, service } = makeService();
  const result = service.submitReport(reportInput());
  assert.ok(result.report_id && result.reporter_token);
  const sign = store.data.signs[0];
  assert.equal(sign.status, "待处理");
  assert.equal(sign.location.lat, 26.075); // street 截断
  assert.equal(sign.location.precision, "street");
  assert.equal(store.data.versions.length, 1);
  assert.equal(store.data.versions[0].source, "市民报错");
  assert.equal(store.data.photos[0].fingerprint.slice(0, 7), "sha256:");
});

test("未授权位置不保存任何坐标", () => {
  const { store, service } = makeService();
  service.submitReport(reportInput({ location_authorized: false, lat: 26.07, lng: 119.29 }));
  const sign = store.data.signs[0];
  assert.equal(sign.location.lat, null);
  assert.equal(sign.location.precision, "none");
});

test("元数据剥离：PNG 附属块与 JPEG EXIF 被移除", () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 8); // 高度
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("GPS\x00秘密坐标")),
    chunk("IDAT", Buffer.from("fake")),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const strippedPng = stripMetadata(png, "image/png");
  assert.ok(!strippedPng.buffer.includes("秘密坐标"));
  assert.deepEqual(strippedPng.removed, ["tEXt"]);

  const seg = (marker, data) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(data.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
  };
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from("Exif\0\0秘密")),
    seg(0xe0, Buffer.from("JFIF\0")),
    seg(0xda, Buffer.from("扫描数据")),
    Buffer.from([0xff, 0xd9]),
  ]);
  const strippedJpeg = stripMetadata(jpeg, "image/jpeg");
  assert.ok(!strippedJpeg.buffer.includes("秘密"));
  assert.ok(strippedJpeg.buffer.includes("JFIF"));
  assert.ok(strippedJpeg.buffer.includes("扫描数据"));
});

test("相似照片与邻近坐标只生成合并候选，不删除任何线索", () => {
  const { store, service } = makeService();
  service.submitReport(reportInput());
  const second = service.submitReport(
    reportInput({ lat: 26.07451, lng: 119.2964, suggestion: "同一牌子另一处错误" }),
  );
  assert.equal(second.merge_candidates, 1);
  assert.equal(store.data.signs.length, 2); // 两条线索都保留
  const candidate = store.data.merge_candidates[0];
  assert.equal(candidate.status, "待裁决");
  assert.ok(candidate.reasons.some((r) => r.includes("照片相似")));
  assert.ok(candidate.reasons.some((r) => r.includes("坐标邻近")));

  // 裁决保留：各自独立，记录仍在
  service.resolveMergeCandidate(user(store, "u_supervisor"), candidate.id, "keep");
  assert.equal(store.data.signs.length, 2);
  assert.equal(store.data.merge_candidates[0].status, "已保留各自独立");
});

test("裁决合并：线索挂到已有标识并形成新现场版本，原记录保留备查", () => {
  const { store, service } = makeService();
  const first = service.submitReport(reportInput());
  service.submitReport(reportInput({ suggestion: "重复报错" }));
  const candidate = store.data.merge_candidates[0];
  service.resolveMergeCandidate(user(store, "u_supervisor"), candidate.id, "merge");
  const target = store.find("signs", first.sign_id);
  assert.equal(store.data.signs.length, 2); // 不删除
  assert.equal(store.data.versions.filter((v) => v.sign_id === target.id).length, 2);
  assert.equal(store.data.reports[1].sign_id, target.id);
  assert.equal(store.data.reports[1].status, "已合并");
});

test("专家审定：语种不匹配与利益冲突被拒绝", () => {
  const { store, service } = makeService();
  const { sign_id } = service.submitReport(reportInput());
  const proposal = service.proposeTranslation(user(store, "u_volunteer"), sign_id, {
    language: "English",
    translation: "Standard Translation",
  });
  // 日语专家：语种不匹配
  assert.throws(
    () => service.reviewProposal(user(store, "u_expert_jp"), proposal.id, { decision: "通过" }),
    (err) => err instanceof HttpError && err.status === 403,
  );
  // 与设置单位存在利益冲突的专家
  assert.throws(
    () =>
      service.reviewProposal(user(store, "u_expert_conflict"), proposal.id, { decision: "通过" }),
    (err) => err instanceof HttpError && err.status === 403,
  );
  // 符合条件的英语专家
  service.reviewProposal(user(store, "u_expert_en"), proposal.id, {
    decision: "通过",
    comment: "符合 GB/T 30240",
  });
  const sign = store.find("signs", sign_id);
  assert.equal(sign.standard_translation, "Standard Translation");
  assert.equal(sign.status, "待整改");
});

test("整改闭环：接受→上传证明（新现场版本）→复查办结；申诉回到专家复核", () => {
  const { store, service } = makeService();
  const { sign_id } = service.submitReport(reportInput());
  const unit = user(store, "u_unit");
  const expert = user(store, "u_expert_en");

  const propose = () =>
    service.proposeTranslation(user(store, "u_volunteer"), sign_id, {
      language: "English",
      translation: "Corrected Name",
    });
  service.reviewProposal(expert, propose().id, { decision: "通过" });

  service.unitRespond(unit, sign_id, { action: "accept" });
  assert.equal(store.find("signs", sign_id).status, "整改中");

  service.unitRespond(unit, sign_id, { action: "proof", note: "已更换", photo: photo("ffffffffffffffff") });
  const sign = store.find("signs", sign_id);
  assert.equal(sign.status, "复查中");
  assert.equal(store.data.versions.filter((v) => v.sign_id === sign_id).length, 2);

  service.closeSign(null, sign_id, {});
  assert.equal(store.find("signs", sign_id).status, "已办结");
  assert.equal(store.data.reports[0].status, "已办结");

  // 申诉路径：另起一单，审定通过后单位申诉，译法回到待审定
  const second = service.submitReport(reportInput({ suggestion: "另一处" }));
  const p2 = service.proposeTranslation(user(store, "u_volunteer"), second.sign_id, {
    language: "English",
    translation: "Name B",
  });
  service.reviewProposal(expert, p2.id, { decision: "通过" });
  service.unitRespond(unit, second.sign_id, { action: "appeal", note: "译名与历史地名冲突" });
  assert.equal(store.find("signs", second.sign_id).status, "申诉复核中");
  assert.equal(store.find("proposals", p2.id).status, "待审定");
});

test("非设置单位不能回应，进度查询需持令牌", () => {
  const { store, service } = makeService();
  const { report_id, reporter_token, sign_id } = service.submitReport(reportInput());
  assert.throws(
    () => service.unitRespond(user(store, "u_expert_en"), sign_id, { action: "accept" }),
    (err) => err.status === 403,
  );
  assert.throws(() => service.reportProgress(report_id, "错误令牌"), (err) => err.status === 404);
  const progress = service.reportProgress(report_id, reporter_token);
  assert.equal(progress.status, "已提交");
  assert.ok(!JSON.stringify(progress).includes("13800000000")); // 联系方式不外泄
});

test("主管部门统计：区域与专家缺口", () => {
  const { store, service } = makeService();
  service.submitReport(reportInput());
  const stats = service.analytics();
  assert.equal(stats.regions.length, 1);
  assert.equal(stats.regions[0].open, 1);
  const english = stats.expert_load.find((e) => e.language === "English");
  assert.ok(english.eligible_experts >= 1);
});

test("dHash 海明距离", () => {
  assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
  assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
  assert.equal(hammingDistance("不是哈希", "0000000000000000"), null);
});
