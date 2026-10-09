// PROD-308: the HTTPS scanner adapter (deploy/local/scanner.mjs) against a fake clamd. Proves the contract the app relies
// on: a file clamd flags is QUARANTINED (never CLEAN), MIME divergence is QUARANTINED, a wrong key is refused, a
// checksum mismatch is refused, and the adapter is configurable (CLAMD_HOST/PORT, SCANNER_PORT, TLS paths).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
// Built at runtime so the test file itself is not an antivirus signature.
const eicar = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "!$H+H*"].join("");

function fakeClamd() {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.subarray(0, 6).toString() === "zPING\0") {
        socket.end("PONG\0");
        return;
      }
      if (buffer.subarray(0, 10).toString() !== "zINSTREAM\0") return;
      // Chunks: 4-byte big-endian length + payload, terminated by a zero length.
      let offset = 10;
      const parts = [];
      while (offset + 4 <= buffer.length) {
        const size = buffer.readUInt32BE(offset);
        if (size === 0) {
          const content = Buffer.concat(parts);
          socket.end(content.includes(Buffer.from(eicar)) ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "stream: OK\0");
          return;
        }
        if (offset + 4 + size > buffer.length) return;
        parts.push(buffer.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function certificates(dir) {
  const run = (args) => { const r = spawnSync("openssl", args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "scanner.key"),
    "-out", path.join(dir, "scanner.crt"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
  return { key: path.join(dir, "scanner.key"), cert: path.join(dir, "scanner.crt") };
}

function freePort() {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function post(port, ca, { body, key, declared, detected, checksum, method = "POST", url = "/scan" }) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": declared ?? "application/octet-stream", "x-content-sha256": checksum ?? createHash("sha256").update(body ?? "").digest("hex") };
    if (key) headers.authorization = `Bearer ${key}`;
    if (declared) headers["x-declared-mime"] = declared;
    if (detected) headers["x-detected-mime"] = detected;
    const req = httpsRequest({ host: "127.0.0.1", port, method, path: url, ca, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("scanner adapter quarantines what clamd flags and refuses bad callers", { skip: !hasOpenssl && "openssl missing" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-scanner-test-"));
  const { server: clamd, port: clamdPort } = await fakeClamd();
  const tls = certificates(dir);
  const port = await freePort();
  const apiKey = createHash("sha256").update(`scanner-test-${process.pid}`).digest("hex");
  const child = spawn(process.execPath, [path.join(root, "deploy/local/scanner.mjs")], {
    env: { PATH: process.env.PATH, MALWARE_SCANNER_API_KEY: apiKey, CLAMD_HOST: "127.0.0.1", CLAMD_PORT: String(clamdPort), SCANNER_PORT: String(port), SCANNER_TLS_KEY: tls.key, SCANNER_TLS_CERT: tls.cert },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`scanner did not start: ${stderr}`)), 10_000);
      child.stdout.on("data", () => { if (stdout.includes("scanner.ready")) { clearTimeout(timer); resolve(); } });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`scanner exited ${code}: ${stderr}`)); });
    });
    const ready = JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(ready.clamd, `127.0.0.1:${clamdPort}`);
    const ca = readFileSync(tls.cert);

    const health = await post(port, ca, { method: "GET", url: "/health" });
    assert.equal(health.status, 200);

    const clean = await post(port, ca, { body: "%PDF-1.4 clean report", key: apiKey, declared: "application/pdf", detected: "application/pdf" });
    assert.deepEqual(clean, { status: 200, body: { status: "CLEAN", detectedMime: "application/pdf" } });

    const flagged = await post(port, ca, { body: eicar, key: apiKey, declared: "application/pdf", detected: "application/pdf" });
    assert.equal(flagged.status, 200);
    assert.equal(flagged.body.status, "QUARANTINED", "a file clamd flags is never CLEAN");

    const mismatch = await post(port, ca, { body: "clean bytes", key: apiKey, declared: "application/pdf", detected: "image/png" });
    assert.equal(mismatch.body.status, "QUARANTINED", "declared and detected MIME must agree");

    const wrongKey = await post(port, ca, { body: "clean bytes", key: `${apiKey.slice(0, -1)}0`, declared: "application/pdf" });
    assert.equal(wrongKey.status, 401);
    const noKey = await post(port, ca, { body: "clean bytes", declared: "application/pdf" });
    assert.equal(noKey.status, 401);

    const badChecksum = await post(port, ca, { body: "clean bytes", key: apiKey, declared: "application/pdf", checksum: "0".repeat(64) });
    assert.equal(badChecksum.status, 400);
    const badHeaders = await post(port, ca, { body: "clean bytes", key: apiKey, declared: "application/pdf", checksum: "not-a-hash" });
    assert.equal(badHeaders.status, 400);

    const notFound = await post(port, ca, { method: "POST", url: "/other", key: apiKey, body: "x" });
    assert.equal(notFound.status, 404);

    // clamd gone: FAILED with 503, never CLEAN.
    await new Promise((resolve) => clamd.close(resolve));
    const down = await post(port, ca, { body: "clean bytes", key: apiKey, declared: "application/pdf", detected: "application/pdf" });
    assert.equal(down.status, 503);
    assert.equal(down.body.status, "FAILED");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
    clamd.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
