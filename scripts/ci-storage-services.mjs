import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const host = process.env.CI_STORAGE_SERVICES_HOST ?? "127.0.0.1";
const bucket = required(process.env.STORAGE_BUCKET, "STORAGE_BUCKET");
const accessKey = required(process.env.STORAGE_ACCESS_KEY, "STORAGE_ACCESS_KEY");
required(process.env.STORAGE_SECRET_KEY, "STORAGE_SECRET_KEY");
const scannerApiKey = required(process.env.MALWARE_SCANNER_API_KEY, "MALWARE_SCANNER_API_KEY");
const s3PortFile = process.env.CI_S3_PORT_FILE ?? ".ci-e2e-s3.port";
const scannerPortFile = process.env.CI_SCANNER_PORT_FILE ?? ".ci-e2e-scanner.port";
const scannerKeyFile = required(process.env.CI_SCANNER_KEY_FILE, "CI_SCANNER_KEY_FILE");
const scannerCertFile = required(process.env.CI_SCANNER_CERT_FILE, "CI_SCANNER_CERT_FILE");
const objects = new Map();
const servers = [];
let shuttingDown = false;

const scannerCredentials = await Promise.all([readFile(scannerKeyFile), readFile(scannerCertFile)]);
const s3Server = createHttpServer((request, response) => {
  void handleS3(request, response).catch((error) => {
    console.error(`S3 service error: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
const scannerServer = createHttpsServer({ key: scannerCredentials[0], cert: scannerCredentials[1] }, (request, response) => {
  void handleScanner(request, response).catch((error) => {
    console.error(`Scanner service error: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
servers.push(s3Server, scannerServer);

await Promise.all([listen(s3Server), listen(scannerServer)]);
await Promise.all([
  writeFile(s3PortFile, String(s3Server.address().port)),
  writeFile(scannerPortFile, String(scannerServer.address().port))
]);
console.log(`S3-compatible service listening on ${host}:${s3Server.address().port} for bucket ${bucket}`);
console.log(`HTTPS scanner service listening on ${host}:${scannerServer.address().port}`);

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

async function handleS3(request, response) {
  const parsed = new URL(request.url ?? "/", `http://${host}`);
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== bucket || !authorized(request)) {
    sendS3Error(response, 403, "AccessDenied");
    return;
  }
  const key = parts.slice(1).join("/");
  if (!key) {
    if (request.method === "HEAD") {
      response.writeHead(200, { "x-amz-bucket-region": "us-east-1" });
      response.end();
      return;
    }
    sendS3Error(response, 405, "MethodNotAllowed");
    return;
  }
  if (request.method === "PUT") {
    const content = await readBody(request, 25 * 1024 * 1024);
    objects.set(key, content);
    response.writeHead(200, { etag: `"${createHash("md5").update(content).digest("hex")}"` });
    response.end();
    return;
  }
  if (request.method === "GET") {
    const content = objects.get(key);
    if (!content) {
      sendS3Error(response, 404, "NoSuchKey");
      return;
    }
    response.writeHead(200, { "content-length": content.byteLength, "content-type": "application/octet-stream" });
    response.end(content);
    return;
  }
  if (request.method === "HEAD") {
    const content = objects.get(key);
    if (!content) {
      sendS3Error(response, 404, "NotFound");
      return;
    }
    response.writeHead(200, { "content-length": content.byteLength });
    response.end();
    return;
  }
  if (request.method === "DELETE") {
    objects.delete(key);
    response.writeHead(204);
    response.end();
    return;
  }
  sendS3Error(response, 405, "MethodNotAllowed");
}

async function handleScanner(request, response) {
  const parsed = new URL(request.url ?? "/", `https://${host}`);
  if (request.method !== "POST" || parsed.pathname !== "/scan" || request.headers.authorization !== `Bearer ${scannerApiKey}`) {
    response.writeHead(404);
    response.end();
    return;
  }
  const content = await readBody(request, 25 * 1024 * 1024);
  const declaredMime = request.headers["x-declared-mime"];
  const claimedChecksum = request.headers["x-content-sha256"];
  const actualChecksum = createHash("sha256").update(content).digest("hex");
  if (typeof declaredMime !== "string" || typeof claimedChecksum !== "string" || claimedChecksum !== actualChecksum) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "FAILED", detectedMime: "application/octet-stream" }));
    return;
  }
  const status = content.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) ? "QUARANTINED" : "CLEAN";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status, detectedMime: declaredMime }));
}

function authorized(request) {
  const authorization = request.headers.authorization ?? "";
  return authorization.includes(`Credential=${accessKey}/`) || authorization.includes(`Credential=${accessKey},`);
}

function sendS3Error(response, status, code) {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(`<Error><Code>${code}</Code></Error>`);
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new Error("request body exceeds CI service limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0 }, resolve);
  });
}

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  await Promise.all([unlink(s3PortFile).catch(() => undefined), unlink(scannerPortFile).catch(() => undefined)]);
  process.exitCode = exitCode;
}
