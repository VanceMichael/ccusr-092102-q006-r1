import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { createStore, newId } from "./store.js";
import {
  LOCATION_PRECISIONS,
  buildAnalytics,
  evaluateDuplicate,
  expertEligibility,
  fuzzCoordinate,
  nowIso,
  projectSign,
} from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function createServer({ db = createStore() } = {}) {
  // ---------- 工具 ----------
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const fail = (res, code, message, details) => json(res, code, { error: message, ...(details ? { details } : {}) });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 15 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("JSON 格式错误")); }
      });
      req.on("error", reject);
    });
  }

  // 会话解析：内部角色令牌或举报人本人令牌。
  function viewer(req) {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7);
      const userId = db.sessions.get(token);
      if (userId) return { user: db.users.get(userId) ?? null, token, kind: "staff" };
      const ownReport = [...db.reports.values()].find((r) => r.reporter_token === token);
      if (ownReport) return { user: null, token, kind: "reporter", ownReportId: ownReport.id };
    }
    return { user: null, kind: "public" };
  }
  const requireRole = (v, res, roles) => {
    if (!v.user || !roles.includes(v.user.role)) { fail(res, 403, "无权操作：角色不匹配"); return false; }
    return true;
  };

  function persistPhoto(input, fallbackAt) {
    const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/s.exec(input.data_url ?? "");
    if (!m) throw new Error("照片必须是 data URL（image/png|jpeg|webp）");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length === 0 || buf.length > 10 * 1024 * 1024) throw new Error("照片为空或超过 10MB");
    const id = newId("ph");
    const record = {
      id,
      content_type: m[1].replace("jpg", "jpeg"),
      data: buf,
      // 服务端只保存遮蔽后的版本；遮蔽框由手机端编辑器绘制后烧录入像素。
      redacted: true,
      redaction_boxes: input.boxes ?? [],
      fingerprint: `sha256:${createHash("sha256").update(buf).digest("hex")}`,
      width: input.width ?? null,
      height: input.height ?? null,
      created_at: fallbackAt,
    };
    db.photos.set(id, record);
    return record;
  }

  function signPhotoAccessible(sign, v, photoId) {
    const reportIds = new Set([...db.reports.values()].filter((r) => r.sign_id === sign.id).map((r) => r.id));
    const own = v.kind === "reporter" && reportIds.has(v.ownReportId);
    const report = [...db.reports.values()].find(
      (r) => r.photo_ids.includes(photoId) && (r.sign_id === sign.id),
    );
    if (v.kind === "reporter") return own && report?.photo_ids.includes(photoId);
    if (!v.user) return false;
    if (v.user.role === "admin") return true;
    if (v.user.role === "expert" || v.user.role === "volunteer") return true;
    if (v.user.role === "manager") return sign.owner_org === v.user.org;
    return false;
  }

  function addSiteVersion(sign, { label, note, photoIds, observedText, at }) {
    const seq = sign.site_version_ids.length + 1;
    const id = newId("sv");
    db.siteVersions.set(id, {
      id, sign_id: sign.id, seq, label, note: note ?? "",
      photo_ids: photoIds, observed_text: observedText ?? sign.title,
      observed_at: at, created_at: at,
    });
    sign.site_version_ids.push(id);
    return id;
  }

  // 合并候选扫描：对每个“在办”的既有标识取最强信号，仅提议、不自动合并。
  function scanDuplicates(report) {
    const found = [];
    for (const sign of db.signs.values()) {
      if (sign.id === report.sign_id) continue; // 排除刚创建的自身标识
      if (sign.merged_into || sign.status === "rectified") continue;
      const others = [...db.reports.values()].filter((r) => r.sign_id === sign.id);
      let best = null;
      for (const other of others) {
        const r = evaluateDuplicate({
          candidate: report,
          existing: {
            title: other.title,
            dhashes: other.dhashes,
            location_precision: other.location_precision,
            location_authorized: other.location_authorized,
            exact_point: other.exact_point, fuzzed_point: other.fuzzed_point, public_point: other.public_point,
          },
        });
        if (r.hit && (!best || r.image_distance < best.image_distance)) best = { ...r, via_report: other.id };
      }
      if (best) found.push({ sign, reasons: best.reasons, image_distance: best.image_distance });
    }
    return found;
  }

  const pendingCandidatesFor = (signId) =>
    [...db.mergeCandidates.values()].filter(
      (c) => c.status === "pending" && (c.sign_id === signId || c.new_sign_id === signId),
    );

  // ---------- 路由 ----------
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const method = req.method;
    const v = viewer(req);

    // 健康检查
    if (method === "GET" && p === "/health") {
      return json(res, 200, { 状态: "服务已启动", 时间: nowIso() });
    }

    // 静态页面
    if (method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, "index.html");
    if (method === "GET" && p === "/console.html") return serveFile(res, "console.html");
    if (method === "GET" && p.startsWith("/static/")) {
      const name = normalize(p.slice("/static/".length)).replace(/^(\.\.[/\\])+/, "");
      return serveFile(res, join("assets", name));
    }

    // 照片访问：严格按角色与本人线索授权
    if (method === "GET" && p.startsWith("/api/photos/")) {
      const id = decodeURIComponent(p.slice("/api/photos/".length));
      const photo = db.photos.get(id);
      if (!photo) return fail(res, 404, "照片不存在");
      const report = [...db.reports.values()].find((r) => r.photo_ids.includes(id));
      const sign = report ? db.signs.get(report.sign_id) : null;
      // 支持 ?t= 举报人令牌（<img> 无法带 Authorization 头）
      let accessV = v;
      if (!v.user && v.kind !== "reporter" && url.searchParams.get("t")) {
        const token = url.searchParams.get("t");
        const own = [...db.reports.values()].find((r) => r.reporter_token === token);
        if (own) accessV = { kind: "reporter", ownReportId: own.id };
      }
      if (!sign || !signPhotoAccessible(sign, accessV, id)) return fail(res, 403, "无权查看该照片");
      res.writeHead(200, {
        "content-type": photo.content_type,
        "cache-control": "no-store",
      });
      return res.end(photo.data);
    }

    // 市民上报
    if (method === "POST" && p === "/api/reports") {
      let body;
      try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
      const lang = String(body.language ?? "").trim();
      const precision = body.location_precision ?? "none";
      const authorized = Boolean(body.location_authorized);
      if (!body.title || !lang) return fail(res, 400, "标识文字与语种为必填");
      if (!LOCATION_PRECISIONS.includes(precision)) return fail(res, 400, "位置精度不合法");
      if (!Array.isArray(body.photos) || body.photos.length === 0) return fail(res, 400, "至少上传一张已遮蔽人脸/车牌的照片");

      const at = nowIso();
      let photoRecords;
      try { photoRecords = body.photos.map((ph) => persistPhoto(ph, at)); }
      catch (e) { return fail(res, 400, e.message); }

      // 位置只按授权保存：未授权则不保留任何坐标。
      let exact = null;
      if (authorized && precision !== "none" && Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
        exact = { lat: Number(body.lat), lng: Number(body.lng) };
        if (precision !== "exact") exact = fuzzCoordinate(exact.lat, exact.lng, precision);
      }
      const point = exact
        ? {
            exact_point: precision === "exact" ? exact : null,
            fuzzed_point: fuzzCoordinate(exact.lat, exact.lng, "approx"),
            public_point: fuzzCoordinate(exact.lat, exact.lng, "street"),
          }
        : { exact_point: null, fuzzed_point: null, public_point: null };

      const signId = newId("sign");
      const sign = {
        id: signId,
        title: String(body.title).slice(0, 200),
        district: body.district ?? null,
        road: body.road ?? null,
        owner_org: null, // 先归集甄别，主管部门确认非重复后才分派
        language_needs: [lang],
        status: "triage",
        created_at: at, updated_at: at, first_report_at: at,
        site_version_ids: [], proposal_ids: [], review_ids: [], receipt_ids: [],
        reopen_count: 0, canonical_translation: null,
        best_location: exact
          ? { authorized_exact: precision === "exact", exact, fuzzed: point.fuzzed_point }
          : null,
      };
      db.signs.set(signId, sign);

      const reportId = newId("rp");
      const reporterToken = newId("rtk");
      const report = {
        id: reportId, sign_id: signId, link_confirmed: true,
        title: sign.title, language: lang,
        clause: String(body.clause ?? "").slice(0, 500),
        suggestion: String(body.suggestion ?? "").slice(0, 1000),
        location_precision: precision, location_authorized: authorized,
        ...point,
        dhashes: photoRecords.map(() => String(body.dhash ?? "0000000000000000").padStart(16, "0").slice(0, 16)),
        photo_ids: photoRecords.map((ph) => ph.id),
        reporter_contact: body.contact ? String(body.contact).slice(0, 100) : null,
        reporter_token: reporterToken,
        created_at: at,
      };
      // 支持每张照片独立 dhash
      if (Array.isArray(body.dhashes)) {
        report.dhashes = body.dhashes.map((d) => String(d).padStart(16, "0").slice(0, 16));
      }
      db.reports.set(reportId, report);
      addSiteVersion(sign, { label: "初次上报现场", note: report.suggestion, photoIds: report.photo_ids, at });

      // 相似检测 → 合并候选（绝不删除新线索，也不阻塞市民提交）
      const candidates = scanDuplicates(report);
      const candidateIds = [];
      for (const c of candidates.slice(0, 10)) {
        const mcId = newId("mc");
        db.mergeCandidates.set(mcId, {
          id: mcId, new_sign_id: signId, sign_id: c.sign.id, report_id: reportId,
          reasons: c.reasons, image_distance: c.image_distance,
          status: "pending", created_at: at, decided_by: null, decided_at: null,
        });
        candidateIds.push(mcId);
      }

      return json(res, 201, {
        report_id: reportId,
        sign_id: signId,
        // 查询令牌只回显一次，由市民自行保存；后台公开页面永不反查联系方式。
        track_token: reporterToken,
        merge_candidates: candidates.map((c) => ({
          target_sign_id: c.sign.id, title: c.sign.title, reasons: c.reasons,
        })),
        hint: candidateIds.length
          ? "系统发现相似标识，已列为合并候选，由外事部门人工确认；您的线索已独立保存，不会被删除。"
          : "线索已进入甄别队列。",
      });
    }

    // 市民凭令牌查询本人线索进展
    if (method === "POST" && p === "/api/track") {
      const body = await readBody(req).catch(() => ({}));
      const report = [...db.reports.values()].find((r) => r.reporter_token === body.token);
      if (!report) return fail(res, 404, "未找到线索，请核对查询号");
      const sign = db.signs.get(report.sign_id);
      const view = projectSign(db, sign, { role: "public" }, { ownReportId: report.id });
      return json(res, 200, { ...view, track_token: report.reporter_token });
    }

    // 志愿者：可领取的待译标识
    if (method === "GET" && p === "/api/volunteer/queue") {
      if (!requireRole(v, res, ["volunteer", "admin"])) return;
      const signs = [...db.signs.values()]
        .filter((s) => !s.merged_into && ["open", "awaiting_expert", "reopened", "expert_approved", "appealed"].includes(s.status))
        .map((s) => projectSign(db, s, v.user));
      return json(res, 200, { signs });
    }

    // 志愿者提交译法
    if (method === "POST" && /^\/api\/signs\/[^/]+\/proposals$/.test(p)) {
      if (!requireRole(v, res, ["volunteer"])) return;
      const signId = p.split("/")[3];
      const sign = db.signs.get(signId);
      if (!sign || sign.merged_into) return fail(res, 404, "标识不存在或已合并");
      const body = await readBody(req).catch(() => ({}));
      const language = String(body.language ?? "").trim();
      const text = String(body.text ?? "").trim();
      if (!text) return fail(res, 400, "译法内容不能为空");
      if (!sign.language_needs.includes(language)) return fail(res, 400, "该语种不在线索需求范围内");
      if (["triage", "rectified"].includes(sign.status)) return fail(res, 409, `当前状态（${sign.status}）不能提交译法`);
      const proposal = {
        id: newId("pp"), sign_id: signId, volunteer_id: v.user.id,
        language, text, rationale: String(body.rationale ?? "").slice(0, 500),
        created_at: nowIso(),
      };
      db.proposals.set(proposal.id, proposal);
      sign.proposal_ids.push(proposal.id);
      sign.status = "awaiting_expert";
      sign.updated_at = nowIso();
      return json(res, 201, proposal);
    }

    // 专家：待审定队列（含资格判定，前端据此灰掉冲突项）
    if (method === "GET" && p === "/api/expert/queue") {
      if (!requireRole(v, res, ["expert", "admin"])) return;
      const expert = v.user.role === "expert" ? v.user : null;
      const signs = [...db.signs.values()]
        .filter((s) => !s.merged_into && s.proposal_ids.length > 0 && s.status !== "rectified")
        .map((s) => {
          const view = projectSign(db, s, v.user);
          if (expert) {
            // 资格精确到每条译法的语种；标识级 eligibility 仅作摘要。
            view.eligibility = expertEligibility(expert, s);
            view.proposals = view.proposals.map((pp) => ({
              ...pp,
              eligibility: expertEligibility(expert, { ...s, language_needs: [pp.language] }),
            }));
          }
          return view;
        });
      return json(res, 200, { signs });
    }

    // 专家审定
    if (method === "POST" && /^\/api\/proposals\/[^/]+\/review$/.test(p)) {
      if (!requireRole(v, res, ["expert"])) return;
      const proposalId = p.split("/")[3];
      const proposal = db.proposals.get(proposalId);
      if (!proposal) return fail(res, 404, "译法不存在");
      const sign = db.signs.get(proposal.sign_id);
      const body = await readBody(req).catch(() => ({}));
      if (!["approved", "changes_requested"].includes(body.verdict)) return fail(res, 400, "审定结论不合法");

      // 资格按“当前译法的语种”判定；同时校验利益回避与身份。
      const eligibility = expertEligibility(v.user, { ...sign, language_needs: [proposal.language] });
      if (!eligibility.eligible) return fail(res, 403, "审定被拒绝", eligibility.reasons);
      if (proposal.volunteer_id === v.user.id) return fail(res, 403, "不得审定本人或本账号提交的译法");

      // 同一专家对同一译法只能审定一次
      const dup = [...db.reviews.values()].some((r) => r.proposal_id === proposalId && r.expert_id === v.user.id);
      if (dup) return fail(res, 409, "您已审定过该译法");

      const review = {
        id: newId("rv"), sign_id: sign.id, proposal_id: proposalId, expert_id: v.user.id,
        verdict: body.verdict, note: String(body.note ?? "").slice(0, 500), created_at: nowIso(),
      };
      db.reviews.set(review.id, review);
      sign.review_ids.push(review.id);
      if (body.verdict === "approved") sign.status = "expert_approved";
      sign.updated_at = nowIso();
      return json(res, 201, review);
    }

    // 设置单位：本单位队列
    if (method === "GET" && p === "/api/manager/queue") {
      if (!requireRole(v, res, ["manager", "admin"])) return;
      const signs = [...db.signs.values()]
        .filter((s) => !s.merged_into && (v.user.role === "admin" || s.owner_org === v.user.org))
        .map((s) => projectSign(db, s, v.user))
        .filter(Boolean);
      return json(res, 200, { org: v.user.org ?? "全部（主管视角）", signs });
    }

    // 设置单位响应：接受 / 申诉
    if (method === "POST" && /^\/api\/signs\/[^/]+\/respond$/.test(p)) {
      if (!requireRole(v, res, ["manager"])) return;
      const sign = db.signs.get(p.split("/")[3]);
      if (!sign) return fail(res, 404, "标识不存在");
      if (sign.owner_org !== v.user.org) return fail(res, 403, "该标识不属于您的单位");
      const body = await readBody(req).catch(() => ({}));
      if (!["accept", "appeal"].includes(body.action)) return fail(res, 400, "action 必须为 accept 或 appeal");
      if (body.action === "accept") {
        if (!["expert_approved", "appealed"].includes(sign.status)) return fail(res, 409, "仅审定通过后可接受");
        sign.status = "rectifying";
      } else {
        if (sign.status !== "expert_approved") return fail(res, 409, "仅审定通过后可申诉");
        sign.status = "appealed";
      }
      sign.updated_at = nowIso();
      const receipt = {
        id: newId("rc"), sign_id: sign.id, org: v.user.org, action: body.action,
        note: String(body.note ?? "").slice(0, 500), photo_ids: [], created_at: sign.updated_at,
      };
      db.receipts.set(receipt.id, receipt);
      sign.receipt_ids.push(receipt.id);
      return json(res, 201, receipt);
    }

    // 设置单位上传更换证明
    if (method === "POST" && /^\/api\/signs\/[^/]+\/proof$/.test(p)) {
      if (!requireRole(v, res, ["manager"])) return;
      const sign = db.signs.get(p.split("/")[3]);
      if (!sign) return fail(res, 404, "标识不存在");
      if (sign.owner_org !== v.user.org) return fail(res, 403, "该标识不属于您的单位");
      if (!["rectifying", "reopened"].includes(sign.status)) return fail(res, 409, "请先接受纠错意见，再上传更换证明");
      const body = await readBody(req).catch(() => ({}));
      if (!Array.isArray(body.photos) || body.photos.length === 0) return fail(res, 400, "更换证明须附现场照片");
      const at = nowIso();
      let photos;
      try { photos = body.photos.map((ph) => persistPhoto(ph, at)); }
      catch (e) { return fail(res, 400, e.message); }
      const receipt = {
        id: newId("rc"), sign_id: sign.id, org: v.user.org, action: "replace_proof",
        note: String(body.note ?? "").slice(0, 500), photo_ids: photos.map((x) => x.id), created_at: at,
      };
      db.receipts.set(receipt.id, receipt);
      sign.receipt_ids.push(receipt.id);
      sign.pending_recheck = true;
      sign.updated_at = at;
      return json(res, 201, { receipt, hint: "等待主管部门复查，复查将形成新的现场版本。" });
    }

    // 设置单位名录（主管部门派发用）
    if (method === "GET" && p === "/api/admin/orgs") {
      if (!requireRole(v, res, ["admin"])) return;
      const orgs = [...new Set([...db.users.values()].filter((u) => u.role === "manager" && u.org).map((u) => u.org))];
      return json(res, 200, { orgs });
    }

    // 主管部门：待甄别合并候选
    if (method === "GET" && p === "/api/admin/merge-candidates") {
      if (!requireRole(v, res, ["admin"])) return;
      const rows = [...db.mergeCandidates.values()]
        .filter((c) => c.status === "pending")
        .map((c) => ({
          ...c,
          new_sign: c.new_sign_id ? projectSign(db, db.signs.get(c.new_sign_id), v.user) : null,
          target_sign: projectSign(db, db.signs.get(c.sign_id), v.user),
        }));
      return json(res, 200, { candidates: rows });
    }

    // 主管部门：合并判定（merge=确认同一标识 / separate=保留为不同路牌）
    if (method === "POST" && /^\/api\/admin\/merge-candidates\/[^/]+\/decision$/.test(p)) {
      if (!requireRole(v, res, ["admin"])) return;
      const mc = db.mergeCandidates.get(p.split("/")[4]);
      if (!mc) return fail(res, 404, "候选不存在");
      if (mc.status !== "pending") return fail(res, 409, "该候选已判定");
      const body = await readBody(req).catch(() => ({}));
      const at = nowIso();
      if (body.decision === "merge") {
        const source = mc.new_sign_id ? db.signs.get(mc.new_sign_id) : null;
        const target = db.signs.get(mc.sign_id);
        if (source && source.id !== target.id) {
          // 把新标识下的线索与现场版本并入既有标识；源标识标记合并，不删除任何记录。
          for (const r of db.reports.values()) if (r.sign_id === source.id) r.sign_id = target.id;
          for (const sv of db.siteVersions.values()) if (sv.sign_id === source.id) sv.sign_id = target.id;
          for (const id of source.site_version_ids) target.site_version_ids.push(id);
          target.language_needs = [...new Set([...target.language_needs, ...source.language_needs])];
          source.status = "merged";
          source.merged_into = target.id;
          source.updated_at = at;
        }
        const report = db.reports.get(mc.report_id);
        if (report) report.link_confirmed = true;
        mc.status = "merged";
      } else if (body.decision === "separate") {
        mc.status = "separate";
        const source = mc.new_sign_id ? db.signs.get(mc.new_sign_id) : null;
        if (source && source.status === "triage") source.status = "open";
      } else {
        return fail(res, 400, "decision 必须为 merge 或 separate");
      }
      mc.decided_by = v.user.id;
      mc.decided_at = at;
      return json(res, 200, mc);
    }

    // 主管部门：分派设置单位（存在未决合并候选时禁止，避免重复派发）
    if (method === "POST" && /^\/api\/signs\/[^/]+\/dispatch$/.test(p)) {
      if (!requireRole(v, res, ["admin"])) return;
      const sign = db.signs.get(p.split("/")[3]);
      if (!sign) return fail(res, 404, "标识不存在");
      if (sign.merged_into) return fail(res, 409, "该标识已合并，无需分派");
      const blockers = pendingCandidatesFor(sign.id);
      if (blockers.length) return fail(res, 409, "仍有合并候选未人工确认，不得派发", { candidate_ids: blockers.map((c) => c.id) });
      const body = await readBody(req).catch(() => ({}));
      if (!body.owner_org) return fail(res, 400, "owner_org 必填");
      sign.owner_org = String(body.owner_org).slice(0, 100);
      if (sign.status === "triage") sign.status = "open";
      sign.updated_at = nowIso();
      return json(res, 200, projectSign(db, sign, v.user));
    }

    // 主管部门：申诉裁决
    if (method === "POST" && /^\/api\/signs\/[^/]+\/appeal-decision$/.test(p)) {
      if (!requireRole(v, res, ["admin"])) return;
      const sign = db.signs.get(p.split("/")[3]);
      if (!sign) return fail(res, 404, "标识不存在");
      if (sign.status !== "appealed") return fail(res, 409, "该标识不在申诉中");
      const body = await readBody(req).catch(() => ({}));
      sign.status = body.uphold ? "awaiting_expert" : "expert_approved";
      sign.updated_at = nowIso();
      return json(res, 200, projectSign(db, sign, v.user));
    }

    // 主管部门：复查（每次复查都形成新的现场版本）
    if (method === "POST" && /^\/api\/signs\/[^/]+\/recheck$/.test(p)) {
      if (!requireRole(v, res, ["admin"])) return;
      const sign = db.signs.get(p.split("/")[3]);
      if (!sign) return fail(res, 404, "标识不存在");
      const body = await readBody(req).catch(() => ({}));
      if (typeof body.pass !== "boolean") return fail(res, 400, "pass（true/false）必填");
      if (!Array.isArray(body.photos) || body.photos.length === 0) return fail(res, 400, "复查必须上传新的现场照片");
      const at = nowIso();
      let photos;
      try { photos = body.photos.map((ph) => persistPhoto(ph, at)); }
      catch (e) { return fail(res, 400, e.message); }
      const versionId = addSiteVersion(sign, {
        label: body.pass ? "整改后复查（通过）" : "整改后复查（不通过）",
        note: String(body.note ?? "").slice(0, 500),
        photoIds: photos.map((x) => x.id),
        at,
      });
      sign.pending_recheck = false;
      if (body.pass) {
        sign.status = "rectified";
        // 发布规范译法：取最近一次审定通过的译法
        const approvedReview = [...sign.review_ids]
          .reverse()
          .map((id) => db.reviews.get(id))
          .find((rv) => rv?.verdict === "approved");
        const proposal = approvedReview ? db.proposals.get(approvedReview.proposal_id) : null;
        sign.canonical_translation = proposal
          ? { text: proposal.text, language: proposal.language, review_id: approvedReview.id }
          : sign.canonical_translation;
      } else {
        sign.status = "reopened";
        sign.reopen_count += 1;
      }
      sign.updated_at = at;
      return json(res, 201, { site_version_id: versionId, sign: projectSign(db, sign, v.user) });
    }

    // 主管部门分析看板
    if (method === "GET" && p === "/api/admin/analytics") {
      if (!requireRole(v, res, ["admin"])) return;
      return json(res, 200, buildAnalytics(db));
    }

    // 标识详情（角色化投影）
    if (method === "GET" && /^\/api\/signs\/[^/]+$/.test(p)) {
      const sign = db.signs.get(p.split("/")[3]);
      if (!sign) return fail(res, 404, "标识不存在");
      if (v.user?.role === "manager" && sign.owner_org !== v.user.org) return fail(res, 403, "无权查看非本单位标识");
      if (!v.user && v.kind !== "reporter") {
        // 匿名公众只能看到公开摘要
        return json(res, 200, projectSign(db, sign, { role: "public" }));
      }
      const view = projectSign(db, sign, v.user ?? { role: "public" }, v.kind === "reporter" ? { ownReportId: v.ownReportId } : {});
      if (view === null) return fail(res, 403, "无权查看该标识");
      return json(res, 200, view);
    }

    return fail(res, 404, "接口不存在");
  }

  async function serveFile(res, name) {
    try {
      const data = await readFile(join(PUBLIC_DIR, name));
      const ext = name.slice(name.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // 联系方式等内部细节不随错误响应外泄
      json(res, 500, { error: "服务器内部错误" });
      console.error(err);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`城市外语标识纠错平台：http://127.0.0.1:${port}`);
  });
}
