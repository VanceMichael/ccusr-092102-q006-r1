// HTTP 服务：公众报错/进度/公开查询 + 志愿者/专家/单位/主管工作台 API。
// 所有出参经 privacy.js 序列化，联系方式与查询令牌不外发。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { SignService, HttpError, seedUsers } from "./domain.js";
import { publicSign, publicSignSummary } from "./privacy.js";

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const MAX_BODY = 12 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "请求体须为 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApp({ store, service }) {
  const userByToken = (req) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    return store.data.users.find((u) => u.token === token) ?? null;
  };
  const requireRole = (req, roles) => {
    const user = userByToken(req);
    if (!user) throw new HttpError(401, "缺少有效令牌");
    if (!roles.includes(user.role)) throw new HttpError(403, "当前角色无权访问");
    return user;
  };

  const routes = [
    ["GET", "/health", async () => ({ 状态: "服务已启动" })],

    // ---- 公众 ----
    ["POST", "/api/reports", async (req) => service.submitReport(await readBody(req))],
    ["GET", "/api/reports/:id/progress", async (req, _res, { id }, query) =>
      service.reportProgress(id, query.get("token") ?? "")],
    ["GET", "/api/signs/public", async () =>
      store.data.signs
        .filter((s) => s.status !== "已并入他案")
        .map(publicSignSummary)],
    ["GET", "/api/signs/:id/public", async (_req, _res, { id }) => {
      const sign = store.find("signs", id);
      if (!sign) throw new HttpError(404, "标识不存在");
      return publicSign(sign, store.data.versions, store.data.photos);
    }],

    // ---- 身份与角色队列 ----
    ["GET", "/api/me", async (req) => {
      const user = requireRole(req, ["volunteer", "expert", "unit", "supervisor"]);
      const { token, ...safe } = user;
      return safe;
    }],
    ["GET", "/api/queue/volunteer", async (req) => {
      requireRole(req, ["volunteer"]);
      return store.data.signs
        .filter((s) => ["待处理", "译法待审定"].includes(s.status))
        .map(publicSignSummary);
    }],
    ["POST", "/api/signs/:id/proposals", async (req, _res, { id }) => {
      const user = requireRole(req, ["volunteer"]);
      return service.proposeTranslation(user, id, await readBody(req));
    }],
    ["GET", "/api/queue/expert", async (req) => service.expertQueue(requireRole(req, ["expert"]))],
    ["POST", "/api/proposals/:id/review", async (req, _res, { id }) => {
      const user = requireRole(req, ["expert"]);
      return service.reviewProposal(user, id, await readBody(req));
    }],
    ["GET", "/api/queue/unit", async (req) => {
      const user = requireRole(req, ["unit"]);
      return store.data.signs
        .filter((s) => (user.affiliations ?? []).includes(s.setting_unit))
        .map(publicSignSummary);
    }],
    ["POST", "/api/signs/:id/respond", async (req, _res, { id }) => {
      const user = requireRole(req, ["unit"]);
      return service.unitRespond(user, id, await readBody(req));
    }],
    ["GET", "/api/merge-candidates", async (req) => {
      requireRole(req, ["supervisor"]);
      return store.data.merge_candidates;
    }],
    ["POST", "/api/merge-candidates/:id/resolve", async (req, _res, { id }) => {
      const user = requireRole(req, ["supervisor"]);
      const body = await readBody(req);
      return service.resolveMergeCandidate(user, id, body.action);
    }],
    ["POST", "/api/signs/:id/close", async (req, _res, { id }) => {
      requireRole(req, ["supervisor"]);
      return service.closeSign(null, id, await readBody(req));
    }],
    ["GET", "/api/analytics", async (req) => {
      requireRole(req, ["supervisor"]);
      return service.analytics();
    }],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const keys = [];
        const regex = new RegExp(
          `^${pattern.replace(/:([^/]+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`,
        );
        const match = regex.exec(url.pathname);
        if (!match) continue;
        const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
        json(res, 200, await handler(req, res, params, url.searchParams));
        return;
      }

      // 已脱敏照片
      const photoMatch = /^\/api\/photos\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && photoMatch) {
        const photo = store.find("photos", photoMatch[1]);
        if (!photo || !existsSync(photo.file)) throw new HttpError(404, "照片不存在");
        res.writeHead(200, { "content-type": photo.mime });
        res.end(readFileSync(photo.file));
        return;
      }

      // 静态页面
      if (req.method === "GET") {
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = join(PUBLIC_DIR, path);
        if (file.startsWith(PUBLIC_DIR) && existsSync(file) && MIME[extname(file)]) {
          res.writeHead(200, { "content-type": MIME[extname(file)] });
          res.end(await readFile(file));
          return;
        }
      }
      json(res, 404, { error: "接口不存在" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      json(res, 500, { error: "服务器内部错误" });
    }
  });
}

export function createServer(dataDir = join(process.cwd(), "data")) {
  const store = new Store(join(dataDir, "store.json")).load();
  seedUsers(store);
  const service = new SignService(store, join(dataDir, "photos"));
  return createApp({ store, service });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`外语标识纠错平台已启动: http://127.0.0.1:${port}`);
  });
}
