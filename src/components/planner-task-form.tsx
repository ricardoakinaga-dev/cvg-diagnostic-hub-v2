"use client";

import { useRef, useState } from "react";
import type { Department, HospitalChecklistTemplateView, HospitalServiceCatalogEntry, HospitalTaskType, HospitalTaskView, Priority, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { useDialogFocus } from "./use-dialog-focus";
import { usePlannerCommand } from "./planner-command";
import { PlannerContextFields, type PlannerCareContext } from "./planner-context-fields";
import { EMPTY_DOCUMENT, HospitalDocumentContentEditor } from "./hospital-document-content";
import { HospitalDocumentPicker } from "./hospital-document-bindings";
import { usePlannerPage } from "./use-planner";

export function PlannerTaskForm({ user, types, departments, parentTaskId, onCreated, onClose }: { user: SessionUser; types: HospitalTaskType[]; departments: Array<Pick<Department, "code" | "name" | "active">>; parentTaskId?: string; onCreated: (view: HospitalTaskView) => void; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null); const first = useRef<HTMLInputElement>(null);
  useDialogFocus(panel, onClose, first);
  const [rich, setRich] = useState(false); const [descriptionContent, setDescriptionContent] = useState(EMPTY_DOCUMENT);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [typeId, setTypeId] = useState(types.find((type) => type.active && !type.careContextRequired)?.id ?? "");
  const [departmentCode, setDepartmentCode] = useState(departments.find((department) => department.active && department.code === user.departmentCode)?.code ?? departments.find((department) => department.active)?.code ?? user.departmentCode);
  const [context, setContext] = useState<PlannerCareContext>({}); const [priority, setPriority] = useState<Priority>("ROUTINE");
  const [start, setStart] = useState(""); const [end, setEnd] = useState(""); const [inputError, setInputError] = useState("");
  const command = usePlannerCommand(); const [documentIds, setDocuments] = useState<string[]>([]);
  const [serviceId, setServiceId] = useState(""); const [checklistTemplateId, setChecklistTemplateId] = useState("");
  const services = usePlannerPage<HospitalServiceCatalogEntry>(user.id, `/hospital-services?departmentCode=${encodeURIComponent(departmentCode)}&limit=50`, user.permissions?.includes("service.catalog.view"));
  const templates = usePlannerPage<HospitalChecklistTemplateView>(user.id, `/hospital-checklist-templates?departmentCode=${encodeURIComponent(departmentCode)}&status=APPROVED&limit=50`, user.permissions?.includes("checklist_template.view"));
  const selectedTemplate = templates.items.find((entry) => entry.template.id === checklistTemplateId)?.template;
  const selectedType = types.find((type) => type.id === typeId && type.active);
  const careRequired = selectedType?.careContextRequired === true || selectedTemplate?.careContextRequired === true;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!user.permissions?.includes("hospital_task.create") || command.busy) return;
    setInputError("");
    try {
      if (!selectedType || !title.trim() || !departmentCode) throw new Error("Informe título, tipo e setor válidos.");
      if (checklistTemplateId && (!selectedTemplate || templates.error) || serviceId && (services.error || !services.items.some((service) => service.source === "HOSPITAL_SERVICE" && service.active && service.id === serviceId))) throw new Error("Atualize e escolha um serviço ativo e um modelo aprovado disponíveis no setor.");
      if (Boolean(context.patientId) !== Boolean(context.encounterId) || careRequired && (!context.patientId || !context.encounterId)) throw new Error("Uma atividade assistencial exige paciente e atendimento aberto.");
      const plannedStartAt = start ? hospitalDateTimeInputToIso(start) : undefined;
      const plannedEndAt = end ? hospitalDateTimeInputToIso(end) : undefined;
      if (plannedStartAt && plannedEndAt && Date.parse(plannedStartAt) > Date.parse(plannedEndAt)) throw new Error("O fim planejado não pode anteceder o início.");
      const result = await command.execute<HospitalTaskView>(((event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "draft" ? "/hospital-task-drafts" : "/hospital-tasks"), "POST", { title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), typeId, departmentCode, priority, ...(rich ? { descriptionContent } : {}), ...context, ...(documentIds.length ? { documentIds } : {}), ...(serviceId ? { serviceId } : {}), ...(checklistTemplateId ? { checklistTemplateId } : {}), ...(plannedStartAt ? { plannedStartAt } : {}), ...(plannedEndAt ? { plannedEndAt } : {}), ...(parentTaskId ? { parentTaskId } : {}) });
      if (result) onCreated(result);
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : "Revise os dados."); }
  }
  const activeDepartments = departments.filter((department) => department.active);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !command.busy) onClose(); }}><section ref={panel} className="dialog" role="dialog" aria-modal="true" data-dialog-layer="true" aria-labelledby="planner-task-create-title">
    <div className="dialog-heading"><h2 id="planner-task-create-title">{parentTaskId ? "Nova subtarefa" : "Nova atividade hospitalar"}</h2><button type="button" className="button button-ghost" onClick={onClose} disabled={command.busy}>Fechar</button></div>
    <form aria-label="Criar atividade hospitalar" onSubmit={(event) => void submit(event)}>
      <label>Título da atividade<input ref={first} value={title} required minLength={2} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Descrição<textarea value={description} maxLength={4000} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
      <label><input type="checkbox" checked={rich} onChange={(event) => setRich(event.target.checked)} />Adicionar descrição estruturada</label>{rich && <HospitalDocumentContentEditor value={descriptionContent} onChange={setDescriptionContent} disabled={command.busy} />}
      <label>Tipo de atividade<select value={typeId} required onChange={(event) => setTypeId(event.target.value)}><option value="">Selecione o tipo…</option>{types.filter((type) => type.active).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      <label>Setor da atividade<select value={departmentCode} required onChange={(event) => { setDepartmentCode(event.target.value); setServiceId(""); setChecklistTemplateId(""); setDocuments([]); }}>{!activeDepartments.some((department) => department.code === user.departmentCode) && <option value={user.departmentCode}>{user.departmentCode}</option>}{activeDepartments.map((department) => <option key={department.code} value={department.code}>{department.name}</option>)}</select></label>
      <label>Prioridade<select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="ROUTINE">Rotina</option><option value="URGENT">Urgente</option><option value="EMERGENCY">Emergência</option></select></label>
      {user.permissions?.includes("service.catalog.view") && <><label>Serviço hospitalar (opcional)<select value={serviceId} onChange={(event) => setServiceId(event.target.value)}><option value="">Sem vínculo de serviço</option>{services.items.filter((service) => service.source === "HOSPITAL_SERVICE" && service.active).map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>{services.error && <p role="alert">{services.error}</p>}{services.nextCursor && <button type="button" disabled={services.loadingMore} onClick={() => void services.loadMore()}>Mais serviços deste setor</button>}</>}
      {user.permissions?.includes("checklist_template.view") && <><label>Checklist aprovado (opcional)<select value={checklistTemplateId} onChange={(event) => setChecklistTemplateId(event.target.value)}><option value="">Sem checklist</option>{templates.items.map(({ template }) => <option key={template.id} value={template.id}>{template.name} · versão {template.version}</option>)}</select></label>{templates.error && <p role="alert">{templates.error}</p>}{templates.nextCursor && <button type="button" disabled={templates.loadingMore} onClick={() => void templates.loadMore()}>Mais modelos deste setor</button>}{selectedTemplate?.clinicalProcess && <p>Processo de {selectedTemplate.clinicalProcess.modality === "CARE" ? "cuidado" : "procedimento"} com confirmação própria e referência no sistema clínico. Esta atividade não cria um exame fictício.</p>}</>}
      <HospitalDocumentPicker user={user} departmentCode={departmentCode} value={documentIds} onChange={setDocuments} disabled={command.busy} />
      <PlannerContextFields value={context} onChange={setContext} required={careRequired} allowed={user.permissions?.includes("patient.view")} />
      <label>Início planejado<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Fim planejado<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><p className="field-hint">Datas no horário do hospital. Planejamento não reserva recursos ou leitos.</p>
      {(inputError || command.error) && <p role="alert" className="form-alert">{inputError || command.error}</p>}
      <div className="dialog-actions"><button type="button" className="button button-ghost" onClick={onClose} disabled={command.busy}>Cancelar</button><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Criar atividade</ActionButton>{!parentTaskId && <ActionButton type="submit" value="draft" state={command.busy ? "pending" : "idle"}>Salvar como rascunho privado</ActionButton>}</div>
    </form>
  </section></div>;
}
