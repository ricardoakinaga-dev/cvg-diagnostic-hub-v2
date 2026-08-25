"use client";

import Link from "next/link";
import type { OperationalContext, OperationalEscalationLevel, Priority } from "@cvg/contracts";
import { Surface } from "@cvg/ui";
import { formatRelativeTime } from "@/components/api-client";
import { PriorityBadge, StatusBadge } from "@/components/status-badge";

export interface CommandCenterAttentionItem {
  id: string;
  requestId: string;
  requestCode: string;
  patient: { id: string; displayName: string; species: string; externalId: string };
  service: { id: string; name: string; workflowType: "LABORATORY" | "RADIOLOGY" | "ULTRASOUND" };
  departmentCode: string;
  status: Parameters<typeof StatusBadge>[0]["status"];
  priority: Priority;
  dueAt: string;
  overdue: boolean;
  nextAction: string;
  operationalContext: OperationalContext;
  deepLink: string;
}

export interface CommandCenterDepartment {
  departmentCode: string;
  label: string;
  activeItems: number;
  overdue: number;
  attention: number;
  state: "CLEAR" | "ACTIVE" | "ATTENTION";
}

export interface CommandCenterData {
  attention?: CommandCenterAttentionItem[];
  departments?: CommandCenterDepartment[];
  dataQuality?: { status: "FRESH" | "DEGRADED"; asOf: string; note?: string };
  updatedAt?: string;
}

const escalationLabels: Record<OperationalEscalationLevel, string> = {
  NONE: "No prazo",
  WATCH: "Acompanhar",
  ATTENTION: "Atenção",
  URGENT: "Urgente"
};

export function CommandCenterPanel({ data }: { data: CommandCenterData }) {
  const attention = data.attention ?? [];
  const departments = data.departments ?? [];
  const degraded = data.dataQuality?.status === "DEGRADED";

  return (
    <Surface className="panel command-center-panel" aria-labelledby="command-center-title">
      <div className="panel-heading command-center-heading">
        <div>
          <p className="eyebrow">Command Center</p>
          <h2 id="command-center-title">Atenção primeiro</h2>
          <p className="command-center-lede">Itens ativos ordenados por urgência operacional, prazo e próxima ação.</p>
        </div>
        <div className="command-center-meta">
          <span className={`data-quality data-quality-${degraded ? "degraded" : "fresh"}`} role="status">
            <span aria-hidden="true" />{degraded ? "Leitura parcial" : "Leitura atualizada"}
          </span>
          {data.updatedAt && <small>Atualizado {formatRelativeTime(data.updatedAt)}</small>}
        </div>
      </div>

      {attention.length === 0 ? (
        <div className="command-center-empty" role="status">
          <span aria-hidden="true">✓</span>
          <div><strong>Nenhum item requer atenção imediata</strong><p>Os itens ativos continuam disponíveis na Central de Exames.</p></div>
          <Link href="/queues" className="text-link">Abrir central <span>→</span></Link>
        </div>
      ) : (
        <ul className="command-center-attention">
          {attention.slice(0, 6).map((item) => <AttentionRow key={item.id} item={item} />)}
        </ul>
      )}

      <div className="command-center-footer">
        <div>
          <p className="eyebrow">Visão por setor</p>
          <div className="command-center-departments" aria-label="Estado operacional por setor">
            {departments.length === 0 ? <span className="command-center-muted">Nenhum setor no escopo atual.</span> : departments.map((department) => <DepartmentCard key={department.departmentCode} department={department} />)}
          </div>
        </div>
        <Link href="/queues" className="button button-ghost">Ver todas as filas <span>→</span></Link>
      </div>
    </Surface>
  );
}

function AttentionRow({ item }: { item: CommandCenterAttentionItem }) {
  const { operationalContext } = item;
  return (
    <li className={`command-center-row command-center-level-${operationalContext.escalationLevel.toLowerCase()}`}>
      <Link href={item.deepLink} className="command-center-row-link">
        <span className="command-center-row-priority" aria-label={escalationLabels[operationalContext.escalationLevel]}>{escalationLabels[operationalContext.escalationLevel]}</span>
        <span className="command-center-patient"><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId} · {item.requestCode}</small></span>
        <span className="command-center-service"><strong>{item.service.name}</strong><small>{item.departmentCode} · <StatusBadge status={item.status} /></small></span>
        <span className="command-center-next"><strong>{item.nextAction}</strong><small>{operationalContext.currentOwner.label}{operationalContext.blockedBy ? ` · ${operationalContext.blockedBy.label}` : ""}</small></span>
        <span className={`command-center-due ${item.overdue ? "text-danger" : ""}`}><strong>{item.overdue ? "Atrasado" : formatRelativeTime(item.dueAt)}</strong><small><PriorityBadge priority={item.priority} /></small></span>
        <span className="row-arrow" aria-hidden="true">→</span>
      </Link>
    </li>
  );
}

function DepartmentCard({ department }: { department: CommandCenterDepartment }) {
  const label = department.state === "ATTENTION" ? "Atenção" : department.state === "ACTIVE" ? "Ativo" : "Em dia";
  return <article className={`department-card department-${department.state.toLowerCase()}`}><div><strong>{department.label}</strong><span>{label}</span></div><b>{department.activeItems}</b><small>{department.attention > 0 ? `${department.attention} em atenção` : department.overdue > 0 ? `${department.overdue} atrasado(s)` : "itens ativos"}</small></article>;
}
