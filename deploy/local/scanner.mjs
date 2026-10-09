import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createConnection } from "node:net";

const apiKey = process.env.MALWARE_SCANNER_API_KEY;
if (!apiKey || apiKey.length < 32) throw new Error("Scanner API key must contain 32 or more characters.");
const expectedAuthorization = createHash("sha256").update(`Bearer ${apiKey}`).digest();
const maxBytes = 25 * 1024 * 1024;
// Local installation and on-prem production (PROD-308) share this adapter: clamd host/port and the TLS files are
// configurable; the defaults are the ones of docker-compose.local.yml.
const clamdHost = process.env.CLAMD_HOST || "clamav";
const clamdPort = Number(process.env.CLAMD_PORT || 3310);
const listenPort = Number(process.env.SCANNER_PORT || 9443);
const tlsKeyPath = process.env.SCANNER_TLS_KEY || "/certs/scanner.key";
const tlsCertPath = process.env.SCANNER_TLS_CERT || "/certs/scanner.crt";

function send(response, code, payload) {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function clamd(command, content) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: clamdHost, port: clamdPort });
    let reply = "";
    socket.setTimeout(20_000, () => socket.destroy(new Error("CLAMD_TIMEOUT")));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`z${command}\0`);
      if (!content) return;
      for (let offset = 0; offset < content.length; offset += 64 * 1024) {
        const chunk = content.subarray(offset, offset + 64 * 1024);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk) => {
      reply += chunk.toString("utf8");
      if (reply.length > 4096) socket.destroy(new Error("CLAMD_REPLY_TOO_LARGE"));
      else if (reply.includes("\0") || reply.includes("\n")) {
        resolve(reply.replace(/[\0\r\n]+$/, ""));
        socket.destroy();
      }
    });
    socket.once("end", () => {
      if (!reply.includes("\0") && !reply.includes("\n")) reject(new Error("CLAMD_INCOMPLETE_REPLY"));
    });
  });
}

async function handle(request, response) {
  if (request.method === "GET" && request.url === "/health") {
    if (await clamd("PING") !== "PONG") throw new Error("CLAMD_NOT_READY");
    send(response, 200, { status: "ready" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/scan") {
    send(response, 404, { status: "FAILED" });
    return;
  }
  const authorization = createHash("sha256").update(request.headers.authorization ?? "").digest();
  if (!timingSafeEqual(authorization, expectedAuthorization)) {
    send(response, 401, { status: "FAILED" });
    return;
  }
  const declaredMime = request.headers["x-declared-mime"];
  const checksum = request.headers["x-content-sha256"];
  const detectedMime = request.headers["x-detected-mime"] ?? declaredMime;
  if (typeof declaredMime !== "string" || declaredMime.length > 100 || typeof detectedMime !== "string" ||
      typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) {
    send(response, 400, { status: "FAILED" });
    return;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    send(response, 413, { status: "FAILED" });
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      send(response, 413, { status: "FAILED" });
      return;
    }
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (createHash("sha256").update(content).digest("hex") !== checksum) {
    send(response, 400, { status: "FAILED" });
    return;
  }
  const verdict = await clamd("INSTREAM", content);
  const status = verdict.endsWith(" FOUND") ? "QUARANTINED" :
    verdict === "stream: OK" ? (declaredMime === detectedMime ? "CLEAN" : "QUARANTINED") : "FAILED";
  send(response, status === "FAILED" ? 503 : 200, { status, detectedMime });
}

const server = createServer({
  key: readFileSync(tlsKeyPath),
  cert: readFileSync(tlsCertPath),
  minVersion: "TLSv1.2"
}, (request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) send(response, 503, { status: "FAILED" });
    else response.destroy();
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(listenPort, "0.0.0.0", () => console.log(JSON.stringify({ event: "scanner.ready", backend: "clamav", clamd: `${clamdHost}:${clamdPort}` })));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close());
}
