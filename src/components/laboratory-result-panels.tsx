import type { LaboratoryPanelTemplate, LaboratoryReferenceRange, StructuredLaboratoryResultContent } from "@cvg/contracts";

export function referenceRangeLabel(referenceRange: LaboratoryReferenceRange | null | undefined): string {
  if (!referenceRange || referenceRange.kind === "PENDING_POLICY") return "Faixa pendente de aprovação";
  if (referenceRange.low !== undefined && referenceRange.high !== undefined) return `${referenceRange.low} – ${referenceRange.high} ${referenceRange.unitCode}`;
  if (referenceRange.low !== undefined) return `≥ ${referenceRange.low} ${referenceRange.unitCode}`;
  if (referenceRange.high !== undefined) return `≤ ${referenceRange.high} ${referenceRange.unitCode}`;
  return "Faixa configurada sem limites";
}

function flagLabel(flag: string): string {
  return ({ NORMAL: "Normal", LOW: "Baixo", HIGH: "Alto", UNINTERPRETED: "Não interpretado" } as Record<string, string>)[flag] ?? flag;
}

export function RecordedLaboratoryResultPanel({ content }: { content: StructuredLaboratoryResultContent }) {
  return <section className="laboratory-result" aria-label="Conteúdo laboratorial registrado"><h3>{content.panelCode} · revisão {content.panelVersion}</h3><table className="laboratory-table"><thead><tr><th scope="col">Analito registrado</th><th scope="col">Valor</th><th scope="col">Unidade</th><th scope="col">Faixa registrada</th><th scope="col">Interpretação</th></tr></thead><tbody>{content.observations.map((observation) => <tr key={observation.analyteCode}><th scope="row">{observation.analyteCode}</th><td>{String(observation.value)}</td><td>{observation.unitCode}</td><td>{referenceRangeLabel(observation.referenceRange)}</td><td>{flagLabel(observation.flag)}</td></tr>)}</tbody></table><p>Exibimos o conteúdo desta versão; a definição histórica do catálogo pode não estar disponível.</p></section>;
}

export function LaboratoryResultPanel({ template, content }: { template: LaboratoryPanelTemplate; content?: StructuredLaboratoryResultContent }) {
  if (!content) {
    return <section className="laboratory-result" aria-label={`Painel laboratorial ${template.name}`}>
      <div className="laboratory-result-heading"><div><span className="eyebrow">Painel estruturado</span><h3>{template.name}</h3></div><small>revisão {template.version}</small></div>
      <p className="laboratory-legacy-note" role="status">Este draft ainda usa conteúdo legado e não representa um resultado laboratorial preenchido.</p>
      <p className="laboratory-legacy-note">Abra <strong>Editar draft</strong>, preencha os analitos obrigatórios e salve antes de liberar.</p>
    </section>;
  }
  const observations = new Map(content.observations.map((observation) => [observation.analyteCode, observation]));
  return <section className="laboratory-result" aria-label={`Painel laboratorial ${template.name}`}>
    <div className="laboratory-result-heading"><div><span className="eyebrow">Painel estruturado</span><h3>{template.name}</h3></div><small>revisão {template.version}</small></div>
    <div className="laboratory-table-wrap"><table className="laboratory-table"><thead><tr><th scope="col">Analito</th><th scope="col">Valor</th><th scope="col">Unidade</th><th scope="col">Faixa de referência</th><th scope="col">Interpretação</th></tr></thead><tbody>{template.analytes.map((analyte) => { const observation = observations.get(analyte.code); return <tr key={analyte.code}><th scope="row">{analyte.label}{analyte.required && <span aria-label="obrigatório"> *</span>}</th><td>{observation ? String(observation.value) : "—"}</td><td>{analyte.unitCode}</td><td>{referenceRangeLabel(observation?.referenceRange ?? analyte.referenceRange)}</td><td>{observation ? flagLabel(observation.flag) : "Pendente"}</td></tr>; })}</tbody></table></div>
    {template.analytes.some((analyte) => analyte.referenceRange?.source === "PENDING_HUMAN_POLICY") && <p className="laboratory-policy-note">As faixas exibidas como pendentes aguardam aprovação clínica humana; o sistema não infere limites nem criticidade.</p>}
  </section>;
}
