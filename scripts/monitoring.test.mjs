import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import { monitoringConfiguration } from "./monitoring-config.mjs";
import { collectHostMetrics } from "./monitoring-host-collector.mjs";

const work = await mkdtemp(path.join(os.tmpdir(), "cvg-monitoring-test-"));
const openssl = args => {
  const result = spawnSync("openssl", args, { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};
openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=CVG disposable monitor CA", "-days", "2"]);
for (const name of ["server", "client"]) {
  openssl(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=agent.${name}.hospital.internal`]);
  await writeFile(path.join(work, `${name}.ext`), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=${name === "server" ? "serverAuth" : "clientAuth"}\nsubjectAltName=DNS:agent.${name}.hospital.internal,IP:127.0.0.1\n`);
  openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
}
const secrets = { "agent_ca.pem": await readFile(path.join(work, "ca.pem"), "utf8"),
  "agent_client_cert.pem": await readFile(path.join(work, "client.pem"), "utf8"), "agent_client_key.pem": await readFile(path.join(work, "client.key"), "utf8"),
  "agent_server_cert.pem": await readFile(path.join(work, "server.pem"), "utf8"), "agent_server_key.pem": await readFile(path.join(work, "server.key"), "utf8"),
  metrics_scrape_token: "synthetic-monitor-token-".repeat(3),
  ...Object.fromEntries(["primary", "reserve", "watchdog"].flatMap(name => [[`${name}_webhook_url`, `https://${name}.hospital.internal/alerts`], [`${name}_webhook_token`, `synthetic-${name}-token-`.repeat(3)]])) };
const environment = { MONITOR_ROLE: "external", MONITOR_HUB_URL: "https://hub.hospital.internal", MONITOR_AGENT_URL: "https://agent.server.hospital.internal:9100" };
const configure = (env = {}, overrides = {}) => monitoringConfiguration({ ...environment, ...env }, async name => {
  const value = { ...secrets, ...overrides }[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
});

test.after(async () => { await rm(work, { recursive: true, force: true }); });

test("external monitoring routes every operational alert independently to primary and reserve and sends a separate watchdog", async () => {
  const configuration = await configure();
  const prometheus = configuration["prometheus.yml"];
  assert.deepEqual(prometheus.alerting.alertmanagers[0].static_configs[0].targets, ["alertmanager:9093"]);
  assert.equal(prometheus.scrape_configs.find(job => job.job_name === "cvg-host").tls_config.cert_file, "/run/secrets/agent_client_cert.pem");
  const manager = configuration["alertmanager.yml"];
  assert.equal(manager.route.receiver, "operators");
  assert.deepEqual(manager.receivers[0].webhook_configs.map(item => item.url_file), ["/run/secrets/primary_webhook_url", "/run/secrets/reserve_webhook_url"]);
  assert.equal(manager.receivers[1].name, "watchdog");
  assert.ok(!JSON.stringify(configuration).includes(secrets.primary_webhook_token));
  assert.ok(!JSON.stringify(configuration).includes(secrets.primary_webhook_url));
  assert.equal(configuration["blackbox.yml"].modules.https_2xx.http.fail_if_not_ssl, true);
});

test("configuration fails closed without actual distinct HTTPS destinations, authentication or valid TLS material", async () => {
  for (const env of [{ MONITOR_HUB_URL: "" }, { MONITOR_HUB_URL: "https://hub.example.org" }, { MONITOR_AGENT_URL: "http://agent.hospital.internal" },
    { MONITOR_ROLE: "bad" }, { MONITOR_HUB_URL: "https://hub.hospital.internal/path" }]) await assert.rejects(configure(env));
  for (const overrides of [{ primary_webhook_url: "http://primary.hospital.internal" }, { reserve_webhook_url: secrets.primary_webhook_url },
    { watchdog_webhook_url: "https://placeholder.invalid" }, { primary_webhook_token: "short" }, { metrics_scrape_token: "short" },
    { "agent_client_key.pem": secrets["agent_server_key.pem"] }, { "agent_client_cert.pem": secrets["agent_ca.pem"] }]) {
    await assert.rejects(configure({}, overrides));
  }
});

test("the host exporter requires a private VPN bind and mutual TLS and can trust a private Hub CA", async () => {
  const agent = await configure({ MONITOR_ROLE: "agent", MONITOR_AGENT_BIND_IP: "10.35.1.4" });
  assert.equal(agent["node-exporter-web.yml"].tls_server_config.client_auth_type, "RequireAndVerifyClientCert");
  for (const bind of ["0.0.0.0", "8.8.8.8", "127.0.0.1", "10.999.1.2"]) await assert.rejects(configure({ MONITOR_ROLE: "agent", MONITOR_AGENT_BIND_IP: bind }));
  const privateCA = await configure({ MONITOR_HUB_PRIVATE_CA: "true" }, { "hub_ca.pem": secrets["agent_ca.pem"] });
  assert.equal(privateCA["blackbox.yml"].modules.https_2xx.http.tls_config.ca_file, "/run/secrets/hub_ca.pem");
  const webhookCA = await configure({ MONITOR_WEBHOOK_PRIVATE_CA: "true" }, { "webhook_ca.pem": secrets["agent_ca.pem"] });
  assert.equal(webhookCA["alertmanager.yml"].receivers[0].webhook_configs[0].http_config.tls_config.ca_file, "/run/secrets/webhook_ca.pem");
});

test("startup verification refuses stale configuration and public secret files", async () => {
  const secretDirectory = path.join(work, "secrets");
  await mkdir(secretDirectory);
  for (const [name, value] of Object.entries(secrets)) await writeFile(path.join(secretDirectory, name), value, { mode: 0o600 });
  const configDirectory = path.join(work, "config");
  const run = extra => spawnSync(process.execPath, [path.resolve("scripts/monitoring-config.mjs"), ...extra], { encoding: "utf8", env: {
    PATH: process.env.PATH, ...environment, MONITOR_CONFIG_DIR: configDirectory, MONITOR_SECRETS_DIR: secretDirectory
  } });
  assert.equal(run([]).status, 0);
  assert.equal(run(["--check"]).status, 0);
  await writeFile(path.join(configDirectory, "alertmanager.yml"), "{}");
  assert.equal(run(["--check"]).status, 1);
  await chmod(path.join(secretDirectory, "metrics_scrape_token"), 0o644);
  assert.equal(run([]).status, 1);
});

async function collectorFixture() {
  const directory = await mkdtemp(path.join(work, "backup-"));
  await mkdir(path.join(directory, "base", "20261011T000000Z"), { recursive: true });
  await writeFile(path.join(directory, "cvg-20261011T000000Z.dump"), "verified synthetic dump");
  await writeFile(path.join(directory, "base", "20261011T000000Z", "base.tar.gz"), "verified synthetic base");
  const now = Date.now() / 1000;
  await writeFile(path.join(directory, "offsite-status.json"), JSON.stringify({ lastResult: "ok", lastShippedEpoch: now - 10 }));
  const docker = (args, overrides = {}) => {
    if (args[0] === "ps") return args.at(-1).split("=").at(-1);
    if (args[0] === "inspect") return JSON.stringify({ Running: true, Health: { Status: "healthy" }, ...overrides.state });
    if (args[0] === "volume") return directory;
    if (args[1] === "worker") return JSON.stringify({ timestamp: new Date((now - 2) * 1000).toISOString(), health: "ok", lastResult: "PRIVATE_SENTINEL", ...overrides.heartbeat });
    return JSON.stringify({ failed: 0, pending: 0, oldest: 0, ...overrides.wal });
  };
  return { now, directory, docker };
}

test("the collector measures idle heartbeat, dumps/base, offsite and WAL without exposing config or clinical values", async () => {
  const fixture = await collectorFixture();
  const output = await collectHostMetrics({ project: "cvg-prod", docker: fixture.docker });
  assert.match(output, /cvg_host_collector_failures 0/);
  assert.match(output, /cvg_worker_heartbeat_ok 1/);
  assert.match(output, /cvg_offsite_last_attempt_ok 1/);
  assert.match(output, /cvg_postgres_wal_archive_check_ok 1/);
  assert.doesNotMatch(output, /PRIVATE_SENTINEL|password|hospital|attachments/);
  const broken = await collectHostMetrics({ project: "cvg-prod", docker: () => { throw new Error("SECRET_SENTINEL"); } });
  assert.match(broken, /cvg_container_running\{service="worker"\} 0/);
  assert.match(broken, /cvg_worker_heartbeat_timestamp_seconds 0/);
  assert.match(broken, /cvg_postgres_wal_archive_check_ok 0/);
  assert.doesNotMatch(broken, /SECRET_SENTINEL/);
});

test("a disabled offsite, stale idle worker and blocked WAL remain observable failures", async () => {
  const fixture = await collectorFixture();
  await writeFile(path.join(fixture.directory, "offsite-status.json"), JSON.stringify({ lastResult: "disabled", lastShippedEpoch: 0 }));
  const output = await collectHostMetrics({ project: "cvg-prod", now: fixture.now, docker: args => fixture.docker(args, {
    heartbeat: { timestamp: new Date((fixture.now - 400) * 1000).toISOString(), health: "unhealthy" }, wal: { failed: 4, pending: 3, oldest: 800 }
  }) });
  assert.match(output, /cvg_offsite_last_attempt_ok 0/);
  assert.match(output, /cvg_worker_heartbeat_ok 0/);
  assert.match(output, /cvg_postgres_wal_archive_pending_segments 3/);
  assert.match(output, /cvg_postgres_wal_archive_oldest_pending_seconds 800/);
  assert.match(output, /cvg_postgres_wal_archive_failures_total 4/);
});

test("official promtool and amtool accept the generated configuration and route host outages to both operators", {
  skip: !process.env.PROMTOOL || !process.env.AMTOOL
}, async () => {
  const directory = path.join(work, "official-config-check");
  const secretDirectory = path.join(directory, "secrets");
  await mkdir(secretDirectory, { recursive: true });
  for (const [name, value] of Object.entries(secrets)) await writeFile(path.join(secretDirectory, name), value, { mode: 0o600 });
  for (const [name, configuration] of Object.entries(await configure())) {
    const rendered = JSON.stringify(configuration).replaceAll("/run/secrets", secretDirectory)
      .replaceAll("/etc/prometheus", path.resolve("deploy/observability"));
    await writeFile(path.join(directory, name), rendered);
  }
  for (const [binary, args] of [[process.env.PROMTOOL, ["check", "config", path.join(directory, "prometheus.yml")]],
    [process.env.AMTOOL, ["check-config", path.join(directory, "alertmanager.yml")]],
    [process.env.AMTOOL, ["config", "routes", "test", `--config.file=${path.join(directory, "alertmanager.yml")}`, "--verify.receivers=operators", "alertname=CvgHostDown"]],
    [process.env.AMTOOL, ["config", "routes", "test", `--config.file=${path.join(directory, "alertmanager.yml")}`, "--verify.receivers=watchdog", "alertname=CvgMonitoringWatchdog"]]]) {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout} ${result.stderr}`);
  }
  if (process.env.BLACKBOX_BIN) {
    const result = spawnSync(process.env.BLACKBOX_BIN, ["--config.check", `--config.file=${path.join(directory, "blackbox.yml")}`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Alertmanager delivers to two local HTTPS receivers and the reserve still receives when primary fails", {
  skip: !process.env.ALERTMANAGER_BIN, timeout: 20_000
}, async () => {
  const directory = path.join(work, "delivery-smoke");
  await mkdir(directory);
  const received = [];
  let failPrimary = false;
  const receiver = https.createServer({ cert: secrets["agent_server_cert.pem"], key: secrets["agent_server_key.pem"] }, (request, response) => {
    let content = "";
    request.on("data", chunk => { content += chunk; });
    request.on("end", () => {
      const name = request.url.slice(1);
      if (request.headers.authorization !== `Bearer ${secrets[`${name}_webhook_token`]}`) { response.writeHead(401).end(); return; }
      const payload = JSON.parse(content);
      received.push({ receiver: name, alert: payload.alerts[0]?.labels.alertname });
      response.writeHead(name === "primary" && failPrimary ? 503 : 200).end();
    });
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const receiverPort = receiver.address().port;
  // Allocate only loopback ports, never contact the configured institutional URLs.
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const managerPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const configuration = (await configure())["alertmanager.yml"];
  configuration.route.group_wait = "1s";
  configuration.route.group_interval = "1s";
  await writeFile(path.join(directory, "ca.pem"), secrets["agent_ca.pem"]);
  for (const entry of configuration.receivers) for (const webhook of entry.webhook_configs) {
    const name = path.basename(webhook.url_file).replace("_webhook_url", "");
    webhook.url_file = path.join(directory, `${name}.url`);
    webhook.http_config.authorization.credentials_file = path.join(directory, `${name}.token`);
    webhook.http_config.tls_config.ca_file = path.join(directory, "ca.pem");
    await writeFile(webhook.url_file, `https://127.0.0.1:${receiverPort}/${name}`, { mode: 0o600 });
    await writeFile(webhook.http_config.authorization.credentials_file, secrets[`${name}_webhook_token`], { mode: 0o600 });
  }
  const configurationPath = path.join(directory, "alertmanager.yml");
  await writeFile(configurationPath, JSON.stringify(configuration));
  const manager = spawn(process.env.ALERTMANAGER_BIN, [`--config.file=${configurationPath}`, `--storage.path=${path.join(directory, "data")}`,
    `--web.listen-address=127.0.0.1:${managerPort}`, "--cluster.listen-address="], { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  manager.stderr.on("data", chunk => { logs += chunk; });
  const waitFor = async condition => {
    const deadline = Date.now() + 8_000;
    while (!await condition()) {
      if (Date.now() > deadline || manager.exitCode !== null) throw new Error(`local smoke timed out: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const api = `http://127.0.0.1:${managerPort}`;
  const send = async alertname => {
    const response = await fetch(`${api}/api/v2/alerts`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify([{ labels: { alertname, severity: "critical" }, annotations: { summary: "Synthetic local delivery test" },
        startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() }]) });
    assert.equal(response.status, 200);
  };
  try {
    await waitFor(async () => { try { return (await fetch(`${api}/-/ready`)).ok; } catch { return false; } });
    await send("CvgHostDown");
    await waitFor(() => ["primary", "reserve"].every(name => received.some(item => item.receiver === name && item.alert === "CvgHostDown")));
    await send("CvgMonitoringWatchdog");
    await waitFor(() => received.some(item => item.receiver === "watchdog" && item.alert === "CvgMonitoringWatchdog"));
    failPrimary = true;
    await send("CvgScannerUnhealthy");
    await waitFor(() => received.some(item => item.receiver === "reserve" && item.alert === "CvgScannerUnhealthy"));
  } finally {
    manager.kill("SIGTERM");
    if (manager.exitCode === null) await new Promise(resolve => manager.once("exit", resolve));
    await new Promise(resolve => receiver.close(resolve));
  }
});

test("the real Node Exporter serves private textfile metrics only to a valid TLS client", {
  skip: !process.env.NODE_EXPORTER_BIN, timeout: 10_000
}, async () => {
  const directory = path.join(work, "agent-smoke");
  await mkdir(directory);
  await writeFile(path.join(directory, "cvg.prom"), "cvg_worker_heartbeat_ok 1\n");
  for (const [name, value] of Object.entries(secrets)) await writeFile(path.join(directory, name), value, { mode: 0o600 });
  const configuration = (await configure({ MONITOR_ROLE: "agent", MONITOR_AGENT_BIND_IP: "10.35.1.4" }))["node-exporter-web.yml"];
  const configPath = path.join(directory, "web.yml");
  await writeFile(configPath, JSON.stringify(configuration).replaceAll("/run/secrets", directory));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const exporter = spawn(process.env.NODE_EXPORTER_BIN, [`--web.config.file=${configPath}`, `--web.listen-address=127.0.0.1:${port}`,
    "--collector.disable-defaults", "--collector.textfile", `--collector.textfile.directory=${directory}`], { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  exporter.stderr.on("data", chunk => { logs += chunk; });
  const readMetrics = client => new Promise((resolve, reject) => {
    const request = https.get(`https://127.0.0.1:${port}/metrics`, { ca: secrets["agent_ca.pem"], ...(client ? {
      cert: secrets["agent_client_cert.pem"], key: secrets["agent_client_key.pem"]
    } : {}), agent: false }, response => {
      let data = "";
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => response.statusCode === 200 ? resolve(data) : reject(new Error(`status ${response.statusCode}`)));
    });
    request.on("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("timeout")));
  });
  try {
    let metrics;
    const deadline = Date.now() + 5_000;
    while (!metrics) {
      try { metrics = await readMetrics(true); } catch {
        if (Date.now() >= deadline || exporter.exitCode !== null) throw new Error(`agent smoke failed: ${logs}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.match(metrics, /cvg_worker_heartbeat_ok 1/);
    await assert.rejects(readMetrics(false));
  } finally {
    exporter.kill("SIGTERM");
    if (exporter.exitCode === null) await new Promise(resolve => exporter.once("exit", resolve));
  }
});
