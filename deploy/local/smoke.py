#!/usr/bin/env python3
"""Verify only the isolated local stack; never print its credentials/cookies."""
import hashlib
import json
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / '.data/local-deploy'
COMPOSE = ['docker', 'compose', '-p', 'cvg-diagnostic-local', '-f',
           str(ROOT / 'docker-compose.local.yml'), '--env-file', str(PRIVATE / 'stack.env')]
access = json.loads((PRIVATE / 'access.json').read_text())
tls = ssl.create_default_context(cafile=str(PRIVATE / 'certs/ca.crt'))


def run(args, input_text=None):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f'Command failed: {args[0]} (exit {result.returncode})')
    return result.stdout


def query(sql):
    return json.loads(run(COMPOSE + ['exec', '-T', 'postgres', 'sh', '-c',
                         'psql -U cvg_admin -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'], sql).strip())


def request(path, body=None, extra_headers=None):
    headers = dict(extra_headers or {})
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    req = urllib.request.Request(access['url'] + path, data=data, headers=headers)
    try:
        response = urllib.request.urlopen(req, context=tls, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        content = response.read()
        return response.status, response.headers, json.loads(content)


def buckets():
    return {row['bucket_key']: row for row in query(
        "SELECT COALESCE(json_agg(t), '[]'::json) FROM "
        "(SELECT bucket_key, request_count, window_started_at FROM rate_limit_buckets) t;")}


report = {'observedAt': datetime.now(timezone.utc).isoformat(), 'url': access['url']}
status, _, payload = request('/api/v1/readyz')
assert status == 200 and payload['data']['dataMode'] == 'postgres' and payload['data']['storageMode'] == 's3'
report['readiness'] = 'PASS'

before = buckets()
email = f'proxy-check-{uuid.uuid4().hex}@example.invalid'
correlations = []
spoofed = ['198.51.100.17', '203.0.113.23']
for address in spoofed:
    correlation = f'proxy-{uuid.uuid4()}'
    correlations.append(correlation)
    status, _, payload = request('/api/v1/session/login', {'email': email, 'password': 'invalid-local-check'}, {
        'X-Forwarded-For': address, 'X-Real-IP': address, 'X-Correlation-Id': correlation})
    assert status == 401, f'Unexpected proxy test HTTP status: {status}'

after = buckets()
entries = []
for line in run(COMPOSE + ['logs', '--no-color', '--no-log-prefix', '--tail', '100', 'proxy']).splitlines():
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        continue
    values = entry.get('request', {}).get('headers', {}).get('X-Correlation-Id', [])
    if any(value in correlations for value in values):
        entries.append(entry)
assert len(entries) == 2, 'Missing correlated Caddy access log evidence'
real_addresses = {entry['request']['remote_ip'] for entry in entries}
assert len(real_addresses) == 1 and not real_addresses.intersection(spoofed)
real_address = next(iter(real_addresses))
client = hashlib.sha256(real_address.encode()).hexdigest()[:32]
pair = 'login-account:' + json.dumps([email, client], separators=(',', ':'))
expected = ['login-client:' + client, pair, 'login-failures:' + pair]
for key in expected:
    assert key in after, 'Expected real-client counter not found'
    previous = before.get(key)
    previous_count = previous['request_count'] if previous and previous['window_started_at'] == after[key]['window_started_at'] else 0
    assert after[key]['request_count'] - previous_count == 2, 'Counter did not record exactly two attempts'
for address in spoofed:
    fake_client = hashlib.sha256(address.encode()).hexdigest()[:32]
    for key, row in after.items():
        if fake_client in key:
            assert before.get(key) == row, 'Spoofed IP created or incremented a counter'
report['proxySpoofing'] = {'status': 'PASS', 'observedPeer': real_address,
                           'clientKey': client, 'attempts': 2, 'forgedAddresses': spoofed,
                           'clientCounterDelta': 2, 'pairCounterDelta': 2, 'failureCounterDelta': 2}

status, headers, payload = request('/api/v1/session/login', {
    'email': access['email'], 'password': access['password']})
assert status == 200 and payload['data']['user']['role'] == 'ADMIN'
cookies = '; '.join(value.split(';', 1)[0] for value in headers.get_all('Set-Cookie', []))
assert 'cvg_session=' in cookies and 'cvg_csrf=' in cookies
status, _, payload = request('/api/v1/session/me', extra_headers={'Cookie': cookies})
assert status == 200 and payload['data']['user']['role'] == 'ADMIN'
report['loginAndSession'] = 'PASS'

dependency_checks = r'''
const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand} = require('@aws-sdk/client-s3');
(async () => {
  const scanner = process.env.MALWARE_SCANNER_ENDPOINT;
  async function scan(content, {authorized=true, checksum, declared='text/plain', detected='text/plain'}={}) {
    const response = await fetch(scanner, {method:'POST', headers:{
      ...(authorized ? {authorization:'Bearer '+process.env.MALWARE_SCANNER_API_KEY} : {}),
      'x-content-sha256':checksum ?? createHash('sha256').update(content).digest('hex'),
      'x-declared-mime':declared, 'x-detected-mime':detected, 'content-type':declared
    }, body:content, signal:AbortSignal.timeout(30000)});
    return {http:response.status, ...(await response.json())};
  }
  const clean=Buffer.from('Diagnostic Hub clean local dependency check');
  const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const checks={};
  checks.clean=await scan(clean); assert.equal(checks.clean.http,200); assert.equal(checks.clean.status,'CLEAN');
  checks.eicar=await scan(eicar); assert.equal(checks.eicar.http,200); assert.equal(checks.eicar.status,'QUARANTINED');
  checks.unauthorized=await scan(clean,{authorized:false}); assert.equal(checks.unauthorized.http,401);
  checks.badChecksum=await scan(clean,{checksum:'0'.repeat(64)}); assert.equal(checks.badChecksum.http,400);
  checks.mimeMismatch=await scan(clean,{declared:'application/pdf'}); assert.equal(checks.mimeMismatch.status,'QUARANTINED');
  const storage = new S3Client({endpoint:process.env.STORAGE_ENDPOINT, region:process.env.STORAGE_REGION, forcePathStyle:true,
    credentials:{accessKeyId:process.env.STORAGE_ACCESS_KEY,secretAccessKey:process.env.STORAGE_SECRET_KEY}});
  const key='installation-checks/'+randomUUID()+'.txt';
  try {
    await storage.send(new PutObjectCommand({Bucket:process.env.STORAGE_BUCKET,Key:key,Body:clean}));
    const object=await storage.send(new GetObjectCommand({Bucket:process.env.STORAGE_BUCKET,Key:key}));
    assert.deepEqual(Buffer.from(await object.Body.transformToByteArray()),clean);
  } finally {
    await storage.send(new DeleteObjectCommand({Bucket:process.env.STORAGE_BUCKET,Key:key}));
    storage.destroy();
  }
  console.log(JSON.stringify({scanner:checks,storage:'PASS'}));
})().catch(() => { console.error('Local dependency verification failed');process.exit(1); });
'''
report['dependencies'] = json.loads(run(COMPOSE + ['exec', '-T', 'app', 'node', '-'], dependency_checks))

runtime_probes = r'''
const {Pool}=require('pg');
(async()=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try {
    const {rows}=await pool.query("SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname=current_user");
    if(rows[0].role!=='cvg_runtime' || rows[0].rolsuper) throw new Error('Unexpected runtime privileges');
    for(const sql of ['DELETE FROM audit_events WHERE false','CREATE TABLE public.local_privilege_probe (id integer)']) {
      try { await pool.query(sql);throw new Error('Forbidden statement succeeded'); }
      catch(error) { if(error.code!=='42501') throw error; }
    }
    console.log(JSON.stringify({node:process.version,role:rows[0].role,negativePrivileges:'PASS'}));
  } finally { await pool.end(); }
})().catch(()=>{console.error('Runtime privilege verification failed');process.exit(1)});
'''
report['runtime'] = json.loads(run(COMPOSE + ['exec', '-T', 'app', 'node', '-'], runtime_probes))
assert report['runtime']['node'].startswith('v22.')

baseline = json.loads((PRIVATE / 'evidence/existing-containers.json').read_text())
all_ids = run(['docker', 'ps', '-aq']).split()
existing = {entry['Name']: entry for entry in json.loads(run(['docker', 'inspect'] + all_ids))}
changed = []
for old in baseline:
    current = existing.get(old['name'])
    assert current is not None and current['State']['Running'], f"Existing service missing/stopped: {old['name']}"
    assert old['ports'] == current['HostConfig']['PortBindings']
    if old['id'] != current['Id'] or old['startedAt'] != current['State']['StartedAt']:
        changed.append({'name': old['name'], 'idChanged': old['id'] != current['Id'],
                        'portsUnchanged': True, 'running': True})
if '--strict-baseline' in sys.argv:
    assert not changed, 'Existing container identities changed; review concurrent operations'
report['existingContainers'] = {'status': 'UNCHANGED' if not changed else 'CHANGED_IDS',
                               'portsAndRunning': 'PASS', 'unchanged': len(baseline) - len(changed),
                               'changes': changed}

ids = run(COMPOSE + ['ps', '-q']).split()
installed = json.loads(run(['docker', 'inspect'] + ids))
published = []
for container in installed:
    service = container['Config']['Labels']['com.docker.compose.service']
    assert container['State']['Running']
    if service != 'proxy':
        assert container['State'].get('Health', {}).get('Status') == 'healthy', f'{service} is not healthy'
    for bindings in (container['HostConfig']['PortBindings'] or {}).values():
        published.extend(bindings or [])
assert published == [{'HostIp': '127.0.0.1', 'HostPort': '18443'}]
report['publishedPorts'] = published
report['status'] = 'PASS'
destination = PRIVATE / 'evidence/smoke.json'
destination.write_text(json.dumps(report, indent=2) + '\n')
destination.chmod(0o600)
print(json.dumps(report, indent=2))
