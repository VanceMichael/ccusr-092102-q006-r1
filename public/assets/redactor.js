// 手机端照片遮蔽编辑器：
// - 在照片上手绘矩形框选无关人脸 / 车牌，烧录为像素马赛克后再上传（服务器只收到遮蔽版）
// - 同时计算 64 位 dHash（十六进制串），供服务端做“只提议不删除”的相似比对
// 纯 Canvas 实现，无第三方依赖。

const MAX_W = 900;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片读取失败")); };
    img.src = url;
  });
}

// dHash：缩放为 9×8 灰度，逐行比较相邻列亮度，共 64 位。
export function computeDhash(sourceCanvas) {
  const c = document.createElement("canvas");
  c.width = 9; c.height = 8;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const gray = (x, y) => (d[(y * 9 + x) * 4] * 299 + d[(y * 9 + x) * 4 + 1] * 587 + d[(y * 9 + x) * 4 + 2] * 114) / 1000;
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += gray(x, y) < gray(x + 1, y) ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

// 把矩形区域烧成马赛克（就地修改 canvas）。
function mosaic(ctx, x, y, w, h) {
  const size = Math.max(6, Math.round(Math.min(w, h) / 6));
  for (let sy = y; sy < y + h; sy += size) {
    for (let sx = x; sx < x + w; sx += size) {
      const pw = Math.min(size, x + w - sx);
      const ph = Math.min(size, y + h - sy);
      const p = ctx.getImageData(sx, sy, pw, ph).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < p.length; i += 4) { r += p[i]; g += p[i + 1]; b += p[i + 2]; n++; }
      ctx.fillStyle = `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`;
      ctx.fillRect(sx, sy, pw, ph);
    }
  }
}

export async function openRedactionEditor(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_W / img.naturalWidth);
  const W = Math.round(img.naturalWidth * scale);
  const H = Math.round(img.naturalHeight * scale);

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `
      <div class="modal">
        <h3>遮蔽无关人脸与车牌</h3>
        <p class="hint">在照片上拖动框选路人面部、车牌号等；上传的图片只保留打码后的版本。标识本身请勿遮挡。</p>
        <div class="kind-toggle">
          <button type="button" data-kind="face" class="on">🙈 人脸</button>
          <button type="button" data-kind="plate" class="plate">🚗 车牌</button>
        </div>
        <div class="edit-canvas-wrap">
          <canvas width="${W}" height="${H}"></canvas>
        </div>
        <div class="actions" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button type="button" class="btn ghost" data-act="undo">撤销上一框</button>
          <button type="button" class="btn ghost" data-act="cancel">取消</button>
          <button type="button" class="btn" data-act="save" style="flex:1">确认遮蔽并使用</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const canvas = mask.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);

    let kind = "face";
    const boxes = []; // 像素坐标
    let start = null;
    let cur = null;

    const paint = () => {
      ctx.drawImage(img, 0, 0, W, H);
      for (const b of boxes) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = b.kind === "face" ? "#e74c3c" : "#7a4fd0";
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      if (cur) {
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = kind === "face" ? "#e74c3c" : "#7a4fd0";
        ctx.strokeRect(cur.x, cur.y, cur.w, cur.h);
        ctx.setLineDash([]);
      }
    };
    paint();

    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return {
        x: Math.max(0, Math.min(W, (p.clientX - rect.left) * (W / rect.width))),
        y: Math.max(0, Math.min(H, (p.clientY - rect.top) * (H / rect.height))),
      };
    };
    const down = (e) => { e.preventDefault(); start = pos(e); cur = { ...start, w: 0, h: 0 }; paint(); };
    const move = (e) => {
      if (!start) return;
      e.preventDefault();
      const q = pos(e);
      cur = { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) };
      paint();
    };
    const up = () => {
      if (cur && cur.w > 8 && cur.h > 8) { boxes.push({ ...cur, kind }); cur = null; paint(); }
      start = null;
    };
    canvas.addEventListener("mousedown", down);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", up);

    mask.querySelectorAll(".kind-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        kind = btn.dataset.kind;
        mask.querySelectorAll(".kind-toggle button").forEach((b) => b.classList.toggle("on", b === btn));
      });
    });
    mask.addEventListener("click", (e) => {
      const act = e.target.dataset.act;
      if (act === "cancel") { close(); resolve(null); }
      if (act === "undo") { boxes.pop(); paint(); }
      if (act === "save") {
        // 烧录马赛克
        for (const b of boxes) mosaic(ctx, b.x, b.y, b.w, b.h);
        const dhash = computeDhash(canvas);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        const percentBoxes = boxes.map((b) => ({
          kind: b.kind,
          x: +(b.x / W * 100).toFixed(2), y: +(b.y / H * 100).toFixed(2),
          w: +(b.w / W * 100).toFixed(2), h: +(b.h / H * 100).toFixed(2),
        }));
        close();
        resolve({ data_url: dataUrl, boxes: percentBoxes, width: W, height: H, dhash });
      }
    });
    function close() {
      window.removeEventListener("mouseup", up);
      mask.remove();
    }
  });
}
