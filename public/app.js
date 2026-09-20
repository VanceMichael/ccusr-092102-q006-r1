// 移动端单页应用：报错提交（含遮蔽编辑）、我的线索、公开查询、角色工作台。

const $ = (sel) => document.querySelector(sel);

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败(${res.status})`);
  return data;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------- 遮蔽编辑器 ----------------
// 人脸/车牌遮蔽在上传前于本机画布完成，服务器只接收遮蔽后的图像。
class MaskEditor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.boxes = [];
    this.img = null;
    this.draft = null;
    this.#bindPointer();
  }

  async load(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / bitmap.width);
    this.canvas.width = Math.round(bitmap.width * scale);
    this.canvas.height = Math.round(bitmap.height * scale);
    this.img = bitmap;
    this.boxes = [];
    this.redraw();
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.drawImage(this.img, 0, 0, canvas.width, canvas.height);
    for (const b of [...this.boxes, ...(this.draft ? [this.draft] : [])]) {
      ctx.fillStyle = "rgba(11, 92, 173, 0.35)";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = "#0b5cad";
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
  }

  #pos(evt) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((evt.clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((evt.clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  #bindPointer() {
    let start = null;
    this.canvas.addEventListener("pointerdown", (evt) => {
      if (!this.img) return;
      this.canvas.setPointerCapture(evt.pointerId);
      start = this.#pos(evt);
    });
    this.canvas.addEventListener("pointermove", (evt) => {
      if (!start) return;
      const p = this.#pos(evt);
      this.draft = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      this.redraw();
    });
    this.canvas.addEventListener("pointerup", () => {
      if (this.draft && this.draft.w > 8 && this.draft.h > 8) this.boxes.push(this.draft);
      this.draft = null;
      start = null;
      this.redraw();
    });
  }

  // 经验建议区域（画面下方车牌高发区、上方人脸高发区），仅供市民参考确认。
  suggest() {
    const { width: w, height: h } = this.canvas;
    this.boxes.push(
      { x: w * 0.55, y: h * 0.72, w: w * 0.4, h: h * 0.2 },
      { x: w * 0.05, y: h * 0.05, w: w * 0.25, h: h * 0.25 },
    );
    this.redraw();
  }

  undo() {
    this.boxes.pop();
    this.redraw();
  }

  // 应用遮蔽：把遮蔽框涂黑，之后导出的图像不再包含原始像素。
  apply() {
    this.ctx.fillStyle = "#000";
    for (const b of this.boxes) this.ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  normalizedBoxes() {
    const { width: w, height: h } = this.canvas;
    return this.boxes.map((b) => ({
      x: +(b.x / w).toFixed(4),
      y: +(b.y / h).toFixed(4),
      w: +(b.w / w).toFixed(4),
      h: +(b.h / h).toFixed(4),
    }));
  }

  // 64 位感知哈希（dHash），随图上传，仅用于提出合并候选。
  dhash() {
    const off = document.createElement("canvas");
    off.width = 9;
    off.height = 8;
    const octx = off.getContext("2d");
    octx.drawImage(this.canvas, 0, 0, 9, 8);
    const { data } = octx.getImageData(0, 0, 9, 8);
    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
      gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    let hex = "";
    for (let row = 0; row < 8; row++) {
      let byte = 0;
      for (let col = 0; col < 8; col++) {
        byte = (byte << 1) | (gray[row * 9 + col] > gray[row * 9 + col + 1] ? 1 : 0);
      }
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }

  toDataURL() {
    return this.canvas.toDataURL("image/jpeg", 0.85);
  }
}

// ---------------- 标签页 ----------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "mine") renderMyReports();
    if (btn.dataset.tab === "public") loadPublic();
  });
});

// ---------------- 报错 ----------------
const editor = new MaskEditor($("#mask-canvas"));
let photoReady = false;

$("#photo-input").addEventListener("change", async (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  await editor.load(file);
  $("#mask-editor").classList.remove("hidden");
  photoReady = false;
});
$("#suggest-masks").addEventListener("click", () => editor.suggest());
$("#undo-mask").addEventListener("click", () => editor.undo());
$("#apply-masks").addEventListener("click", () => {
  editor.apply();
  photoReady = true;
  alert("遮蔽已应用，可提交。");
});

const authorizedBox = $("#location-authorized");
authorizedBox.addEventListener("change", () => {
  $("#precision").disabled = !authorizedBox.checked;
  $("#get-location").disabled = !authorizedBox.checked;
  $("#location-status").textContent = authorizedBox.checked
    ? "将按所选精度保留坐标，公众页面最多展示街道级。"
    : "未授权时平台不保存任何坐标。";
});

let coords = null;
$("#get-location").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $("#location-status").textContent = `已获取定位（${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}），提交时按精度截断。`;
    },
    () => ($("#location-status").textContent = "定位失败，可仍提交，平台不保存坐标。"),
    { timeout: 8000 },
  );
});

$("#report-form").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  try {
    if (!photoReady && !$("#no-mask-confirm").checked) {
      alert("请先应用遮蔽，或勾选确认无需遮蔽。");
      return;
    }
    const body = {
      photo: {
        data_url: editor.toDataURL(),
        dhash: editor.dhash(),
        masks: editor.normalizedBoxes(),
        no_mask_confirmed: $("#no-mask-confirm").checked,
      },
      language: $("#language").value,
      suggestion: $("#suggestion").value,
      norm_clauses: $("#norm-clauses").value.split("\n").map((s) => s.trim()).filter(Boolean),
      setting_unit: $("#setting-unit").value,
      contact: $("#contact").value,
      location_authorized: authorizedBox.checked,
      precision: $("#precision").value,
      ...(coords ?? {}),
    };
    const result = await api("/api/reports", { method: "POST", body });
    const mine = JSON.parse(localStorage.getItem("myReports") ?? "[]");
    mine.push({ report_id: result.report_id, reporter_token: result.reporter_token, at: new Date().toISOString() });
    localStorage.setItem("myReports", JSON.stringify(mine));
    const box = $("#report-result");
    box.classList.remove("hidden");
    box.innerHTML = `<h3>提交成功</h3>
      <p>线索编号：<code>${esc(result.report_id)}</code></p>
      <p>查询令牌：<code>${esc(result.reporter_token)}</code>（已保存在本机浏览器）</p>
      ${result.merge_candidates > 0 ? `<p class="hint">发现 ${result.merge_candidates} 条疑似重复线索，已提交主管部门裁决，不会影响您的线索。</p>` : ""}`;
    evt.target.reset();
    photoReady = false;
  } catch (err) {
    alert(err.message);
  }
});

// ---------------- 我的线索 ----------------
async function renderMyReports() {
  const mine = JSON.parse(localStorage.getItem("myReports") ?? "[]");
  const box = $("#my-reports");
  if (mine.length === 0) {
    box.innerHTML = `<p class="hint">暂无提交记录。</p>`;
    return;
  }
  const cards = await Promise.all(
    mine.map(async (item) => {
      try {
        const p = await api(`/api/reports/${item.report_id}/progress?token=${encodeURIComponent(item.reporter_token)}`);
        const sign = p.sign;
        return `<div class="card">
          <span class="badge ${sign?.status === "已办结" ? "done" : "open"}">${esc(p.status)}</span>
          <span class="badge">${esc(sign?.status ?? "")}</span>
          <h3>线索 ${esc(p.report_id)}</h3>
          <p class="meta">提交于 ${esc(new Date(p.submitted_at).toLocaleString("zh-CN"))} · 设置单位：${esc(sign?.setting_unit ?? "待确认")} · 现场版本 ${sign?.site_versions ?? 0} 个</p>
          ${sign?.standard_translation ? `<p>规范译法：<span class="translation">${esc(sign.standard_translation)}</span></p>` : ""}
        </div>`;
      } catch (err) {
        return `<div class="card"><h3>线索 ${esc(item.report_id)}</h3><p class="meta">${esc(err.message)}</p></div>`;
      }
    }),
  );
  box.innerHTML = cards.join("");
}

// ---------------- 公开查询 ----------------
async function loadPublic() {
  const list = await api("/api/signs/public");
  $("#public-list").innerHTML = list
    .map(
      (s) => `<div class="card">
        <span class="badge ${s.status === "已办结" ? "done" : "open"}">${esc(s.status)}</span>
        <h3>${esc(s.setting_unit)} · ${esc(s.languages.join("/"))}</h3>
        ${s.standard_translation ? `<p>规范译法：<span class="translation">${esc(s.standard_translation)}</span></p>` : ""}
        <p class="meta">${s.location ? `位置（${esc(s.location.precision)}）：${s.location.lat}, ${s.location.lng}` : "位置未公开"}</p>
        <button class="btn ghost" data-sign="${esc(s.id)}">查看详情</button>
      </div>`,
    )
    .join("");
}
$("#reload-public").addEventListener("click", loadPublic);
$("#public-list").addEventListener("click", async (evt) => {
  const id = evt.target.dataset?.sign;
  if (!id) return;
  const d = await api(`/api/signs/${id}/public`);
  $("#public-detail").innerHTML = `<div class="card">
    <h3>标识详情</h3>
    <p class="meta">设置单位：${esc(d.setting_unit)} ｜ 状态：${esc(d.status)}</p>
    <p class="meta">规范条款：${d.norm_clauses.length ? esc(d.norm_clauses.join("；")) : "暂无"}</p>
    ${d.standard_translation ? `<p>规范译法：<span class="translation">${esc(d.standard_translation)}</span></p>` : ""}
    ${d.versions
      .map(
        (v) => `<div class="card">
          <span class="badge">第${v.seq}版现场</span><span class="meta">${esc(v.source)} · ${esc(new Date(v.created_at).toLocaleString("zh-CN"))}</span>
          ${v.note ? `<p>${esc(v.note)}</p>` : ""}
          ${v.photos.map((p) => `<img src="${p.url}" alt="现场照片（已脱敏）" loading="lazy">`).join("")}
        </div>`,
      )
      .join("")}
  </div>`;
});

// ---------------- 工作台 ----------------
let workToken = localStorage.getItem("workToken") ?? "";
$("#work-token").value = workToken;
$("#work-login").addEventListener("click", () => {
  workToken = $("#work-token").value.trim();
  localStorage.setItem("workToken", workToken);
  renderWorkbench();
});

async function renderWorkbench() {
  const box = $("#workbench");
  if (!workToken) return (box.innerHTML = "");
  let me;
  try {
    me = await api("/api/me", { token: workToken });
  } catch (err) {
    return (box.innerHTML = `<p class="hint">${esc(err.message)}</p>`);
  }
  const renderers = { volunteer: renderVolunteer, expert: renderExpert, unit: renderUnit, supervisor: renderSupervisor };
  box.innerHTML = `<div class="card"><h3>${esc(me.name)}</h3><p class="meta">角色：${esc(me.role)}</p></div><div id="role-area"></div>`;
  await renderers[me.role]?.($("#role-area"));
}

async function renderVolunteer(box) {
  const signs = await api("/api/queue/volunteer", { token: workToken });
  box.innerHTML = signs
    .map(
      (s) => `<div class="card">
        <span class="badge open">${esc(s.status)}</span>
        <h3>${esc(s.setting_unit)} · ${esc(s.languages.join("/"))}</h3>
        <p class="meta">条款：${esc(s.norm_clauses.join("；") || "暂无")}</p>
        <input class="small" data-field="translation" placeholder="建议译法">
        <input class="small" data-field="clauses" placeholder="依据条款（顿号分隔，可选）">
        <textarea class="small" data-field="note" placeholder="说明（可选）"></textarea>
        <button class="btn primary" data-propose="${esc(s.id)}" data-lang="${esc(s.languages[0])}">提交译法</button>
      </div>`,
    )
    .join("") || `<p class="hint">暂无待处理标识。</p>`;
  box.onclick = async (evt) => {
    const id = evt.target.dataset?.propose;
    if (!id) return;
    const card = evt.target.closest(".card");
    const val = (f) => card.querySelector(`[data-field="${f}"]`).value.trim();
    try {
      await api(`/api/signs/${id}/proposals`, {
        method: "POST",
        token: workToken,
        body: {
          language: evt.target.dataset.lang,
          translation: val("translation"),
          note: val("note"),
          norm_clauses: val("clauses").split(/[、；;]/).filter(Boolean),
        },
      });
      alert("译法已提交，等待专家审定。");
      renderWorkbench();
    } catch (err) {
      alert(err.message);
    }
  };
}

async function renderExpert(box) {
  const queue = await api("/api/queue/expert", { token: workToken });
  box.innerHTML =
    queue
      .map(
        (p) => `<div class="card">
        <span class="badge">${esc(p.language)}</span><span class="badge">${p.round > 1 ? "申诉复核" : "一审"}</span>
        <h3>${esc(p.translation)}</h3>
        <p class="meta">设置单位：${esc(p.setting_unit)} ｜ 志愿者说明：${esc(p.note || "无")}</p>
        ${
          p.eligibility.ok
            ? `<textarea class="small" data-field="comment" placeholder="审定意见"></textarea>
               <div class="row">
                 <button class="btn primary" data-review="${esc(p.id)}" data-decision="通过">通过</button>
                 <button class="btn danger" data-review="${esc(p.id)}" data-decision="不通过">不通过</button>
               </div>`
            : `<p class="meta">不可审定：${esc(p.eligibility.reason)}</p>`
        }
      </div>`,
      )
      .join("") || `<p class="hint">暂无待审定译法。</p>`;
  box.onclick = async (evt) => {
    const id = evt.target.dataset?.review;
    if (!id) return;
    const card = evt.target.closest(".card");
    try {
      await api(`/api/proposals/${id}/review`, {
        method: "POST",
        token: workToken,
        body: { decision: evt.target.dataset.decision, comment: card.querySelector('[data-field="comment"]').value },
      });
      alert("审定已记录。");
      renderWorkbench();
    } catch (err) {
      alert(err.message);
    }
  };
}

async function renderUnit(box) {
  const signs = await api("/api/queue/unit", { token: workToken });
  box.innerHTML =
    signs
      .map(
        (s) => `<div class="card">
        <span class="badge ${s.status === "已办结" ? "done" : "open"}">${esc(s.status)}</span>
        <h3>${esc(s.id)}</h3>
        ${s.standard_translation ? `<p>规范译法：<span class="translation">${esc(s.standard_translation)}</span></p>` : ""}
        <textarea class="small" data-field="note" placeholder="回执说明"></textarea>
        <div class="row">
          <button class="btn primary" data-respond="accept" data-sign="${esc(s.id)}">接受整改</button>
          <button class="btn ghost" data-respond="appeal" data-sign="${esc(s.id)}">申诉</button>
        </div>
        <details>
          <summary>上传更换证明（形成新现场版本）</summary>
          <input type="file" accept="image/*" data-field="proof">
          <label class="check"><input type="checkbox" data-field="proof-nomask"> 照片无需遮蔽</label>
          <button class="btn primary" data-respond="proof" data-sign="${esc(s.id)}">提交证明</button>
        </details>
      </div>`,
      )
      .join("") || `<p class="hint">暂无本单位名下标识。</p>`;
  box.onclick = async (evt) => {
    const action = evt.target.dataset?.respond;
    if (!action) return;
    const card = evt.target.closest(".card");
    const note = card.querySelector('[data-field="note"]').value;
    const body = { action, note };
    try {
      if (action === "proof") {
        const file = card.querySelector('[data-field="proof"]').files[0];
        if (!file) throw new Error("请选择整改后的现场照片");
        const dataUrl = await fileToMaskedDataURL(file);
        body.photo = { ...dataUrl, no_mask_confirmed: card.querySelector('[data-field="proof-nomask"]').checked };
      }
      await api(`/api/signs/${evt.target.dataset.sign}/respond`, { method: "POST", token: workToken, body });
      alert("已提交。");
      renderWorkbench();
    } catch (err) {
      alert(err.message);
    }
  };
}

// 单位整改照片同样先在本机做遮蔽再上传。
async function fileToMaskedDataURL(file) {
  const canvas = document.createElement("canvas");
  const ed = new MaskEditor(canvas);
  await ed.load(file);
  ed.suggest();
  ed.apply();
  return { data_url: ed.toDataURL(), dhash: ed.dhash(), masks: ed.normalizedBoxes() };
}

async function renderSupervisor(box) {
  const [candidates, stats, signs] = await Promise.all([
    api("/api/merge-candidates", { token: workToken }),
    api("/api/analytics", { token: workToken }),
    api("/api/signs/public"),
  ]);
  const pending = candidates.filter((c) => c.status === "待裁决");
  box.innerHTML = `
    <div class="card"><h3>合并候选（仅建议，不自动删除）</h3>
      ${pending
        .map(
          (c) => `<div class="card">
            <p class="meta">线索 ${esc(c.report_id)}：${esc(c.from_sign_id)} → ${esc(c.to_sign_id)}</p>
            <p class="meta">依据：${esc(c.reasons.join("；"))}</p>
            <div class="row">
              <button class="btn primary" data-merge="${esc(c.id)}" data-action="merge">确认合并</button>
              <button class="btn ghost" data-merge="${esc(c.id)}" data-action="keep">保留各自独立</button>
            </div>
          </div>`,
        )
        .join("") || `<p class="hint">暂无待裁决候选。</p>`}
    </div>
    <div class="card"><h3>待复查办结</h3>
      ${signs
        .filter((s) => s.status === "复查中")
        .map((s) => `<div class="row"><span>${esc(s.id)}（${esc(s.setting_unit)}）</span><button class="btn primary" data-close="${esc(s.id)}">复查通过</button></div>`)
        .join("") || `<p class="hint">暂无。</p>`}
    </div>
    <div class="card"><h3>区域办理情况</h3>
      <table class="stats"><tr><th>区域</th><th>总数</th><th>未办结</th><th>超期</th><th>反复出错</th></tr>
      ${stats.regions
        .map((r) => `<tr><td>${esc(r.region)}</td><td>${r.total}</td><td>${r.open}</td><td>${r.overdue}</td><td>${r.repeat_error}</td></tr>`)
        .join("")}
      </table>
    </div>
    <div class="card"><h3>专家资源</h3>
      <table class="stats"><tr><th>语种</th><th>待审定</th><th>可用专家</th><th>缺口</th></tr>
      ${stats.expert_load
        .map((e) => `<tr><td>${esc(e.language)}</td><td>${e.pending_proposals}</td><td>${e.eligible_experts}</td><td>${e.shortage ? "不足" : "—"}</td></tr>`)
        .join("")}
      </table>
    </div>`;
  box.onclick = async (evt) => {
    try {
      if (evt.target.dataset?.merge) {
        await api(`/api/merge-candidates/${evt.target.dataset.merge}/resolve`, {
          method: "POST",
          token: workToken,
          body: { action: evt.target.dataset.action },
        });
      } else if (evt.target.dataset?.close) {
        await api(`/api/signs/${evt.target.dataset.close}/close`, { method: "POST", token: workToken, body: {} });
      } else return;
      alert("已处理。");
      renderWorkbench();
    } catch (err) {
      alert(err.message);
    }
  };
}

if (workToken) renderWorkbench();
