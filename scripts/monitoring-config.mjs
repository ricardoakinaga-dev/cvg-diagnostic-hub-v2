// No network calls. Generates/validates the independent monitor's configuration; refuses empty/example destinations.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function endpoint(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      /(^|\.)(example\.(org|com|net)|invalid|test)$/.test(url.hostname) || /placeholder|replace|localhost/i.test(url.hostname)) {
    throw new Error(`${name} requires a configured HTTPS endpoint without example values`);
  }
  return url;
}

function certificate(contents, name) {
  const cert = new X509Certificate(contents);
  if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error(`${name} certificate is not currently valid`);
  return cert;
}

export async function monitoringConfiguration(environment, readSecret) {
  const role = required(environment, "MONITOR_ROLE");
  const tls = { min_version: "TLS12" };
  const ca = certificate(await readSecret("agent_ca.pem"), "agent CA");
  if (!ca.ca) throw new Error("agent_ca.pem must be a CA certificate");
  if (role === "agent") {
    const cert = certificate(await readSecret("agent_server_cert.pem"), "agent server");
    if (cert.ca) throw new Error("agent server must use a leaf certificate, not the CA certificate");
    if (!cert.checkPrivateKey(createPrivateKey(await readSecret("agent_server_key.pem")))) throw new Error("agent server key does not match certificate");
    const bind = required(environment, "MONITOR_AGENT_BIND_IP");
    if (isIP(bind) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)\d/.test(bind)) {
      throw new Error("MONITOR_AGENT_BIND_IP must be a private/VPN IPv4 address");
    }
    return { "node-exporter-web.yml": { tls_server_config: { cert_file: "/run/secrets/agent_server_cert.pem",
      key_file: "/run/secrets/agent_server_key.pem", client_auth_type: "RequireAndVerifyClientCert",
      client_ca_file: "/run/secrets/agent_ca.pem", ...tls } } };
  }
  if (role !== "external") throw new Error("MONITOR_ROLE must be external or agent");
  const hub = endpoint(required(environment, "MONITOR_HUB_URL"), "MONITOR_HUB_URL");
  const agent = endpoint(required(environment, "MONITOR_AGENT_URL"), "MONITOR_AGENT_URL");
  if (hub.pathname !== "/" || hub.search || agent.pathname !== "/" || agent.search) throw new Error("monitor target URLs must not contain a path or query");
  const clientCert = certificate(await readSecret("agent_client_cert.pem"), "agent client");
  if (clientCert.ca) throw new Error("agent client must use a leaf certificate, not the CA certificate");
  if (!clientCert.checkPrivateKey(createPrivateKey(await readSecret("agent_client_key.pem")))) throw new Error("agent client key does not match certificate");
  const destinations = [];
  for (const name of ["primary", "reserve", "watchdog"]) {
    destinations.push(endpoint((await readSecret(`${name}_webhook_url`)).trim(), `${name}_webhook_url`).href);
    if ((await readSecret(`${name}_webhook_token`)).trim().length < 32) throw new Error(`${name}_webhook_token requires at least 32 characters`);
  }
  if (new Set(destinations).size !== 3) throw new Error("primary, reserve and watchdog endpoints must be distinct");
  if ((await readSecret("metrics_scrape_token")).trim().length < 32) throw new Error("metrics_scrape_token requires at least 32 characters");
  const hubTls = { ...tls };
  if (environment.MONITOR_HUB_PRIVATE_CA === "true") {
    if (!certificate(await readSecret("hub_ca.pem"), "Hub CA").ca) throw new Error("hub_ca.pem must be a CA certificate");
    hubTls.ca_file = "/run/secrets/hub_ca.pem";
  }
  const webhookTls = { ...tls };
  if (environment.MONITOR_WEBHOOK_PRIVATE_CA === "true") {
    if (!certificate(await readSecret("webhook_ca.pem"), "webhook CA").ca) throw new Error("webhook_ca.pem must be a CA certificate");
    webhookTls.ca_file = "/run/secrets/webhook_ca.pem";
  }
  const webhook = name => ({ send_resolved: true, url_file: `/run/secrets/${name}_webhook_url`, timeout: "10s",
    http_config: { follow_redirects: false, authorization: { type: "Bearer", credentials_file: `/run/secrets/${name}_webhook_token` }, tls_config: webhookTls } });
  return {
    "prometheus.yml": {
      global: { scrape_interval: "30s", evaluation_interval: "30s" }, rule_files: ["/etc/prometheus/alerts.yml", "/etc/prometheus/infrastructure-alerts.yml"],
      alerting: { alertmanagers: [{ static_configs: [{ targets: ["alertmanager:9093"] }] }] },
      scrape_configs: [
        { job_name: "cvg-hub", scheme: "https", metrics_path: "/api/v1/metrics",
          authorization: { type: "Bearer", credentials_file: "/run/secrets/metrics_scrape_token" }, tls_config: hubTls,
          static_configs: [{ targets: [hub.host], labels: { environment: "production" } }] },
        { job_name: "cvg-host", scheme: "https", tls_config: { ...tls, ca_file: "/run/secrets/agent_ca.pem",
          cert_file: "/run/secrets/agent_client_cert.pem", key_file: "/run/secrets/agent_client_key.pem" }, static_configs: [{ targets: [agent.host] }] },
        { job_name: "cvg-https", metrics_path: "/probe", params: { module: ["https_2xx"] }, static_configs: [{ targets: [`${hub.origin}/api/v1/livez`] }],
          relabel_configs: [{ source_labels: ["__address__"], target_label: "__param_target" }, { source_labels: ["__param_target"], target_label: "instance" },
            { target_label: "__address__", replacement: "blackbox:9115" }] },
        { job_name: "cvg-prometheus", static_configs: [{ targets: ["localhost:9090"] }] },
        { job_name: "cvg-alertmanager", static_configs: [{ targets: ["alertmanager:9093"] }] }
      ]
    },
    "alertmanager.yml": { global: { resolve_timeout: "5m" }, route: { receiver: "operators", group_by: ["alertname", "instance", "service"],
      group_wait: "10s", group_interval: "1m", repeat_interval: "30m", routes: [{ matchers: ['alertname="CvgMonitoringWatchdog"'], receiver: "watchdog", repeat_interval: "1m", group_interval: "1m" }] },
      receivers: [{ name: "operators", webhook_configs: [webhook("primary"), webhook("reserve")] }, { name: "watchdog", webhook_configs: [webhook("watchdog")] }] },
    "blackbox.yml": { modules: { https_2xx: { prober: "http", timeout: "10s", http: { method: "GET", valid_status_codes: [200],
      follow_redirects: false, fail_if_not_ssl: true, preferred_ip_protocol: "ip4", tls_config: hubTls } } } }
  };
}

async function main() {
  const configDirectory = path.resolve(required(process.env, "MONITOR_CONFIG_DIR"));
  if (process.getuid?.() === 0) throw new Error("monitor configuration must run as the dedicated unprivileged UID");
  const secretsDirectory = path.resolve(required(process.env, "MONITOR_SECRETS_DIR"));
  const configurations = await monitoringConfiguration(process.env, async name => {
    const filename = path.join(secretsDirectory, name);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error(`${name} must be a private regular file (0600)`);
    return readFile(filename, "utf8");
  });
  const check = process.argv.includes("--check");
  if (!check) await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  for (const [name, configuration] of Object.entries(configurations)) {
    const filename = path.join(configDirectory, name);
    if (check) {
      if (JSON.stringify(JSON.parse(await readFile(filename, "utf8"))) !== JSON.stringify(configuration)) throw new Error(`stale or modified ${name}: regenerate and validate`);
    } else await writeFile(filename, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ event: check ? "monitoring.config_verified" : "monitoring.config_generated", role: process.env.MONITOR_ROLE }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ event: "monitoring.config_refused", message: error.message })); process.exitCode = 1;
});
