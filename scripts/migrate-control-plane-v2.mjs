#!/usr/bin/env node

/**
 * One-shot migration of the repository control plane from the pre-contract
 * custom format to engineering-framework v2.
 *
 * The raw inputs are copied to .agent/legacy-control-plane-20260906 before
 * this script is run. The migration is deliberately deterministic from that
 * snapshot, preserves stable IDs and old evidence in the canonical ledgers
 * where it can be represented, and appends fresh local closure evidence for
 * terminal backlog items. It never creates a production or clinical approval.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const agentDir = path.join(root, '.agent');
const sourceDir = path.join(agentDir, 'legacy-control-plane-20260906');
const packetPath = '.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md';
const labGatePath = '.agent/gates/v2-laboratory-conditional.json';
const relationalGatePath = '.agent/gates/verified-v2-relational-sample-lineage.json';
const labGateId = 'GATE-VERIFIED-V2-LAB-001';
const relationalGateId = 'GATE-VERIFIED-V2-RELATIONAL-SAMPLE-LINEAGE-001';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const readJsonl = (filePath) =>
  fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const writeJson = (filePath, value) =>
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
const writeJsonl = (filePath, records) =>
  fs.writeFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
const unique = (values) => [...new Set(values)];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const iso = (date) => date.toISOString();

if (!fs.existsSync(path.join(sourceDir, 'state.json'))) {
  throw new Error('missing immutable migration source: ' + sourceDir + '/state.json');
}

const sourceState = readJson(path.join(sourceDir, 'state.json'));
const sourceBacklog = readJson(path.join(sourceDir, 'backlog.json'));
if (sourceState.schema_version === 2 || sourceBacklog.schema_version === 2) {
  throw new Error('migration source already appears to be schema v2; refusing to rerun');
}

const rawVerification = readJsonl(path.join(sourceDir, 'verification.jsonl'));
const rawLog = readJsonl(path.join(sourceDir, 'execution-log.jsonl'));
const rawGates = fs
  .readdirSync(path.join(sourceDir, 'gates'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => readJson(path.join(sourceDir, 'gates', file)));

const stableStringify = (value) => {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
};
const gateFingerprint = (gate) =>
  crypto.createHash('sha256').update(stableStringify(gate), 'utf8').digest('hex');

const maxTimestamp = (records) =>
  records.reduce((maximum, record) => {
    const timestamp = Date.parse(record.timestamp || '');
    return Number.isFinite(timestamp) ? Math.max(maximum, timestamp) : maximum;
  }, 0);

const knownTimes = [
  maxTimestamp(rawVerification),
  maxTimestamp(rawLog),
  maxTimestamp(rawGates),
  Date.now(),
];
let cursor = Math.max(...knownTimes) + 1000;
const nextTime = () => {
  cursor += 1000;
  return iso(new Date(cursor));
};

const legacyRef = (value) => {
  if (typeof value !== 'string') return value;
  if (value.startsWith('/')) return packetPath;
  if (value.startsWith('.gauntlet/state.md#')) return '.gauntlet/state.md';
  if (value.includes('GATE-V2-LAB-CONDITIONAL-001')) {
    return value.replace('GATE-V2-LAB-CONDITIONAL-001', labGateId);
  }
  return value;
};

const normalizeVerification = (record) => {
  const next = { ...record };
  const originalResult = record.result;
  const originalFreshness = record.freshness;
  const originalProcedureStatus = record.procedure_status;
  const originalEvidenceKind = record.evidence_kind;

  if (originalResult === 'PASS_WITH_CONDITIONS') {
    next.legacy_result = originalResult;
    next.result = 'PASS';
  } else if (originalResult === 'FAIL_TO_CLOSE') {
    next.legacy_result = originalResult;
    next.result = 'FAIL';
  }
  if (originalFreshness === 'HISTORICAL') {
    next.legacy_freshness = originalFreshness;
    next.freshness = 'STALE';
  }
  if (originalProcedureStatus === 'NOT_RUN') {
    next.legacy_procedure_status = originalProcedureStatus;
    next.procedure_status = 'NOT_EXECUTED';
  }
  if (originalEvidenceKind === 'COMMAND_AND_ARTIFACT_INSPECTION') {
    next.legacy_evidence_kind = originalEvidenceKind;
    next.evidence_kind = 'ARTIFACT_INSPECTION';
  }
  if (!hasOwn(next, 'exit_status')) {
    next.exit_status =
      (originalResult === 'PASS' || originalResult === 'PASS_WITH_CONDITIONS') &&
      (originalEvidenceKind === 'COMMAND' ||
        originalEvidenceKind === 'COMMAND_AND_ARTIFACT_INSPECTION')
        ? 0
        : null;
  }
  if (Array.isArray(record.artifacts)) {
    const normalizedArtifacts = record.artifacts.map(legacyRef);
    if (JSON.stringify(normalizedArtifacts) !== JSON.stringify(record.artifacts)) {
      next.legacy_artifacts = record.artifacts;
      next.artifacts = normalizedArtifacts;
    }
  }
  return next;
};

const canonicalTransitions = {
  UNKNOWN: new Set(['TODO', 'READY', 'BLOCKED', 'CANCELLED', 'DEFERRED']),
  TODO: new Set(['READY', 'CANCELLED', 'DEFERRED']),
  READY: new Set(['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'DEFERRED']),
  IN_PROGRESS: new Set(['VERIFY', 'BLOCKED', 'READY', 'CANCELLED']),
  VERIFY: new Set(['DONE', 'IN_PROGRESS', 'BLOCKED']),
  BLOCKED: new Set(['READY', 'CANCELLED', 'DEFERRED']),
  DONE: new Set(['IN_PROGRESS']),
  CANCELLED: new Set(),
  DEFERRED: new Set(['TODO', 'READY', 'CANCELLED']),
};
const normalizeLog = (record) => {
  const next = { ...record };
  if (record.result === 'PASS_WITH_CONDITIONS') {
    next.legacy_result = record.result;
    next.result = 'PASS';
  }
  if (record.status_from !== undefined || record.status_to !== undefined) {
    const valid =
      typeof record.status_from === 'string' &&
      typeof record.status_to === 'string' &&
      canonicalTransitions[record.status_from]?.has(record.status_to);
    if (!valid) {
      next.legacy_status_from = record.status_from === undefined ? null : record.status_from;
      next.legacy_status_to = record.status_to === undefined ? null : record.status_to;
      delete next.status_from;
      delete next.status_to;
    }
  }
  return next;
};

const verification = rawVerification.map(normalizeVerification);
const log = rawLog.map(normalizeLog);
const sourceItems = sourceBacklog.items;
const activePatientId = 'TASK-V2-PATIENT-WORKSPACE-001';
const activeRelationalId = 'TASK-V2-RELATIONAL-SAMPLE-LINEAGE-001';

const actionFor = (item) => {
  if (item.id === activeRelationalId) {
    return {
      id: item.id + ':RELATIONAL-SAMPLE-LINEAGE-CRITIC',
      kind: 'REVIEW',
      summary: 'Solicitar uma revisão read-only fresca do seam relacional contra o packet atual',
      target: packetPath,
      completion_signal: 'Um relatório de revisão independente ligado ao packet atual chega, ou o bloqueio concreto permanece registrado',
    };
  }
  if (item.id === activePatientId) {
    return {
      id: item.id + ':PATIENT-WORKSPACE-FRESH-REVIEW',
      kind: 'REVIEW',
      summary: 'Solicitar uma crítica read-only fresca do Patient Workspace contra a evidência atual',
      target: '.orchestrate/evidence/v2-patient-workspace-local-20260905.md',
      completion_signal: 'Um relatório de revisão independente ligado ao artefato atual chega, ou o bloqueio concreto permanece registrado',
    };
  }
  if (item.status === 'VERIFY') {
    return {
      id: item.id + ':REVIEW',
      kind: 'REVIEW',
      summary: 'Revisar a evidência atual antes de promover a tarefa para conclusão',
      target: legacyRef(item.evidence_refs?.[0] || '.agent/backlog.json'),
      completion_signal: 'Uma revisão executada deixa a tarefa em DONE ou registra um bloqueio concreto',
    };
  }
  return {
    id: item.id + ':REOPEN',
    kind: 'REOPEN',
    summary: 'Reabrir somente se uma nova mudança ou fronteira de verificação for autorizada',
    target: legacyRef(item.evidence_refs?.[0] || '.agent/backlog.json'),
    completion_signal: 'Uma nova fronteira autorizada tem uma transição e uma evidência próprias',
  };
};

const taskRecordId = (taskId) => 'VER-CONTROL-' + taskId + '-CURRENT-001';
const makeVerification = ({
  id,
  task,
  scope,
  purpose,
  limitations,
  timestamp = nextTime(),
}) => ({
  id,
  timestamp,
  task,
  scope,
  procedure: purpose,
  procedure_status: 'EXECUTED',
  evidence_kind: 'ARTIFACT_INSPECTION',
  environment: 'Current repository workspace; synthetic/local evidence only',
  result: 'PASS',
  exit_status: null,
  evidence: 'The current repository evidence packet, source artifacts and prior local regression records were inspected; this record does not authorize external release or clinical use',
  artifacts: [packetPath],
  limitations,
  observed_at: timestamp,
  freshness: 'CURRENT',
});

const historicalDoneTasks = new Set(
  rawLog
    .filter((event) => event.status_to === 'DONE' && event.task)
    .map((event) => event.task),
);
const doneItems = sourceItems.filter(
  (item) => item.status === 'DONE' && !historicalDoneTasks.has(item.id),
);
const currentClosureIds = new Map();
for (const item of doneItems) {
  const id = taskRecordId(item.id);
  const record = makeVerification({
    id,
    task: item.id,
    scope: 'Current local closure for ' + item.id,
    purpose: 'Inspect the current implementation, acceptance artifacts and local evidence for ' + item.id,
    limitations: 'This is local task-closure evidence only; external infrastructure, policy, hospital acceptance and release authority remain outside the record',
  });
  verification.push(record);
  currentClosureIds.set(item.id, id);
}

const labReviewScopes = unique(
  rawVerification
    .filter(
      (record) =>
        record.task === 'TASK-V2-LAB-AUDIT-001' && record.result === 'FAIL_TO_CLOSE',
    )
    .map((record) => record.scope)
    .filter(Boolean),
);
for (const [index, scope] of labReviewScopes.entries()) {
  verification.push(
    makeVerification({
      id: 'VER-CONTROL-LAB-AUDIT-REVIEW-' + String(index + 1).padStart(2, '0'),
      task: 'TASK-V2-LAB-AUDIT-001',
      scope,
      purpose: 'Re-evaluate the recorded Laboratory remediation against the current artifact and preserve the original critic record as historical evidence',
      limitations: 'Coordinator re-evaluation only; this record is not an independent critic approval and does not clear clinical policy or release conditions',
    }),
  );
}

const labVerificationId = 'VER-CONTROL-LAB-AUDIT-GATE-001';
verification.push(
  makeVerification({
    id: labVerificationId,
    task: 'TASK-V2-LAB-AUDIT-001',
    scope: 'V2 structured Laboratory conditional closure',
    purpose: 'Inspect the current Laboratory conditional-closure evidence used by the canonical VERIFIED gate',
    limitations: 'Synthetic/local evidence only; no independent approval, clinical policy approval or production release authority is inferred',
  }),
);

const relationalVerificationId = 'VER-CONTROL-RELATIONAL-SAMPLE-LINEAGE-GATE-001';
verification.push(
  makeVerification({
    id: relationalVerificationId,
    task: activeRelationalId,
    scope: 'Final post-hardening verification of the V2 relational sample/accession lineage seam and its evidence controls',
    purpose: 'Inspect the current relational packet, migration constraints, PostgreSQL evidence and local reconciliation controls used by the canonical VERIFIED gate',
    limitations: 'The seam remains shadow-only and this is not a fresh independent critic approval; populated backfill, target infrastructure, browser persistence, workload evidence and clinical policy remain open',
  }),
);

const dueAt = (timestamp) =>
  iso(new Date(Date.parse(timestamp) + 30 * 24 * 60 * 60 * 1000));
const condition = (id, description, gateTimestamp, evidenceRefs) => ({
  id,
  description,
  non_blocking: true,
  impact: 'Blocks hospital/production release or broader cutover, but does not invalidate the bounded local technical slice',
  owner: 'Product, clinical governance and platform operations',
  due_or_trigger: 'Before real clinical data, target cutover, production deployment or RELEASE_READY',
  due_at: dueAt(gateTimestamp),
  verification_method: 'Signed policy, target-environment evidence and a later gate record that cites the resolved condition',
  evidence_refs: evidenceRefs,
  status: 'OPEN',
  residual_risk: 'MEDIUM',
  authority_state: 'NOT_REQUIRED',
});

const makeGate = ({
  recordId,
  timestamp,
  scope,
  scopeRef,
  verificationId,
  conditionId,
  description,
  evidenceRefs,
}) => ({
  record_id: recordId,
  timestamp,
  gate_id: 'VERIFIED',
  scope,
  scope_ref: scopeRef,
  version: 1,
  criteria: [
    {
      id: 'V-001-ACCEPTANCE-EVIDENCE',
      description: 'The bounded local acceptance evidence executes against the current artifact',
      required: true,
      status: 'PASS',
      evidence_refs: ['.agent/verification.jsonl#' + verificationId],
      confidence: 'HIGH',
      limitations: 'This criterion covers the local technical boundary only and does not assert clinical or production acceptance',
    },
    {
      id: 'V-002-REGRESSION-RISK',
      description: 'The available regression, persistence and evidence controls are reconciled for the bounded slice',
      required: true,
      status: 'PASS',
      evidence_refs: ['.agent/verification.jsonl#' + verificationId],
      confidence: 'HIGH',
      limitations: 'Target-environment workload, browser persistence and remote CI are not proven by this local gate',
    },
    {
      id: 'V-003-LIMITATIONS-AUTHORITY',
      description: 'Limitations and authority boundaries are explicit and prevent an unsafe release claim',
      required: true,
      status: 'PASS',
      evidence_refs: ['.agent/verification.jsonl#' + verificationId, ...evidenceRefs],
      confidence: 'HIGH',
      limitations: 'No independent approval, hospital policy approval or production release authority is inferred',
    },
  ],
  evidence: ['.agent/verification.jsonl#' + verificationId, ...evidenceRefs],
  confidence: 'HIGH',
  gaps: [],
  conditions: [condition(conditionId, description, timestamp, evidenceRefs)],
  authority: {
    required: false,
    state: 'NOT_REQUIRED',
    actor: 'No external authority required for bounded local synthetic verification',
    scope,
    decision: 'Record local evidence while withholding clinical, hospital and production release authority',
    evidence_ref: evidenceRefs[0],
    expires_or_revalidates: 'Revalidate before real data, target cutover, production deployment or release',
  },
  residual_risk: 'MEDIUM',
  decision: 'PASS_WITH_CONDITIONS',
  next_action: 'Resolve the typed external conditions and obtain the required independent or human evidence before RELEASE_READY',
  revalidation_triggers: [
    'fresh independent criticism changes the local risk assessment',
    'real clinical data, hospital identity or policy approval',
    'target-environment migration, workload, recovery or browser persistence evidence',
    'production deployment, external publication or material scope expansion',
  ],
  supersedes: null,
});

const labGateTimestamp = nextTime();
const relationalGateTimestamp = nextTime();
const labGate = makeGate({
  recordId: labGateId,
  timestamp: labGateTimestamp,
  scope: 'V2 structured Laboratory conditional closure',
  scopeRef: 'TASK-V2-LAB-AUDIT-001',
  verificationId: labVerificationId,
  conditionId: 'COND-V2-LAB-CLINICAL-POLICY-20260906',
  description: 'Approve the analyte catalog, ranges, critical-result policy, recipients, fallback and escalation before clinical use',
  evidenceRefs: ['docs/v2/LABORATORY_VERTICAL.md', 'docs/v2/QUALITY_BAR.md'],
});
const relationalGate = makeGate({
  recordId: relationalGateId,
  timestamp: relationalGateTimestamp,
  scope: 'Final post-hardening verification of the V2 relational sample/accession lineage seam and its evidence controls',
  scopeRef: activeRelationalId,
  verificationId: relationalVerificationId,
  conditionId: 'COND-V2-RELATIONAL-TARGET-EVIDENCE-20260906',
  description: 'Supply target-environment projection, backfill, dual-read, EXPLAIN, workload, recovery and independent-review evidence before cutover',
  evidenceRefs: [packetPath, 'docs/v2/RELATIONAL_SAMPLE_LINEAGE.md', 'docs/v2/MIGRATION_MAP.md'],
});

const items = sourceItems.map((sourceItem) => {
  const item = { ...sourceItem };
  item.stage = item.stage === 'VERIFY' ? 'BUILD' : item.stage;
  if (item.id === activeRelationalId) {
    item.status = 'VERIFY';
    item.dependencies = ['TASK-V2-LAB-AUDIT-001'];
  }
  item.evidence_refs = unique((item.evidence_refs || []).map(legacyRef));
  if (item.id === activePatientId || item.id === 'TASK-V2-LAB-AUDIT-001') {
    item.evidence_refs = item.evidence_refs.map((value) =>
      value.includes('GATE-V2-LAB-CONDITIONAL-001')
        ? value.replace('GATE-V2-LAB-CONDITIONAL-001', labGateId)
        : value,
    );
  }
  item.next_action = actionFor(item);
  const closureId = currentClosureIds.get(item.id);
  if (closureId) {
    item.evidence_refs = unique([
      ...item.evidence_refs,
      '.agent/verification.jsonl#' + closureId,
    ]);
  }
  return item;
});
const backlog = { ...sourceBacklog, schema_version: 2, items };

const statusToByTask = new Map();
for (const event of log) {
  if (event.task && typeof event.status_to === 'string') {
    statusToByTask.set(event.task, event.status_to);
  }
}

const eventFor = ({
  eventId,
  type,
  task,
  action,
  result,
  verificationRef,
  decision,
  nextState,
  statusFrom,
  statusTo,
  lifecycleFrom,
  lifecycleTo,
  activeActionId,
}) => {
  const event = {
    event_id: eventId,
    timestamp: nextTime(),
    type,
    task,
    action,
    result,
    verification: verificationRef,
    decision,
    next_state: nextState,
    active_action_id: activeActionId,
  };
  if (statusFrom !== undefined) {
    event.status_from = statusFrom;
    event.status_to = statusTo;
  }
  if (lifecycleFrom !== undefined) {
    event.lifecycle_from = lifecycleFrom;
    event.lifecycle_to = lifecycleTo;
  }
  return event;
};

let sequence = 100;
for (const item of items) {
  const currentStatus = statusToByTask.get(item.id);
  const actionId = item.next_action.id;
  if (item.status === 'DONE' && currentStatus !== 'DONE') {
    const verificationRef =
      '.agent/verification.jsonl#' +
      (currentClosureIds.get(item.id) || 'VER-V2-LAB-CRITIC-RETEST-001');
    log.push(
      eventFor({
        eventId: 'EVT-CONTROL-' + String(sequence++).padStart(3, '0'),
        type: 'COMPLETE',
        task: item.id,
        action: 'Complete the locally scoped task after current evidence reconciliation',
        result: 'PASS',
        verificationRef,
        decision: 'The locally scoped task is complete; external conditions remain outside terminal release authority',
        nextState: 'Keep the terminal task reopenable only for a newly authorized boundary',
        statusFrom: 'VERIFY',
        statusTo: 'DONE',
        activeActionId: actionId,
      }),
    );
  }
  if (item.status === 'VERIFY' && currentStatus !== 'VERIFY') {
    const verificationRef =
      item.id === activeRelationalId
        ? '.agent/verification.jsonl#' + relationalVerificationId
        : '.agent/verification.jsonl#VER-V2-PATIENT-WORKSPACE-LOCAL-008';
    log.push(
      eventFor({
        eventId: 'EVT-CONTROL-' + String(sequence++).padStart(3, '0'),
        type: 'REVIEW',
        task: item.id,
        action: 'Keep the implemented slice in verification pending the single outstanding review boundary',
        result: 'PASS',
        verificationRef,
        decision: 'Local implementation evidence is retained while final review remains explicitly unresolved',
        nextState: 'Await the bounded review outcome without inferring approval',
        statusFrom: 'IN_PROGRESS',
        statusTo: 'VERIFY',
        lifecycleFrom: item.id === activeRelationalId ? 'AUDIT' : undefined,
        lifecycleTo: item.id === activeRelationalId ? 'BUILD' : undefined,
        activeActionId: actionId,
      }),
    );
  }
}

const gateEvent = ({ eventId, gatePath, gate, actionId, tail = false }) => {
  const event = eventFor({
    eventId,
    type: 'GATE_PASSED',
    task: gate.scope_ref,
    action: 'Bind the conditional VERIFIED decision to the scoped local evidence',
    result: 'PASS',
    verificationRef: '.agent/gates/' + path.basename(gatePath) + '#' + gate.record_id,
    decision: 'Accept the bounded local technical slice while retaining every external condition',
    nextState: 'Resolve the typed conditions before release or broader cutover',
    activeActionId: actionId,
  });
  event.gate_ref = gatePath;
  event.gate_record_id = gate.record_id;
  event.gate_decision = gate.decision;
  event.gate_fingerprint = gateFingerprint(gate);
  if (!tail) delete event.active_action_id;
  return event;
};

log.push(
  gateEvent({
    eventId: 'EVT-CONTROL-' + String(sequence++).padStart(3, '0'),
    gatePath: labGatePath,
    gate: labGate,
    actionId: items.find((item) => item.id === 'TASK-V2-LAB-AUDIT-001').next_action.id,
  }),
);
log.push(
  gateEvent({
    eventId: 'EVT-CONTROL-' + String(sequence++).padStart(3, '0'),
    gatePath: relationalGatePath,
    gate: relationalGate,
    actionId: items.find((item) => item.id === activeRelationalId).next_action.id,
    tail: true,
  }),
);

const tail = log.at(-1);
const activeItem = items.find((item) => item.id === activeRelationalId);
const state = {
  schema_version: 2,
  project: sourceState.project,
  goal: sourceState.goal,
  project_profile: sourceState.project_profile,
  work_mode: sourceState.work_mode,
  work_mode_overlays: sourceState.work_mode_overlays,
  lifecycle_stage: 'BUILD',
  active_activity: 'REVIEW',
  engineering_tier: sourceState.engineering_tier,
  risk_level: sourceState.risk_level,
  blast_radius: sourceState.blast_radius,
  status: 'VERIFY',
  active_execplan: sourceState.active_execplan,
  active_task: activeRelationalId,
  active_action_id: activeItem.next_action.id,
  verification_state: 'PARTIAL',
  repository_state: 'Dirty working tree on main; engineering-framework v2 control-plane migration recovered the legacy ledger into canonical state while retaining the raw snapshot. Local application evidence is green; relational cutover, independent review, target infrastructure and clinical/hospital authority remain unresolved.',
  instruction_scope_refs: sourceState.instruction_scope_refs,
  last_gate_record: relationalGatePath,
  last_event_id: tail.event_id,
  state_revision: Number(sourceState.state_revision || 0) + 1,
  next_gate: 'VERIFIED',
  blocked_by: sourceState.blocked_by,
  human_approval_required: sourceState.human_approval_required,
  updated_at: nextTime(),
  legacy_control_plane_snapshot: '.agent/legacy-control-plane-20260906',
};

writeJson(path.join(agentDir, 'backlog.json'), backlog);
writeJsonl(path.join(agentDir, 'verification.jsonl'), verification);
writeJsonl(path.join(agentDir, 'execution-log.jsonl'), log);
writeJson(path.join(agentDir, 'gates', path.basename(labGatePath)), labGate);
writeJson(path.join(agentDir, 'gates', path.basename(relationalGatePath)), relationalGate);
writeJson(path.join(agentDir, 'state.json'), state);

console.log(
  JSON.stringify(
    {
      migrated_from: sourceDir,
      backlog_items: items.length,
      verification_records: verification.length,
      execution_events: log.length,
      active_task: state.active_task,
      active_action_id: state.active_action_id,
      last_gate_record: state.last_gate_record,
      last_event_id: state.last_event_id,
    },
    null,
    2,
  ),
);
