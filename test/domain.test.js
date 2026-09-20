import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceMeters,
  evaluateDuplicate,
  expertEligibility,
  fuzzCoordinate,
  hamming64,
} from "../src/domain.js";

test("hamming64 计算图片指纹差异", () => {
  assert.equal(hamming64("0000000000000000", "0000000000000000"), 0);
  assert.equal(hamming64("0000000000000000", "0000000000000001"), 1);
  assert.equal(hamming64("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hamming64("", "ffffffffffffffff"), 64);
});

test("距离计算：福州市内两点约 7 米", () => {
  const d = distanceMeters({ lat: 26.0905, lng: 119.297 }, { lat: 26.09055, lng: 119.29706 });
  assert.ok(d > 4 && d < 12, `实际 ${d}m`);
});

test("位置只按授权精度模糊：none 不产生坐标", () => {
  assert.equal(fuzzCoordinate(26.09, 119.29, "none"), null);
  const approx = fuzzCoordinate(26.09123, 119.29123, "approx");
  const street = fuzzCoordinate(26.09123, 119.29123, "street");
  // 同网格内两点被吸附到同一模糊点
  assert.deepEqual(fuzzCoordinate(26.0911, 119.2911, "approx"), approx);
  assert.notDeepEqual(approx, street);
});

function mkReport(over = {}) {
  return {
    title: "Beware of the pool",
    dhashes: ["abcdabcdabcdabcd"],
    location_precision: "exact",
    location_authorized: true,
    exact_point: { lat: 26.0905, lng: 119.297 },
    fuzzed_point: { lat: 26.0905, lng: 119.297 },
    public_point: { lat: 26.09, lng: 119.297 },
    ...over,
  };
}

test("合并候选：图片视觉近似即提出候选", () => {
  const r = evaluateDuplicate({
    candidate: mkReport({ dhashes: ["abcdabbdabcdabcd"] }),
    existing: mkReport(),
  });
  assert.equal(r.hit, true);
  assert.ok(r.reasons.some((x) => x.includes("图片视觉近似")));
  assert.ok(r.image_distance <= 8);
});

test("合并候选：仅坐标邻近但文字与图片都不同 → 不是候选（保护相邻的不同路牌）", () => {
  const r = evaluateDuplicate({
    candidate: mkReport({ title: "Completely Different Sign", dhashes: ["0000000000000000"] }),
    existing: mkReport({ exact_point: { lat: 26.09052, lng: 119.29702 } }),
  });
  assert.equal(r.hit, false);
});

test("合并候选：邻近 + 同文，即使图片差异较大也提出候选", () => {
  const r = evaluateDuplicate({
    candidate: mkReport({ dhashes: ["0000000000000000"] }),
    existing: mkReport({ exact_point: { lat: 26.09051, lng: 119.29701 } }),
  });
  assert.equal(r.hit, true);
  assert.ok(r.reasons.some((x) => x.includes("坐标邻近")));
});

test("合并候选：任一方未授权位置时不做坐标比对", () => {
  const r = evaluateDuplicate({
    candidate: mkReport({ location_authorized: false, location_precision: "none", exact_point: null, fuzzed_point: null, public_point: null, dhashes: ["0000000000000000"] }),
    existing: mkReport(),
  });
  assert.equal(r.hit, false);
  assert.equal(r.proximity, null);
});

test("专家资格：语种不匹配 / 利益冲突 / 合格", () => {
  const expert = { role: "expert", languages: ["English"], conflict_orgs: ["市政处"] };
  assert.equal(expertEligibility(expert, { language_needs: ["Japanese"], owner_org: "园林中心" }).eligible, false);
  assert.equal(expertEligibility(expert, { language_needs: ["English"], owner_org: "市政处" }).eligible, false);
  assert.equal(expertEligibility(expert, { language_needs: ["English"], owner_org: "园林中心" }).eligible, true);
  // 审定按“译法语种”逐一授权：英语专家可审定多语标识上的英语译法，
  // 但无权审定其日/韩语译法（审定接口会把范围收窄到当前提案语种）。
  assert.equal(expertEligibility(expert, { language_needs: ["Japanese", "English"], owner_org: "园林中心" }).eligible, true);
  assert.equal(expertEligibility(expert, { language_needs: ["Japanese"], owner_org: "园林中心" }).matchedLanguages.length, 0);
});
