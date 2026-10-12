import type { HospitalCapacityView } from "@cvg/contracts";
import { formatHospitalDateTime } from "@/lib/hospital-time";

/** Technical measurement contract, not an institutional clinical approval. */
export const HOSPITAL_CAPACITY_DEFINITION_VERSION = "HPL-CAPACITY-1";
function quantity(value: number | null, unit: "MINUTES" | "BEDS") {
  return value === null ? "Não informada" : `${value} ${unit === "BEDS" ? "leito(s)" : "min"}`;
}
export function HospitalCapacityPanel({ data }: { data: HospitalCapacityView }) {
  return <section aria-label="Capacidade hospitalar">
    <h2>Capacidade hospitalar</h2>
    <p>Definição técnica {HOSPITAL_CAPACITY_DEFINITION_VERSION}; a aceitação institucional permanece pendente.</p>
    <p role="status">Posição em {formatHospitalDateTime(data.asOf)} · {formatHospitalDateTime(data.from)} até {formatHospitalDateTime(data.to)}</p>
    <p>Origem: inventário e janelas cadastradas em HospitalResource, reservas em Schedule, ocupação explícita em Admission e carga em DiagnosticItem e HospitalTask.</p>
    <p>Minutos representam janelas e reservas no período, incluindo o início e excluindo o fim. Leitos representam a ocupação atual, sem conversão para minutos. Os valores são por recurso; não há taxa de utilização nem presença profissional inferida.</p>
    <p>Base da capacidade: cada recurso autorizado e cadastrado, com suas próprias janelas ou ocupação explícita. Sem calendário ou sem conciliação de leitos, a disponibilidade permanece desconhecida.</p>
    <p>Reservas mantêm os horários planejados. Uma execução em andamento que atravessa o período deixa a disponibilidade desconhecida; o fim da reserva não estima quando a execução termina. Um recurso indisponível por manutenção continua com disponibilidade zero.</p>
    <section className="panel" aria-label="Carga autorizada"><h3>Carga autorizada</h3>
      <p>{data.authorizedLoad.openDiagnosticItems} exames ativos · {data.authorizedLoad.overdueDiagnosticItems} exames atrasados · {data.authorizedLoad.openHospitalTasks} atividades hospitalares ativas.</p>
      <p>Estimativa de esforço: {data.authorizedLoad.estimatedMinutes === null ? "Não informada; quantidade de itens não equivale a minutos de execução." : `${data.authorizedLoad.estimatedMinutes} min`}</p>
      <p>Denominador: toda a carga aberta atualmente autorizada nos setores selecionados, independentemente da criação no período. A soma exige estimativa explícita de cada atividade; qualquer item sem estimativa torna o total desconhecido. Exames não têm estimativa de esforço. Uma carga vazia corresponde a zero. Rascunhos privados, atividades arquivadas, descartadas ou encerradas ficam fora da carga.</p>
      <p>SLA diagnóstico: horas corridas desde a solicitação. A agenda de recursos não pausa nem recalcula esse relógio.</p>
    </section>
    <div className="table-scroll"><table><caption>Capacidade dos recursos autorizados</caption><thead><tr><th scope="col">Recurso</th><th scope="col">Unidade</th><th scope="col">Nominal</th><th scope="col">Reservada ou ocupada</th><th scope="col">Disponível</th><th scope="col">Indisponível</th></tr></thead><tbody>{data.resources.map(entry => <tr key={entry.resourceId}>
      <th scope="row">{entry.name} · {entry.code}<small>{entry.departmentCode}{!entry.availabilityKnown && " · disponibilidade desconhecida"}{entry.reason === "CALENDAR_NOT_CONFIGURED" && " · calendário não configurado"}{entry.reason === "LEGACY_OCCUPANCY_NOT_LINKED" && " · internações sem conciliação de leito"}{entry.reason === "RESOURCE_UNAVAILABLE" && " · recurso indisponível"}{entry.reason === "EXECUTION_END_UNKNOWN" && " · término da execução desconhecido"}</small></th>
      <td>{entry.unit === "BEDS" ? "Leitos" : "Minutos no período"}</td><td>{quantity(entry.nominal, entry.unit)}</td><td>{quantity(entry.reserved, entry.unit)}</td><td>{quantity(entry.available, entry.unit)}</td><td>{quantity(entry.unavailable, entry.unit)}</td>
    </tr>)}</tbody></table></div>
    {!data.resources.length && <p>Nenhum recurso autorizado neste período.</p>}
  </section>;
}
