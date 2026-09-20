// 领域规则：身份与权限、位置精度、相似候选、状态流转与隐私投影。
// 规则集中在此文件，API 层只做编排，测试可直接引用。

export const ROLES = ["public", "volunteer", "expert", "manager", "admin"];

export const LOCATION_PRECISIONS = ["exact", "approx", "street", "none"];

// 各精度允许的网格半径（米）。未授权精确坐标时，只允许在更粗粒度上比较邻近度。
const GRID_METERS = { exact: 50, approx: 300, street: 800, none: null };

export const SIGN_STATUS = {
  triage: "待甄别",
  open: "待译",
  awaiting_expert: "待专家审定",
  expert_approved: "审定通过",
  appealed: "单位申诉中",
  accepted: "单位已接受",
  rectifying: "整改中",
  rectified: "已整改规范",
  reopened: "复查不通过·重新办理",
  merged: "已并入其他标识",
};

export function nowIso() {
  return new Date().toISOString();
}

export function daysBetween(aIso, bIso = nowIso()) {
  return Math.max(0, Math.floor((Date.parse(bIso) - Date.parse(aIso)) / 86400000));
}

// 64 位 dHash 的汉明距离（客户端按 16×16 亮度梯度生成 16 位十六进制串）。
export function hamming64(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

// haversine 距离（米）
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 按授权精度模糊坐标。约 0.0045° 纬度 ≈ 500m；street 更粗。
export function fuzzCoordinate(lat, lng, precision) {
  const step = precision === "approx" ? 0.0045 : precision === "street" ? 0.01 : null;
  if (step == null) return null;
  const snap = (v) => Math.round(v / step) * step + step / 2;
  return { lat: Number(snap(lat).toFixed(5)), lng: Number(snap(lng).toFixed(5)) };
}

// 依据两份线索的授权精度决定可比较的最近距离，无授权则返回 null（不做空间比对）。
export function comparableProximity(a, b) {
  if (a.location_precision === "none" || b.location_precision === "none") return null;
  if (!a.location_authorized || !b.location_authorized) return null;
  const coarsest =
    a.location_precision === "exact" && b.location_precision === "exact"
      ? "exact"
      : ["approx", "street"].includes(a.location_precision) &&
          ["approx", "street"].includes(b.location_precision)
        ? "street"
        : "approx";
  const pa = levelPoint(a, coarsest);
  const pb = levelPoint(b, coarsest);
  if (!pa || !pb) return null;
  return { distance: distanceMeters(pa, pb), threshold: GRID_METERS[coarsest], level: coarsest };
}

// 双方都授权精确时才使用精确点；否则只在模糊点上比较。
function levelPoint(r, level) {
  if (level === "exact") return r.exact_point ?? r.fuzzed_point ?? r.public_point ?? null;
  return r.fuzzed_point ?? r.public_point ?? r.exact_point ?? null;
}

// 生成合并候选：只“提议”，绝不自动合并或删除。
// imageMaxDistance=8：视觉近似；sameText 作为邻近之外的第二信号。
export function evaluateDuplicate({ candidate, existing, imageMaxDistance = 8 }) {
  const reasons = [];
  let bestImage = 64;
  for (const dhA of candidate.dhashes) {
    for (const dhB of existing.dhashes) {
      bestImage = Math.min(bestImage, hamming64(dhA, dhB));
    }
  }
  if (bestImage <= imageMaxDistance) reasons.push(`图片视觉近似(汉明距离 ${bestImage})`);

  const prox = comparableProximity(candidate, existing);
  if (prox && prox.distance <= prox.threshold) {
    reasons.push(`坐标邻近 ${Math.round(prox.distance)}m（${prox.level} 粒度）`);
  }

  const sameText =
    candidate.title &&
    existing.title &&
    candidate.title.replace(/\s+/g, "") === existing.title.replace(/\s+/g, "");
  if (sameText) reasons.push("标识文字相同");

  // 规则：图片近似，或“邻近 + 同文”。仅邻近不足以成候选——相邻的本就是不同路牌。
  const hit =
    bestImage <= imageMaxDistance || (prox && prox.distance <= prox.threshold && sameText);
  return hit
    ? { hit: true, reasons, image_distance: bestImage, proximity: prox }
    : { hit: false, reasons, image_distance: bestImage, proximity: prox };
}

// 专家资格：语种对口，且与设置单位无利益冲突；不得自审（志愿者与专家账号分立）。
export function expertEligibility(expert, sign) {
  const needs = sign.language_needs ?? [];
  const matchedLanguages = needs.filter((l) => (expert.languages ?? []).includes(l));
  const conflicted =
    !!sign.owner_org && (expert.conflict_orgs ?? []).includes(sign.owner_org);
  const reasons = [];
  if (matchedLanguages.length === 0) reasons.push("专家语种与线索语种不匹配");
  if (conflicted) reasons.push(`专家与设置单位「${sign.owner_org}」存在利益冲突，应回避`);
  if (expert.role !== "expert") reasons.push("审定人必须具备专家身份");
  return {
    eligible: reasons.length === 0,
    matchedLanguages,
    conflicted,
    reasons,
  };
}

function statusOf(sign) {
  return { status: sign.status, status_text: SIGN_STATUS[sign.status] ?? sign.status };
}

function projectPhoto(photo) {
  return {
    id: photo.id,
    url: `/api/photos/${photo.id}`,
    redacted: photo.redacted,
    redaction_boxes: photo.redaction_boxes,
    fingerprint: photo.fingerprint,
    width: photo.width,
    height: photo.height,
    created_at: photo.created_at,
  };
}

// 联系方式掩码：主管部门(admin)可见完整信息；其他任何角色只见“是否已留联系方式”。
function maskContact(report, canSeeContact) {
  if (canSeeContact) return { reporter_contact: report.reporter_contact ?? null };
  return { contact_provided: Boolean(report.reporter_contact) };
}

function reportView(db, report, { canSeeContact, includeLocation }) {
  const out = {
    id: report.id,
    sign_id: report.sign_id,
    language: report.language,
    clause: report.clause,
    suggestion: report.suggestion,
    location_precision: report.location_precision,
    location_authorized: report.location_authorized,
    created_at: report.created_at,
    photos: report.photo_ids.map((id) => projectPhoto(db.photos.get(id))).filter(Boolean),
    ...maskContact(report, canSeeContact),
  };
  if (includeLocation) {
    // 位置只按授权回流：精确坐标仅在 reporter 授权精确时对处置单位开放；其余只给模糊点。
    out.point =
      includeLocation === "exact"
        ? report.exact_point ?? report.fuzzed_point ?? report.public_point ?? null
        : report.fuzzed_point ?? report.public_point ?? null;
  }
  return out;
}

function chainHead(db, sign) {
  let cur = sign;
  const guard = new Set();
  while (cur.merged_into && !guard.has(cur.id)) {
    guard.add(cur.id);
    cur = db.signs.get(cur.merged_into) ?? cur;
  }
  return cur;
}

/**
 * 角色化视图。viewer 为登录用户或 { role:'public' }；
 * extra.ownReportId 用于举报人查询本人线索。
 */
export function projectSign(db, sign, viewer, extra = {}) {
  const role = viewer?.role ?? "public";
  const head = chainHead(db, sign);

  const base = {
    id: sign.id,
    title: sign.title,
    district: sign.district ?? null,
    road: sign.road ?? null,
    language_needs: sign.language_needs ?? [],
    owner_org: role === "admin" || role === "manager" || role === "expert" || role === "volunteer"
      ? (sign.owner_org ?? null)
      : null,
    merged_into: sign.merged_into ?? null,
    head_sign_id: head.id,
    created_at: sign.created_at,
    updated_at: sign.updated_at,
    ...statusOf(sign),
    version_count: sign.site_version_ids.length,
  };

  // 规范译法仅在整改规范（或管理员预览）时向公众发布；办理中的译法不对公众开放。
  if (sign.canonical_translation && (sign.status === "rectified" || role === "admin")) {
    base.canonical_translation = sign.canonical_translation;
  }

  const reports = [...db.reports.values()].filter((r) => r.sign_id === sign.id);

  if (role === "admin") {
    return {
      ...base,
      location: sign.best_location,
      reports: reports.map((r) => reportView(db, r, { canSeeContact: true, includeLocation: "exact" })),
      versions: sign.site_version_ids.map((id) => db.siteVersions.get(id)),
      proposals: sign.proposal_ids.map((id) => db.proposals.get(id)),
      reviews: sign.review_ids.map((id) => db.reviews.get(id)),
      receipts: sign.receipt_ids.map((id) => db.receipts.get(id)),
      reopen_count: sign.reopen_count,
    };
  }

  if (role === "manager") {
    if (sign.owner_org !== viewer.org) return null; // 看不到非本单位标识
    // 设置单位需要现场位置才能整改，但只拿到举报人授权范围内的精度。
    const level = sign.best_location?.authorized_exact ? "exact" : "fuzzed";
    return {
      ...base,
      location: level === "exact" ? sign.best_location.exact : sign.best_location?.fuzzed ?? null,
      reports: reports.map((r) =>
        reportView(db, r, {
          canSeeContact: false,
          includeLocation: r.location_authorized
            ? (r.location_precision === "exact" ? "exact" : "fuzzed")
            : false,
        }),
      ),
      versions: sign.site_version_ids.map((id) => db.siteVersions.get(id)),
      proposals: sign.proposal_ids.map((id) => {
        const p = db.proposals.get(id);
        return { ...p, volunteer_contact: undefined };
      }),
      reviews: sign.review_ids.map((id) => {
        const rv = db.reviews.get(id);
        return { ...rv, expert_contact: undefined };
      }),
    };
  }

  if (role === "expert" || role === "volunteer") {
    // 办理人需要纠错意见、规范条款与现场照片来工作；联系方式始终不可见。
    return {
      ...base,
      reports: reports.map((r) =>
        reportView(db, r, {
          canSeeContact: false,
          includeLocation: r.fuzzed_point || r.public_point ? "fuzzed" : false,
        }),
      ),
      versions: sign.site_version_ids.map((id) => db.siteVersions.get(id)),
      proposals: sign.proposal_ids.map((id) => db.proposals.get(id)),
      reviews: sign.review_ids.map((id) => db.reviews.get(id)),
    };
  }

  // 匿名公众：仅状态与（已发布的）规范译法；不含联系方式、坐标、意见明细。
  if (extra.ownReportId) {
    const own = reports.find((r) => r.id === extra.ownReportId);
    if (!own) return null;
    return {
      ...base,
      my_report: reportView(db, own, {
        canSeeContact: true, // 本人看本人留存的联系方式
        includeLocation: own.exact_point ? "exact" : "fuzzed",
      }),
      timeline: buildTimeline(db, sign, own.id),
    };
  }
  return base;
}

// 举报人的办理时间线：聚合本标识的关键节点，不暴露其他举报人与单位内部申诉措辞。
export function buildTimeline(db, sign, ownReportId) {
  const events = [];
  for (const vid of sign.site_version_ids) {
    const v = db.siteVersions.get(vid);
    events.push({ at: v.observed_at, type: "site_version", label: `${v.label}（第 ${v.seq} 版现场记录）` });
  }
  for (const rid of sign.review_ids) {
    const rv = db.reviews.get(rid);
    events.push({
      at: rv.created_at,
      type: "expert_review",
      label: rv.verdict === "approved" ? "专家审定通过译法" : "专家要求修改译法",
    });
  }
  for (const rcId of sign.receipt_ids) {
    const rc = db.receipts.get(rcId);
    if (rc.action === "replace_proof") events.push({ at: rc.created_at, type: "proof", label: "设置单位提交更换证明" });
  }
  if (sign.status === "rectified" && sign.canonical_translation) {
    events.push({ at: sign.updated_at, type: "done", label: `整改完成，规范译法：${sign.canonical_translation.text}` });
  }
  const own = db.reports.get(ownReportId);
  if (own) events.push({ at: own.created_at, type: "report", label: "您的线索已提交" });
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// 主管部门分析：长期未整改、反复出错、专家资源不足；输出不含任何个人标识。
export function buildAnalytics(db) {
  const signs = [...db.signs.values()].filter((s) => s.merged_into == null);
  const active = signs.filter((s) => s.status !== "rectified");

  const longStanding = active
    .map((s) => ({
      sign_id: s.id,
      title: s.title,
      district: s.district,
      owner_org: s.owner_org,
      status_text: SIGN_STATUS[s.status],
      open_days: daysBetween(s.first_report_at),
      reopen_count: s.reopen_count,
    }))
    .sort((a, b) => b.open_days - a.open_days)
    .filter((x) => x.open_days >= 30)
    .slice(0, 20);

  const repeatByOrg = new Map();
  for (const s of signs) {
    if (s.reopen_count > 0 || s.site_version_ids.length >= 3) {
      const row = repeatByOrg.get(s.owner_org ?? "未分派") ?? { org: s.owner_org ?? "未分派", signs: 0, reopen_total: 0 };
      row.signs += 1;
      row.reopen_total += s.reopen_count;
      repeatByOrg.set(s.owner_org ?? "未分派", row);
    }
  }

  const languagePool = [...db.users.values()].filter((u) => u.role === "expert");
  const shortageMap = new Map();
  for (const s of active) {
    if (!["open", "awaiting_expert", "reopened"].includes(s.status)) continue;
    for (const lang of s.language_needs ?? []) {
      const eligible = languagePool.filter((e) => expertEligibility(e, { ...s, owner_org: s.owner_org ?? "__none__" }).eligible
        && (e.languages ?? []).includes(lang));
      if (eligible.length === 0) {
        const key = `${s.district ?? "未知区域"}|${lang}`;
        const row = shortageMap.get(key) ?? { district: s.district, language: lang, waiting_signs: [] };
        row.waiting_signs.push(s.id);
        shortageMap.set(key, row);
      }
    }
  }

  const districtWorkload = new Map();
  for (const s of active) {
    const d = s.district ?? "未知区域";
    districtWorkload.set(d, (districtWorkload.get(d) ?? 0) + 1);
  }

  return {
    generated_at: nowIso(),
    active_sign_total: active.length,
    long_standing: longStanding,
    repeat_errors_by_org: [...repeatByOrg.values()],
    expert_shortage: [...shortageMap.values()].map((r) => ({ ...r, waiting: r.waiting_signs.length })),
    district_workload: [...districtWorkload.entries()].map(([district, active_count]) => ({ district, active_count })),
  };
}
