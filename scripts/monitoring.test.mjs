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
const environment = { MONITOR_ROLE: "external", MONITOR_HUB_URL: "https://hub.hospital.internal", MONITOR_AGENT_URL: "https://agent.server.hospital.internal:9100", MONITOR_POSTGRES_URL: "https://agent.server.hospital.internal:9187" };
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


test("PostgreSQL monitoring requires a dedicated mTLS target and refuses missing or unsafe endpoints", async () => {
  const configuration = await configure();
  const job = configuration["prometheus.yml"].scrape_configs.find(item => item.job_name === "cvg-postgres");
  assert.ok(job, "database monitoring must not be omitted from the independent monitor");
  assert.equal(job.scheme, "https");
  assert.deepEqual(job.static_configs[0].targets, ["agent.server.hospital.internal:9187"]);
  assert.equal(job.tls_config.cert_file, "/run/secrets/agent_client_cert.pem");
  for (const value of ["", "http://agent.hospital.internal:9187", "https://agent.hospital.internal:9187/probe", "https://agent.hospital.internal:9187?target=foreign"]) {
    await assert.rejects(configure({ MONITOR_POSTGRES_URL: value }));
  }
});

test("PostgreSQL agent validates isolated credentials without serializing them and rejects broad users or arbitrary DSNs", async () => {
  const env = { MONITOR_ROLE: "agent", MONITOR_AGENT_BIND_IP: "10.35.1.4", MONITOR_POSTGRES_ENABLED: "true" };
  const credentials = { postgres_uri: "postgres:5432/cvg_hub?sslmode=disable&connect_timeout=5", postgres_user: "cvg_pg_exporter", postgres_password: "synthetic-isolated-exporter-password-".repeat(2) };
  const agent = await configure(env, credentials);
  assert.equal(agent["postgres-exporter-web.yml"]?.tls_server_config.client_auth_type, "RequireAndVerifyClientCert");
  assert.ok(!JSON.stringify(agent).includes(credentials.postgres_password));
  for (const overrides of [{ postgres_user: "postgres" }, { postgres_password: "short" }, { postgres_uri: "postgres:5432/cvg_hub?sslmode=disable&password=hidden" },
    { postgres_uri: "foreign:5432/cvg_hub?sslmode=disable&connect_timeout=5" }, { postgres_uri: "postgres:5432/cvg_hub?sslmode=disable&connect_timeout=5\nother" }]) {
    await assert.rejects(configure(env, { ...credentials, ...overrides }));
  }
});

test("the PostgreSQL exporter uses only file credentials, an existing private network and three numeric collectors", async () => {
  const overlay = await readFile("docker-compose.monitoring-postgres.yml", "utf8");
  assert.match(overlay, /postgres-exporter:v0\.20\.0@sha256:[a-f0-9]{64}/);
  assert.match(overlay, /external: true/);
  assert.match(overlay, /\$\{MONITOR_AGENT_BIND_IP:\?\}:9187:9187/);
  for (const name of ["URI", "USER", "PASS"]) assert.match(overlay, new RegExp(`DATA_SOURCE_${name}_FILE:`));
  assert.doesNotMatch(overlay, /DATA_SOURCE_(URI|USER|PASS):|network_mode: host|docker\.sock|privileged:/);
  assert.deepEqual([...overlay.matchAll(/^      - --collector\.([^\n]+)$/gm)].map(item => item[1]).sort(), ["stat_archiver", "stat_bgwriter", "stat_database"]);
  for (const name of ["roles", "stat_activity", "stat_statements", "stat_user_tables", "statio_user_tables", "settings", "stat_replication"]) {
    assert.ok(overlay.includes(`--no-collector.${name}\n`));
  }
});

test("real disposable PostgreSQL and pinned exporter prove numeric collection, mTLS, least privilege and access failure/recovery", {
  skip: process.env.ALLOW_POSTGRES_EXPORTER_TESTS !== "true", timeout: 90_000
}, async () => {
  // This harness creates its own isolated network/containers. It has no installed database URL or Docker inspection of other services.
  const suffix = `${process.pid}-${Date.now()}`;
  const network = `cvg-monitor-test-${suffix}`;
  const postgres = `${network}-pg`;
  const exporter = `${network}-exporter`;
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const docker = (args, options = {}) => {
    const result = spawnSync("sg", ["docker", "-c", ["docker", ...args].map(quote).join(" ")], { encoding: "utf8", timeout: 20_000, ...options });
    if (!options.allowFailure) assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    return result;
  };
  const directory = path.join(work, "postgres-smoke");
  await mkdir(directory, { mode: 0o700 });
  const password = "synthetic-disposable-pg-exporter-".repeat(2);
  const credentials = { postgres_uri: "postgres:5432/cvg_monitor_test?sslmode=disable&connect_timeout=5", postgres_user: "cvg_pg_exporter", postgres_password: password };
  for (const [name, value] of Object.entries({ ...secrets, ...credentials })) await writeFile(path.join(directory, name), value, { mode: 0o600 });
  const envFile = path.join(directory, "postgres.env");
  await writeFile(envFile, "POSTGRES_DB=cvg_monitor_test\nPOSTGRES_PASSWORD=synthetic-admin-password-used-only-in-disposable-db\n", { mode: 0o600 });
  const web = (await configure({ MONITOR_ROLE: "agent", MONITOR_AGENT_BIND_IP: "10.35.1.4", MONITOR_POSTGRES_ENABLED: "true" }, credentials))["postgres-exporter-web.yml"];
  await writeFile(path.join(directory, "postgres-exporter-web.yml"), JSON.stringify(web), { mode: 0o600 });
  const overlay = await readFile("docker-compose.monitoring-postgres.yml", "utf8");
  const image = overlay.match(/image: (quay[^\s]+)/)[1];
  const flags = [...overlay.matchAll(/^      - (--[^\n]+)$/gm)].map(item => item[1]);
  const sql = (input, allowFailure = false, role = "postgres") => docker(["exec", "-i", postgres, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", role, "-d", "cvg_monitor_test", "-At"], { input, allowFailure });
  const roleScript = await readFile("deploy/monitoring/postgres-role.sql", "utf8");
  const created = [];
  try {
    docker(["network", "create", "--label", "cvg.scope=monitoring-disposable-tests", network]);
    created.push(network);
    docker(["run", "-d", "--name", postgres, "--label", "cvg.scope=monitoring-disposable-tests", "--network", network, "--network-alias", "postgres", "--env-file", envFile, "postgres:16-alpine"]);
    created.push(postgres);
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (docker(["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "cvg_monitor_test"], { allowFailure: true }).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "own disposable PostgreSQL must become ready");
    sql("CREATE SCHEMA clinical; CREATE TABLE clinical.patient_records (id integer, narrative text); INSERT INTO clinical.patient_records VALUES (1,'PRIVATE_SYNTHETIC_CLINICAL_SENTINEL'); REVOKE ALL ON SCHEMA clinical FROM PUBLIC; REVOKE ALL ON TABLE clinical.patient_records FROM PUBLIC;");
    sql(roleScript);
    sql(`ALTER ROLE cvg_pg_exporter PASSWORD '${password}';`);
    assert.match(sql("SHOW default_transaction_read_only; SHOW search_path; SELECT count(*) FROM pg_stat_database;", false, "cvg_pg_exporter").stdout, /^on\npg_catalog\n\d+\n$/);
    assert.equal(sql("SELECT bool_and(query IS NULL OR query='<insufficient privilege>') FROM pg_stat_activity WHERE usename='postgres';", false, "cvg_pg_exporter").stdout.trim(), "t", "other users' SQL text must remain redacted");
    for (const command of ["SELECT * FROM clinical.patient_records;", "SET default_transaction_read_only=off; INSERT INTO clinical.patient_records VALUES (2,'forbidden');", "SET ROLE postgres;"]) {
      assert.notEqual(sql(command, true, "cvg_pg_exporter").status, 0, "clinical data / elevated role must be denied even with read-only disabled");
    }
    sql("GRANT USAGE ON SCHEMA clinical TO PUBLIC; GRANT SELECT ON clinical.patient_records TO PUBLIC;");
    assert.notEqual(sql(roleScript, true).status, 0, "PUBLIC clinical authority must cause provisioning to fail closed");
    sql("REVOKE SELECT ON clinical.patient_records FROM PUBLIC; REVOKE USAGE ON SCHEMA clinical FROM PUBLIC; GRANT pg_monitor TO cvg_pg_exporter;");
    assert.notEqual(sql(roleScript, true).status, 0, "broad monitoring role membership must be rejected");
    sql("REVOKE pg_monitor FROM cvg_pg_exporter;");
    const missedAuthority = [];
    for (const target of ["cvg_pg_exporter", "PUBLIC"]) {
      sql(`GRANT USAGE ON SCHEMA clinical TO ${target}; GRANT SELECT(narrative) ON clinical.patient_records TO ${target};`);
      assert.equal(sql("SELECT narrative FROM clinical.patient_records;", false, "cvg_pg_exporter").stdout.trim(), "PRIVATE_SYNTHETIC_CLINICAL_SENTINEL", "column grant is genuine clinical read authority");
      if (sql(roleScript, true).status === 0) missedAuthority.push(`column grant: ${target}`);
      sql(`REVOKE SELECT(narrative) ON clinical.patient_records FROM ${target}; REVOKE USAGE ON SCHEMA clinical FROM ${target};`);
    }
    sql("GRANT CREATE ON DATABASE cvg_monitor_test TO cvg_pg_exporter;");
    if (sql(roleScript, true).status === 0) missedAuthority.push("database CREATE");
    sql("REVOKE CREATE ON DATABASE cvg_monitor_test FROM cvg_pg_exporter;");
    assert.deepEqual(missedAuthority, [], "all existing authority must be rejected, including columns and database CREATE");
    sql(roleScript); // Repeat provisioning safely without resetting the independent password.
    docker(["run", "-d", "--name", exporter, "--label", "cvg.scope=monitoring-disposable-tests", "--network", network, "--user", `${process.getuid()}:${process.getgid()}`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "-p", "127.0.0.1::9187",
      "-v", `${directory}:/run/secrets:ro`, "-v", `${directory}:/etc/cvg-monitor:ro`,
      "-e", "DATA_SOURCE_URI_FILE=/run/secrets/postgres_uri", "-e", "DATA_SOURCE_USER_FILE=/run/secrets/postgres_user", "-e", "DATA_SOURCE_PASS_FILE=/run/secrets/postgres_password", image, ...flags]);
    created.push(exporter);
    assert.equal(docker(["inspect", "--format", "{{.State.Running}}", exporter]).stdout.trim(), "true", "own exporter must be running");
    const address = docker(["port", exporter, "9187/tcp"]).stdout.trim();
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const readMetrics = client => new Promise((resolve, reject) => {
      const request = https.get(`https://${address}/metrics`, { ca: secrets["agent_ca.pem"], ...(client ? { cert: secrets["agent_client_cert.pem"], key: secrets["agent_client_key.pem"] } : {}), agent: false }, response => {
        let data = "";
        response.on("data", chunk => { data += chunk; });
        response.on("end", () => response.statusCode === 200 ? resolve(data) : reject(new Error(`status ${response.statusCode}`)));
      });
      request.on("error", reject);
      request.setTimeout(7_000, () => request.destroy(new Error("metrics timeout")));
    });
    const waitForMetrics = async pattern => {
      let last = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        try { last = await readMetrics(true); if (pattern.test(last)) return last; } catch { /* bounded readiness polling, never retries an assertion */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail(`numeric collector did not reach expected state ${pattern}: ${last}`);
    };
    const metrics = await waitForMetrics(/^pg_up 1$/m);
    for (const name of ["pg_stat_database_xact_commit", "pg_stat_bgwriter", "pg_stat_archiver"]) assert.ok(metrics.includes(name), `${name} must be collected without pg_monitor`);
    for (const collector of ["stat_database", "stat_bgwriter", "stat_archiver"]) {
      assert.ok(metrics.includes(`pg_scrape_collector_success{collector="${collector}"} 1`), `${collector} must finish successfully`);
    }
    assert.doesNotMatch(metrics, /PRIVATE_SYNTHETIC_CLINICAL_SENTINEL|patient_records|narrative|query=|pg_stat_activity|pg_stat_statements|pg_stat_user_tables/);
    await assert.rejects(readMetrics(false), "client certificate is mandatory");
    sql("ALTER ROLE cvg_pg_exporter NOLOGIN; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='cvg_pg_exporter';");
    await waitForMetrics(/^pg_up 0$/m);
    sql("ALTER ROLE cvg_pg_exporter LOGIN;");
    await waitForMetrics(/^pg_up 1$/m);
    assert.equal(sql("SELECT count(*) FROM clinical.patient_records;").stdout.trim(), "1", "monitoring must not mutate clinical records");
  } finally {
    // Remove only resources whose successful creation this harness recorded; surface cleanup failures.
    const cleanupFailures = [];
    for (const name of [exporter, postgres]) if (created.includes(name) && docker(["rm", "-fv", name], { allowFailure: true }).status !== 0) cleanupFailures.push(name);
    if (created.includes(network) && docker(["network", "rm", network], { allowFailure: true }).status !== 0) cleanupFailures.push(network);
    assert.deepEqual(cleanupFailures, [], "all own disposable resources must be removed");
  }
});

test("PostgreSQL startup rejects public or symlinked credential files before the exporter starts", async () => {
  const secretDirectory = path.join(work, "postgres-private-files");
  const configDirectory = path.join(work, "postgres-private-config");
  await mkdir(secretDirectory, { mode: 0o700 });
  const credentials = { postgres_uri: "postgres:5432/cvg_hub?sslmode=disable&connect_timeout=5", postgres_user: "cvg_pg_exporter", postgres_password: "synthetic-private-exporter-password-".repeat(2) };
  for (const [name, value] of Object.entries({ ...secrets, ...credentials })) await writeFile(path.join(secretDirectory, name), value, { mode: 0o600 });
  const run = extra => spawnSync(process.execPath, [path.resolve("scripts/monitoring-config.mjs"), ...extra], { encoding: "utf8", env: {
    PATH: process.env.PATH, MONITOR_ROLE: "agent", MONITOR_AGENT_BIND_IP: "10.35.1.4", MONITOR_POSTGRES_ENABLED: "true",
    MONITOR_CONFIG_DIR: configDirectory, MONITOR_SECRETS_DIR: secretDirectory
  } });
  assert.equal(run([]).status, 0);
  assert.equal(run(["--check"]).status, 0);
  assert.ok(!(await readFile(path.join(configDirectory, "postgres-exporter-web.yml"), "utf8")).includes(credentials.postgres_password));
  await chmod(path.join(secretDirectory, "postgres_password"), 0o644);
  assert.equal(run(["--check"]).status, 1);
  await chmod(path.join(secretDirectory, "postgres_password"), 0o600);
  await rm(path.join(secretDirectory, "postgres_uri"));
  const { symlink } = await import("node:fs/promises");
  await writeFile(path.join(secretDirectory, "uri-source"), credentials.postgres_uri, { mode: 0o600 });
  await symlink("uri-source", path.join(secretDirectory, "postgres_uri"));
  assert.equal(run(["--check"]).status, 1);
});
