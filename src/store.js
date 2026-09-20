// 内存存储 + 演示种子数据。真实部署可替换为数据库，领域规则不变。
import { fuzzCoordinate, nowIso } from "./domain.js";

let counter = 0;
export function newId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function seedId(prefix, n) {
  return `${prefix}-seed-${String(n).padStart(3, "0")}`;
}

// 1×1 透明占位图（演示用；真实图片由手机端上传，且仅存遮蔽后的版本）
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export function createStore() {
  const db = {
    users: new Map(),
    signs: new Map(),
    reports: new Map(),
    photos: new Map(),
    siteVersions: new Map(),
    proposals: new Map(),
    reviews: new Map(),
    receipts: new Map(),
    mergeCandidates: new Map(),
    sessions: new Map(),
  };

  // ---------- 用户 ----------
  const users = [
    { id: "u-vol-lin", name: "林一舟", role: "volunteer", org: "福州大学外语志愿队", languages: ["English", "Japanese"], contact: "lin@example.edu.cn" },
    { id: "u-exp-chen", name: "陈静远", role: "expert", org: "高校外国语学院", languages: ["English"], conflict_orgs: ["福州市市政工程管理处"], contact: "chen@example.edu.cn" },
    { id: "u-exp-wang", name: "王雅文", role: "expert", org: "翻译协会", languages: ["English", "Japanese"], conflict_orgs: [], contact: "wang@example.edu.cn" },
    { id: "u-mgr-zhang", name: "张敏", role: "manager", org: "鼓楼区园林中心", languages: [], conflict_orgs: [], contact: null },
    { id: "u-mgr-he", name: "何建设", role: "manager", org: "福州市市政工程管理处", languages: [], conflict_orgs: [], contact: null },
    { id: "u-mgr-xu", name: "徐丽", role: "manager", org: "三坊七巷历史街区管委会", languages: [], conflict_orgs: [], contact: null },
    { id: "u-admin-li", name: "李外事", role: "admin", org: "福州市外事办公室", languages: [], conflict_orgs: [], contact: null },
  ];
  for (const u of users) db.users.set(u.id, u);

  // 演示会话令牌（固定，便于手机页面直接切换角色）
  db.sessions.set("demo-admin", "u-admin-li");
  db.sessions.set("demo-expert-chen", "u-exp-chen");
  db.sessions.set("demo-expert-wang", "u-exp-wang");
  db.sessions.set("demo-volunteer", "u-vol-lin");
  db.sessions.set("demo-manager", "u-mgr-zhang");
  db.sessions.set("demo-manager-gov", "u-mgr-he");
  db.sessions.set("demo-manager-block", "u-mgr-xu");

  const photo = (n, opts = {}) => {
    const id = seedId("ph", n);
    db.photos.set(id, {
      id,
      content_type: "image/png",
      data: PNG_1x1,
      redacted: opts.redacted ?? true,
      redaction_boxes: opts.boxes ?? [],
      fingerprint: `sha256:seed${String(n).padStart(3, "0")}`,
      width: 2,
      height: 2,
      created_at: opts.at ?? "2026-08-10T09:00:00+08:00",
    });
    return id;
  };

  const addVersion = (n, sign, seq, label, photoIds, observedAt, note = "") => {
    const id = seedId("sv", n);
    db.siteVersions.set(id, {
      id, sign_id: sign.id, seq, label, note,
      photo_ids: photoIds,
      observed_text: sign.title,
      observed_at: observedAt,
      created_at: observedAt,
    });
    sign.site_version_ids.push(id);
    return id;
  };

  // ---------- 标识 1：长期未整改（35 天以上） ----------
  const s1 = {
    id: seedId("sign", 1),
    title: "West Lake Park South Door",
    correct_title_hint: "West Lake Park (South Gate)",
    district: "鼓楼区", road: "湖滨路",
    owner_org: "鼓楼区园林中心",
    language_needs: ["English"],
    status: "open",
    created_at: "2026-08-10T09:00:00+08:00",
    updated_at: "2026-08-10T09:00:00+08:00",
    first_report_at: "2026-08-10T09:00:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 0, canonical_translation: null,
    best_location: null,
  };
  db.signs.set(s1.id, s1);
  const p1 = photo(1, { boxes: [{ kind: "face", x: 10, y: 10, w: 20, h: 20 }], at: "2026-08-10T09:00:00+08:00" });
  addVersion(1, s1, 1, "初次上报现场", [p1], "2026-08-10T09:00:00+08:00", "南门指示牌将 Gate 误写为 Door");
  const exact1 = { lat: 26.08670, lng: 119.28950 };
  db.reports.set(seedId("rp", 1), {
    id: seedId("rp", 1), sign_id: s1.id, link_confirmed: true,
    title: s1.title, language: "English",
    clause: "GB/T 30240.1-2013 公共服务领域英文译写规范 交通类",
    suggestion: "South Door 应为 South Gate",
    location_precision: "exact", location_authorized: true,
    exact_point: exact1, fuzzed_point: fuzzCoordinate(exact1.lat, exact1.lng, "approx"), public_point: fuzzCoordinate(exact1.lat, exact1.lng, "street"),
    dhashes: ["0123012301230123"], photo_ids: [p1],
    reporter_contact: "138****0001",
    reporter_token: "tok-seed-rp-001",
    created_at: "2026-08-10T09:00:00+08:00",
  });
  s1.best_location = { authorized_exact: true, exact: exact1, fuzzed: fuzzCoordinate(exact1.lat, exact1.lng, "approx") };

  // ---------- 标识 2：日英双语，待专家审定 ----------
  const s2 = {
    id: seedId("sign", 2),
    title: "Three Lanes and Seven Alleys（日文假名有误）",
    correct_title_hint: "三坊七巷",
    district: "鼓楼区", road: "南后街",
    owner_org: "三坊七巷历史街区管委会",
    language_needs: ["Japanese", "English"],
    status: "awaiting_expert",
    created_at: "2026-09-01T10:00:00+08:00",
    updated_at: "2026-09-12T15:00:00+08:00",
    first_report_at: "2026-09-01T10:00:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 0, canonical_translation: null,
    best_location: null,
  };
  db.signs.set(s2.id, s2);
  const p2 = photo(2, { at: "2026-09-01T10:00:00+08:00" });
  addVersion(2, s2, 1, "初次上报现场", [p2], "2026-09-01T10:00:00+08:00", "日文假名标注错误");
  const exact2 = { lat: 26.08300, lng: 119.29300 };
  db.reports.set(seedId("rp", 2), {
    id: seedId("rp", 2), sign_id: s2.id, link_confirmed: true,
    title: s2.title, language: "Japanese",
    clause: "公共服务领域日文译写规范",
    suggestion: "请核正假名拼写",
    location_precision: "approx", location_authorized: true,
    exact_point: exact2, fuzzed_point: fuzzCoordinate(exact2.lat, exact2.lng, "approx"), public_point: fuzzCoordinate(exact2.lat, exact2.lng, "street"),
    dhashes: ["aaaa5555aaaa5555"], photo_ids: [p2],
    reporter_contact: null,
    reporter_token: "tok-seed-rp-002",
    created_at: "2026-09-01T10:00:00+08:00",
  });
  s2.best_location = { authorized_exact: false, exact: exact2, fuzzed: fuzzCoordinate(exact2.lat, exact2.lng, "approx") };
  const prop1 = {
    id: seedId("pp", 1), sign_id: s2.id, volunteer_id: "u-vol-lin",
    language: "Japanese", text: "三坊七巷（さんぼうななちょう）",
    rationale: "按通行日文译写并标注假名", created_at: "2026-09-12T15:00:00+08:00",
  };
  db.proposals.set(prop1.id, prop1);
  s2.proposal_ids.push(prop1.id);

  // ---------- 标识 3：韩语线索，专家资源不足 ----------
  const s3 = {
    id: seedId("sign", 3),
    title: "Korean Street Plaza 안내 오류",
    district: "台江区", road: "八一七中路",
    owner_org: "中亭街商圈管委会",
    language_needs: ["Korean"],
    status: "awaiting_expert",
    created_at: "2026-09-10T11:00:00+08:00",
    updated_at: "2026-09-10T11:00:00+08:00",
    first_report_at: "2026-09-10T11:00:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 0, canonical_translation: null,
    best_location: null,
  };
  db.signs.set(s3.id, s3);
  const p3 = photo(3, { at: "2026-09-10T11:00:00+08:00" });
  addVersion(3, s3, 1, "初次上报现场", [p3], "2026-09-10T11:00:00+08:00");
  const exact3 = { lat: 26.06100, lng: 119.30300 };
  db.reports.set(seedId("rp", 3), {
    id: seedId("rp", 3), sign_id: s3.id, link_confirmed: true,
    title: s3.title, language: "Korean",
    clause: "公共服务领域韩文译写规范",
    suggestion: "안내문 문법 오류",
    location_precision: "street", location_authorized: true,
    exact_point: exact3, fuzzed_point: fuzzCoordinate(exact3.lat, exact3.lng, "street"), public_point: fuzzCoordinate(exact3.lat, exact3.lng, "street"),
    dhashes: ["cccc3333cccc3333"], photo_ids: [p3],
    reporter_contact: null, reporter_token: "tok-seed-rp-003",
    created_at: "2026-09-10T11:00:00+08:00",
  });
  s3.best_location = { authorized_exact: false, exact: exact3, fuzzed: fuzzCoordinate(exact3.lat, exact3.lng, "street") };

  // ---------- 标识 4：复查不通过被重新办理（反复出错） ----------
  const s4 = {
    id: seedId("sign", 4),
    title: "Careful Electric Shock",
    correct_title_hint: "Danger! High Voltage",
    district: "鼓楼区", road: "五四路",
    owner_org: "福州市市政工程管理处",
    language_needs: ["English"],
    status: "reopened",
    created_at: "2026-07-20T08:00:00+08:00",
    updated_at: "2026-09-05T16:00:00+08:00",
    first_report_at: "2026-07-20T08:00:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 1, canonical_translation: null,
    best_location: null,
  };
  db.signs.set(s4.id, s4);
  const p4a = photo(4, { at: "2026-07-20T08:00:00+08:00" });
  const p4b = photo(5, { at: "2026-08-25T10:00:00+08:00" });
  addVersion(4, s4, 1, "初次上报现场", [p4a], "2026-07-20T08:00:00+08:00");
  addVersion(5, s4, 2, "第一次整改后复查（不通过）", [p4b], "2026-08-25T10:00:00+08:00", "换牌后仍为中式英语");
  const prop2 = {
    language: "English", text: "Danger! High Voltage",
    rationale: "电气警示通用规范表达", created_at: "2026-08-02T09:00:00+08:00",
  };
  db.proposals.set(prop2.id, prop2);
  s4.proposal_ids.push(prop2.id);
  const rv2 = {
    id: seedId("rv", 1), sign_id: s4.id, proposal_id: prop2.id, expert_id: "u-exp-wang",
    verdict: "approved", note: "译法规范，建议采用", created_at: "2026-08-05T09:00:00+08:00",
  };
  db.reviews.set(rv2.id, rv2);
  s4.review_ids.push(rv2.id);
  const rc1 = {
    id: seedId("rc", 1), sign_id: s4.id, org: s4.owner_org,
    action: "replace_proof", note: "已更换", photo_ids: [p4b], created_at: "2026-08-24T17:00:00+08:00",
  };
  db.receipts.set(rc1.id, rc1);
  s4.receipt_ids.push(rc1.id);
  db.reports.set(seedId("rp", 4), {
    id: seedId("rp", 4), sign_id: s4.id, link_confirmed: true,
    title: s4.title, language: "English",
    clause: "GB/T 30240.1-2013 安全警示类",
    suggestion: "应使用 Danger! High Voltage",
    location_precision: "none", location_authorized: false,
    exact_point: null, fuzzed_point: null, public_point: null,
    dhashes: ["f0f0f0f0f0f0f0f0"], photo_ids: [p4a],
    reporter_contact: null, reporter_token: "tok-seed-rp-004",
    created_at: "2026-07-20T08:00:00+08:00",
  });
  // 该举报人选择“不保留位置”：标识层同样不保留任何坐标（只按授权保留精度）。
  s4.best_location = null;

  // ---------- 标识 5：已整改规范（含面向公众发布的规范译法） ----------
  const s5 = {
    id: seedId("sign", 5),
    title: "Fu Zhou Railway Station",
    district: "晋安区", road: "华林路",
    owner_org: "福州市市政工程管理处",
    language_needs: ["English"],
    status: "rectified",
    created_at: "2026-06-01T08:00:00+08:00",
    updated_at: "2026-07-02T10:00:00+08:00",
    first_report_at: "2026-06-01T08:00:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 0,
    canonical_translation: { text: "Fuzhou Railway Station", language: "English", review_id: seedId("rv", 2) },
    best_location: null,
  };
  db.signs.set(s5.id, s5);
  const p5a = photo(6, { at: "2026-06-01T08:00:00+08:00" });
  const p5b = photo(7, { boxes: [{ kind: "plate", x: 0, y: 80, w: 30, h: 15 }], at: "2026-07-01T09:00:00+08:00" });
  addVersion(6, s5, 1, "初次上报现场", [p5a], "2026-06-01T08:00:00+08:00", "拼音分写错误");
  addVersion(7, s5, 2, "整改后复查（通过）", [p5b], "2026-07-01T09:00:00+08:00", "新牌符合规范");
  const prop3 = {
    id: seedId("pp", 3), sign_id: s5.id, volunteer_id: "u-vol-lin",
    language: "English", text: "Fuzhou Railway Station",
    rationale: "地名连写", created_at: "2026-06-10T09:00:00+08:00",
  };
  db.proposals.set(prop3.id, prop3);
  s5.proposal_ids.push(prop3.id);
  const rv3 = {
    id: seedId("rv", 2), sign_id: s5.id, proposal_id: prop3.id, expert_id: "u-exp-wang",
    verdict: "approved", note: "通过", created_at: "2026-06-15T09:00:00+08:00",
  };
  db.reviews.set(rv3.id, rv3);
  s5.review_ids.push(rv3.id);
  const rc2 = {
    id: seedId("rc", 2), sign_id: s5.id, org: s5.owner_org,
    action: "replace_proof", note: "新牌已安装", photo_ids: [p5b], created_at: "2026-06-30T17:00:00+08:00",
  };
  db.receipts.set(rc2.id, rc2);
  s5.receipt_ids.push(rc2.id);
  const exact5 = { lat: 26.10000, lng: 119.32000 };
  db.reports.set(seedId("rp", 5), {
    id: seedId("rp", 5), sign_id: s5.id, link_confirmed: true,
    title: s5.title, language: "English",
    clause: "GB/T 30240.1-2013 交通类",
    suggestion: "Fu Zhou 应连写为 Fuzhou",
    location_precision: "approx", location_authorized: true,
    exact_point: exact5, fuzzed_point: fuzzCoordinate(exact5.lat, exact5.lng, "approx"), public_point: fuzzCoordinate(exact5.lat, exact5.lng, "street"),
    dhashes: ["1234123412341234"], photo_ids: [p5a],
    reporter_contact: null, reporter_token: "tok-seed-rp-005",
    created_at: "2026-06-01T08:00:00+08:00",
  });
  s5.best_location = { authorized_exact: false, exact: exact5, fuzzed: fuzzCoordinate(exact5.lat, exact5.lng, "approx") };

  // ---------- 标识 6：待甄别的重复线索（合并候选，等待人工确认） ----------
  const s6 = {
    id: seedId("sign", 6),
    title: "Beware of the pool",
    district: "鼓楼区", road: "湖东路",
    owner_org: null, // 尚未分派设置单位
    language_needs: ["English"],
    status: "triage",
    created_at: "2026-09-15T09:00:00+08:00",
    updated_at: "2026-09-18T09:30:00+08:00",
    first_report_at: "2026-09-15T09:00:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 0, canonical_translation: null,
    best_location: null,
  };
  db.signs.set(s6.id, s6);
  const p6 = photo(8, { at: "2026-09-15T09:00:00+08:00" });
  addVersion(8, s6, 1, "初次上报现场", [p6], "2026-09-15T09:00:00+08:00");
  const exact6 = { lat: 26.09050, lng: 119.29700 };
  db.reports.set(seedId("rp", 6), {
    id: seedId("rp", 6), sign_id: s6.id, link_confirmed: true,
    title: "Beware of the pool", language: "English",
    clause: "GB/T 30240.1-2013 安全警示类",
    suggestion: "应为 Wet Floor / Slippery Surface",
    location_precision: "exact", location_authorized: true,
    exact_point: exact6, fuzzed_point: fuzzCoordinate(exact6.lat, exact6.lng, "approx"), public_point: fuzzCoordinate(exact6.lat, exact6.lng, "street"),
    dhashes: ["abcdabcdabcdabcd"], photo_ids: [p6],
    reporter_contact: null, reporter_token: "tok-seed-rp-006",
    created_at: "2026-09-15T09:00:00+08:00",
  });
  // 第二条非常近似的线索：独立建标识 s7，系统自动生成合并候选，
  // 必须由主管部门人工确认（merge / separate），确认前不派发、不删除。
  const s7 = {
    id: seedId("sign", 7),
    title: "Beware of the pool",
    district: "鼓楼区", road: "湖东路",
    owner_org: null,
    language_needs: ["English"],
    status: "triage",
    created_at: "2026-09-18T09:30:00+08:00",
    updated_at: "2026-09-18T09:30:00+08:00",
    first_report_at: "2026-09-18T09:30:00+08:00",
    site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
    reopen_count: 0, canonical_translation: null,
    best_location: null,
  };
  db.signs.set(s7.id, s7);
  const p6b = photo(9, { boxes: [{ kind: "plate", x: 60, y: 70, w: 25, h: 12 }], at: "2026-09-18T09:30:00+08:00" });
  addVersion(9, s7, 1, "初次上报现场", [p6b], "2026-09-18T09:30:00+08:00");
  const exact6b = { lat: 26.09055, lng: 119.29706 };
  const r6b = {
    id: seedId("rp", 7), sign_id: s7.id, link_confirmed: false,
    title: "Beware of the pool", language: "English",
    clause: "GB/T 30240.1-2013 安全警示类",
    suggestion: "水塘边警示牌英文错误（另一角度拍摄）",
    location_precision: "exact", location_authorized: true,
    exact_point: exact6b, fuzzed_point: fuzzCoordinate(exact6b.lat, exact6b.lng, "approx"), public_point: fuzzCoordinate(exact6b.lat, exact6b.lng, "street"),
    dhashes: ["abcdabccabcdabcf"], photo_ids: [p6b],
    reporter_contact: "139****0002", reporter_token: "tok-seed-rp-007",
    created_at: "2026-09-18T09:30:00+08:00",
  };
  db.reports.set(r6b.id, r6b);
  s7.best_location = { authorized_exact: true, exact: exact6b, fuzzed: fuzzCoordinate(exact6b.lat, exact6b.lng, "approx") };
  db.mergeCandidates.set(seedId("mc", 1), {
    id: seedId("mc", 1),
    new_sign_id: s7.id, sign_id: s6.id, report_id: r6b.id,
    reasons: ["图片视觉近似(汉明距离 2)", "坐标邻近 7m（exact 粒度）", "标识文字相同"],
    status: "pending", created_at: "2026-09-18T09:30:00+08:00",
    decided_by: null, decided_at: null,
  });

  return db;
}
