// 领域层：围绕同一标识（sign）持续累积现场版本、照片、语种、规范条款、
// 纠错意见、专家审定与整改回执。所有状态流转都经过这里，路由层只做解析。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truncateCoords, haversineMeters, gridKey, PRECISION_LEVELS } from "./geo.js";
import { stripMetadata, sha256Hex, hammingDistance } from "./image.js";
import { progressView } from "./privacy.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 照片感知哈希差异阈值（64 位 dHash）与坐标邻近阈值（米）。
const DHASH_THRESHOLD = 10;
const NEARBY_METERS = 60;
// 超过 30 天未办结视为长期未整改。
const OVERDUE_DAYS = 30;

const now = () => new Date().toISOString();

export class SignService {
  constructor(store, photoDir) {
    this.store = store;
    this.photoDir = photoDir;
    mkdirSync(photoDir, { recursive: true });
  }

  // ---------- 市民报错 ----------

  submitReport(input) {
    const language = String(input.language ?? "").trim();
    const suggestion = String(input.suggestion ?? "").trim();
    if (!language) throw new HttpError(400, "请填写标识语种");
    if (!suggestion) throw new HttpError(400, "请填写纠错意见");
    const photo = this.#savePhoto(input.photo);

    const authorized = input.location_authorized === true;
    const precision = PRECISION_LEVELS.includes(input.precision) ? input.precision : "none";
    const coords = authorized
      ? truncateCoords(Number(input.lat), Number(input.lng), precision)
      : null;

    const sign = {
      id: this.store.id("sign"),
      setting_unit: String(input.setting_unit ?? "").trim() || "待确认",
      languages: [language],
      norm_clauses: normalizeClauses(input.norm_clauses),
      status: "待处理",
      standard_translation: null,
      location: {
        authorized,
        precision: authorized ? precision : "none",
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      },
      address_text: authorized ? String(input.address_text ?? "").slice(0, 200) : "",
      created_at: now(),
      closed_at: null,
    };
    const version = this.#newVersion(sign.id, 1, "市民报错", suggestion, [photo.id]);
    const report = {
      id: this.store.id("report"),
      sign_id: sign.id,
      version_id: version.id,
      reporter_token: this.store.id("rtk"),
      contact: String(input.contact ?? "").slice(0, 200), // 仅库内留存，任何接口不返回
      language,
      suggestion,
      norm_clauses: sign.norm_clauses,
      photo_id: photo.id,
      status: "已提交",
      created_at: now(),
    };
    photo.sign_id = sign.id;
    photo.version_id = version.id;
    this.store.data.signs.push(sign);
    this.store.data.versions.push(version);
    this.store.data.reports.push(report);

    // 相似图片与邻近坐标只提出合并候选，绝不自动合并或删除线索。
    const candidates = this.#proposeMergeCandidates(report, sign, photo);
    this.store.save();
    return {
      report_id: report.id,
      reporter_token: report.reporter_token,
      sign_id: sign.id,
      merge_candidates: candidates.length,
    };
  }

  #savePhoto(photoInput) {
    if (!photoInput || typeof photoInput.data_url !== "string") {
      throw new HttpError(400, "请上传已遮蔽人脸与车牌的现场照片");
    }
    const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(photoInput.data_url);
    if (!match) throw new HttpError(415, "仅支持 JPEG/PNG 图片");
    const mime = match[1];
    let raw;
    try {
      raw = Buffer.from(match[2], "base64");
    } catch {
      throw new HttpError(400, "图片数据无法解析");
    }
    if (raw.length === 0 || raw.length > 8 * 1024 * 1024) {
      throw new HttpError(413, "图片大小需在 8MB 以内");
    }
    let stripped;
    try {
      stripped = stripMetadata(raw, mime);
    } catch (err) {
      throw new HttpError(415, err.message);
    }
    const masks = Array.isArray(photoInput.masks) ? photoInput.masks.slice(0, 64) : [];
    if (masks.length === 0 && photoInput.no_mask_confirmed !== true) {
      throw new HttpError(400, "请先确认人脸与车牌遮蔽区域（无遮蔽对象时请勾选确认）");
    }
    const id = this.store.id("photo");
    const ext = mime === "image/png" ? "png" : "jpg";
    const file = join(this.photoDir, `${id}.${ext}`);
    writeFileSync(file, stripped.buffer);
    const photo = {
      id,
      file,
      mime,
      fingerprint: sha256Hex(stripped.buffer),
      dhash: /^[0-9a-f]{16}$/i.test(photoInput.dhash ?? "") ? photoInput.dhash.toLowerCase() : null,
      masks,
      metadata_removed: stripped.removed,
      sign_id: null,
      version_id: null,
      created_at: now(),
    };
    this.store.data.photos.push(photo);
    return photo;
  }

  #newVersion(signId, seq, source, note, photos) {
    return {
      id: this.store.id("ver"),
      sign_id: signId,
      seq,
      source,
      note: String(note ?? "").slice(0, 500),
      photos,
      created_at: now(),
    };
  }

  #proposeMergeCandidates(report, sign, photo) {
    const reasons = [];
    const created = [];
    for (const other of this.store.data.signs) {
      if (other.id === sign.id || other.status === "已办结") continue;
      reasons.length = 0;
      for (const otherPhoto of this.store.data.photos) {
        if (otherPhoto.sign_id !== other.id || !otherPhoto.dhash || !photo.dhash) continue;
        const distance = hammingDistance(photo.dhash, otherPhoto.dhash);
        if (distance !== null && distance <= DHASH_THRESHOLD) {
          reasons.push(`照片相似(差异${distance}位)`);
          break;
        }
      }
      const a = sign.location;
      const b = other.location;
      if (a.lat !== null && b.lat !== null && haversineMeters(a, b) <= NEARBY_METERS) {
        reasons.push(`坐标邻近(${Math.round(haversineMeters(a, b))}米)`);
      }
      if (reasons.length > 0) {
        const candidate = {
          id: this.store.id("merge"),
          report_id: report.id,
          from_sign_id: sign.id,
          to_sign_id: other.id,
          reasons: [...reasons],
          status: "待裁决",
          created_at: now(),
          resolved_by: null,
          resolved_at: null,
        };
        this.store.data.merge_candidates.push(candidate);
        created.push(candidate);
      }
    }
    return created;
  }

  // ---------- 合并候选裁决（主管部门） ----------

  resolveMergeCandidate(user, candidateId, action) {
    const candidate = this.store.find("merge_candidates", candidateId);
    if (!candidate) throw new HttpError(404, "合并候选不存在");
    if (candidate.status !== "待裁决") throw new HttpError(409, "该候选已裁决");
    if (!["merge", "keep"].includes(action)) throw new HttpError(400, "action 须为 merge 或 keep");

    const report = this.store.find("reports", candidate.report_id);
    const fromSign = this.store.find("signs", candidate.from_sign_id);
    const toSign = this.store.find("signs", candidate.to_sign_id);
    if (!report || !fromSign || !toSign) throw new HttpError(409, "相关记录已变更，无法裁决");

    if (action === "merge") {
      // 合并：线索挂到已有标识下，照片形成新的现场版本；原标识记录保留备查。
      report.sign_id = toSign.id;
      report.status = "已合并";
      const version = this.#newVersion(
        toSign.id,
        this.#nextSeq(toSign.id),
        "线索合并",
        report.suggestion,
        [report.photo_id],
      );
      this.store.data.versions.push(version);
      const photo = this.store.find("photos", report.photo_id);
      if (photo) {
        photo.sign_id = toSign.id;
        photo.version_id = version.id;
      }
      report.version_id = version.id;
      toSign.languages = [...new Set([...toSign.languages, report.language])];
      toSign.norm_clauses = [...new Set([...toSign.norm_clauses, ...report.norm_clauses])];
      fromSign.status = "已并入他案";
    } else {
      // 保留：两条线索各自独立，任何记录都不删除。
      candidate.status = "已保留各自独立";
    }
    if (action === "merge") candidate.status = "已合并";
    candidate.resolved_by = user.id;
    candidate.resolved_at = now();
    this.store.save();
    return candidate;
  }

  #nextSeq(signId) {
    return this.store.data.versions.filter((v) => v.sign_id === signId).length + 1;
  }

  // ---------- 志愿者译法 ----------

  proposeTranslation(user, signId, input) {
    const sign = this.#openSign(signId);
    if (!["待处理", "译法待审定"].includes(sign.status)) {
      throw new HttpError(409, `当前状态(${sign.status})不接受新的译法`);
    }
    const language = String(input.language ?? "").trim();
    const translation = String(input.translation ?? "").trim();
    if (!language || !translation) throw new HttpError(400, "请填写语种与建议译法");
    const proposal = {
      id: this.store.id("prop"),
      sign_id: sign.id,
      volunteer_id: user.id,
      language,
      translation,
      note: String(input.note ?? "").slice(0, 500),
      norm_clauses: normalizeClauses(input.norm_clauses),
      status: "待审定",
      round: sign.status === "申诉复核中" ? 2 : 1,
      created_at: now(),
    };
    sign.languages = [...new Set([...sign.languages, language])];
    sign.norm_clauses = [...new Set([...sign.norm_clauses, ...proposal.norm_clauses])];
    sign.status = "译法待审定";
    this.store.data.proposals.push(proposal);
    this.store.save();
    return proposal;
  }

  // ---------- 专家审定：语种匹配 + 利益冲突校验 ----------

  expertEligible(expert, proposal, sign) {
    if (!expert.languages?.includes(proposal.language)) {
      return { ok: false, reason: "专家语种与译法语种不匹配" };
    }
    const affiliations = expert.affiliations ?? [];
    if (affiliations.includes(sign.setting_unit)) {
      return { ok: false, reason: "专家与设置单位存在利益冲突" };
    }
    if (proposal.volunteer_id === expert.id) {
      return { ok: false, reason: "专家不能审定自己提交的译法" };
    }
    return { ok: true };
  }

  expertQueue(expert) {
    return this.store.data.proposals
      .filter((p) => p.status === "待审定")
      .map((p) => ({ proposal: p, sign: this.store.find("signs", p.sign_id) }))
      .filter(({ sign }) => sign && ["译法待审定", "申诉复核中"].includes(sign.status))
      .map(({ proposal, sign }) => ({
        ...proposal,
        setting_unit: sign.setting_unit,
        eligibility: this.expertEligible(expert, proposal, sign),
      }));
  }

  reviewProposal(expert, proposalId, input) {
    const proposal = this.store.find("proposals", proposalId);
    if (!proposal) throw new HttpError(404, "译法不存在");
    if (proposal.status !== "待审定") throw new HttpError(409, "该译法已审定");
    const sign = this.store.find("signs", proposal.sign_id);
    const eligibility = this.expertEligible(expert, proposal, sign);
    if (!eligibility.ok) throw new HttpError(403, eligibility.reason);
    const decision = input.decision;
    if (!["通过", "不通过"].includes(decision)) throw new HttpError(400, "decision 须为 通过/不通过");

    const review = {
      id: this.store.id("rev"),
      proposal_id: proposal.id,
      expert_id: expert.id,
      decision,
      comment: String(input.comment ?? "").slice(0, 500),
      created_at: now(),
    };
    this.store.data.reviews.push(review);
    if (decision === "通过") {
      proposal.status = "已通过";
      sign.standard_translation = proposal.translation;
      sign.status = "待整改";
    } else {
      proposal.status = "未通过";
      sign.status = "待处理";
    }
    this.store.save();
    return review;
  }

  // ---------- 设置单位：接受 / 申诉 / 上传更换证明 ----------

  unitRespond(user, signId, input) {
    const sign = this.#openSign(signId);
    if (!(user.affiliations ?? []).includes(sign.setting_unit)) {
      throw new HttpError(403, "仅该标识的设置单位可以回应");
    }
    const action = input.action;
    const note = String(input.note ?? "").slice(0, 500);
    const record = {
      id: this.store.id("rect"),
      sign_id: sign.id,
      action,
      note,
      version_id: null,
      created_at: now(),
    };

    if (action === "accept") {
      if (sign.status !== "待整改") throw new HttpError(409, `当前状态(${sign.status})不能接受整改`);
      sign.status = "整改中";
    } else if (action === "appeal") {
      if (sign.status !== "待整改") throw new HttpError(409, `当前状态(${sign.status})不能申诉`);
      const proposal = this.store.data.proposals.find(
        (p) => p.sign_id === sign.id && p.status === "已通过",
      );
      if (!proposal) throw new HttpError(409, "没有可申诉的已审定译法");
      proposal.status = "待审定"; // 回到专家复核，仍受语种与利益冲突约束
      proposal.round = 2;
      sign.status = "申诉复核中";
    } else if (action === "proof") {
      if (!["整改中", "待整改"].includes(sign.status)) {
        throw new HttpError(409, `当前状态(${sign.status})不能上传更换证明`);
      }
      const photo = this.#savePhoto(input.photo);
      const version = this.#newVersion(sign.id, this.#nextSeq(sign.id), "整改回执", note, [photo.id]);
      photo.sign_id = sign.id;
      photo.version_id = version.id;
      this.store.data.versions.push(version);
      record.version_id = version.id;
      sign.status = "复查中";
    } else {
      throw new HttpError(400, "action 须为 accept/appeal/proof");
    }
    this.store.data.rectifications.push(record);
    this.store.save();
    return record;
  }

  // ---------- 复查办结（主管部门）：每次复查形成新的现场版本 ----------

  closeSign(user, signId, input) {
    const sign = this.#openSign(signId);
    if (sign.status !== "复查中") throw new HttpError(409, `当前状态(${sign.status})不能复查办结`);
    let photos = [];
    if (input.photo?.data_url) {
      const photo = this.#savePhoto(input.photo);
      photos = [photo.id];
      const version = this.#newVersion(
        sign.id,
        this.#nextSeq(sign.id),
        "复查确认",
        input.note ?? "",
        photos,
      );
      photo.sign_id = sign.id;
      photo.version_id = version.id;
      this.store.data.versions.push(version);
    }
    sign.status = "已办结";
    sign.closed_at = now();
    for (const report of this.store.data.reports.filter((r) => r.sign_id === sign.id)) {
      report.status = "已办结";
    }
    this.store.save();
    return sign;
  }

  // ---------- 查询：公众进度与主管部门统计 ----------

  reportProgress(reportId, token) {
    const report = this.store.find("reports", reportId);
    if (!report || report.reporter_token !== token) {
      throw new HttpError(404, "线索不存在或令牌无效");
    }
    const sign = this.store.find("signs", report.sign_id);
    return progressView(report, sign, this.store.data.versions);
  }

  analytics() {
    const signs = this.store.data.signs.filter((s) => s.status !== "已并入他案");
    const cutoff = Date.now() - OVERDUE_DAYS * 24 * 3600 * 1000;
    const regions = new Map();
    for (const sign of signs) {
      const key = gridKey(sign.location);
      const bucket = regions.get(key) ?? {
        region: key,
        total: 0,
        open: 0,
        overdue: 0,
        repeat_error: 0,
      };
      bucket.total += 1;
      const open = sign.status !== "已办结";
      if (open) {
        bucket.open += 1;
        if (Date.parse(sign.created_at) < cutoff) bucket.overdue += 1;
      }
      const reportCount = this.store.data.reports.filter((r) => r.sign_id === sign.id).length;
      const versionCount = this.store.data.versions.filter((v) => v.sign_id === sign.id).length;
      if (reportCount > 1 || versionCount > 2) bucket.repeat_error += 1;
      regions.set(key, bucket);
    }

    // 专家资源：按语种统计待审定译法与具备该语种且无冲突的专家数。
    const pending = this.store.data.proposals.filter((p) => p.status === "待审定");
    const languages = new Set([
      ...pending.map((p) => p.language),
      ...this.store.data.users.filter((u) => u.role === "expert").flatMap((u) => u.languages ?? []),
    ]);
    const expert_load = [...languages].map((language) => {
      const proposals = pending.filter((p) => p.language === language);
      const experts = this.store.data.users.filter(
        (u) => u.role === "expert" && (u.languages ?? []).includes(language),
      );
      return {
        language,
        pending_proposals: proposals.length,
        eligible_experts: experts.length,
        shortage: proposals.length > 0 && experts.length === 0,
      };
    });

    return { regions: [...regions.values()], expert_load, merge_pending: this.store.data.merge_candidates.filter((c) => c.status === "待裁决").length };
  }

  #openSign(signId) {
    const sign = this.store.find("signs", signId);
    if (!sign) throw new HttpError(404, "标识不存在");
    return sign;
  }
}

function normalizeClauses(input) {
  if (!Array.isArray(input)) return [];
  return input.map((c) => String(c).trim()).filter(Boolean).slice(0, 20);
}

// 演示账号：真实部署应接入统一身份认证，这里用固定令牌便于联调。
export function seedUsers(store) {
  if (store.data.users.length > 0) return;
  store.data.users.push(
    { id: "u_volunteer", name: "志愿者·林", role: "volunteer", token: "volunteer-demo" },
    {
      id: "u_expert_en",
      name: "专家·陈(英语)",
      role: "expert",
      token: "expert-en-demo",
      languages: ["English"],
      affiliations: [],
    },
    {
      id: "u_expert_jp",
      name: "专家·王(日语)",
      role: "expert",
      token: "expert-jp-demo",
      languages: ["Japanese"],
      affiliations: [],
    },
    {
      id: "u_expert_conflict",
      name: "专家·郑(英语/与市园林中心相关)",
      role: "expert",
      token: "expert-conflict-demo",
      languages: ["English"],
      affiliations: ["市园林中心"],
    },
    {
      id: "u_unit",
      name: "市园林中心·经办",
      role: "unit",
      token: "unit-demo",
      affiliations: ["市园林中心"],
    },
    { id: "u_supervisor", name: "市外办·主管", role: "supervisor", token: "supervisor-demo" },
  );
  store.save();
}
