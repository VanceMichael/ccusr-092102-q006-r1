import http from "node:http";

export function createServer() {
  return http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ 状态: "服务已启动" }));
      return;
    }
    response.writeHead(404).end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "127.0.0.1");
}
