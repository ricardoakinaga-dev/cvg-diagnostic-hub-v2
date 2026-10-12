"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionUser, WorkActivityPreferenceView, WorkActivityTargetType } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { usePlannerResource } from "./use-planner-resource";
import { usePlannerCommand } from "./planner-command";

export function WorkActivityDisclosure(props: { user: SessionUser; targetType: WorkActivityTargetType; targetId: string; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!props.user.permissions?.includes("work_activity.preference.manage")) return null;
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Seu acompanhamento desta referência</summary>{open && <WorkActivityControls {...props} />}</details>;
}

type ActivityControlProps = { user: SessionUser; targetType: WorkActivityTargetType; targetId: string; readOnly?: boolean };
export function WorkActivityControls(props: ActivityControlProps) {
  return <ActivityControls key={`${props.user.id}:${props.targetType}:${props.targetId}`} {...props} />;
}
function ActivityControls({ user, targetType, targetId, readOnly = false }: ActivityControlProps) {
  const enabled = user.permissions?.includes("work_activity.preference.manage") === true;
  const resource = usePlannerResource<{ items: WorkActivityPreferenceView[] }>(user.id, `/work-activity-preferences?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}&limit=1`, enabled);
  const opening = usePlannerCommand(); const recorded = useRef(""); const [opened, setOpened] = useState<{ scope: string; preference?: WorkActivityPreferenceView["preference"] }>(); const scope = `${user.id}:${targetType}:${targetId}`; const currentScope = useRef<string | undefined>(scope);
  const latestResource = useRef(resource);
  useEffect(() => { latestResource.current = resource; }, [resource]);
  useEffect(() => { currentScope.current = scope; return () => { currentScope.current = undefined; }; }, [scope]);
  useEffect(() => { if (!enabled || readOnly || !resource.data || resource.error || resource.loading || recorded.current === scope) return; recorded.current = scope; void opening.execute<WorkActivityPreferenceView>("/work-activity-preferences", "PUT", { targetType, targetId, opened: true, hiddenFromRecents: false, expectedVersion: resource.data.items[0]?.preference.version ?? 0 }).then((result) => { if (currentScope.current !== scope) return; const latest = latestResource.current; if (result && latest.data && !latest.loading && !latest.error && (latest.data.items[0]?.preference.version ?? 0) <= result.preference.version) latest.saved({ items: [result] }); setOpened({ scope, preference: result?.preference }); }); }, [enabled, readOnly, resource, scope, opening, targetType, targetId]);
  if (!enabled) return null;
  if (resource.error && !resource.data) return <p role="alert">{resource.error} <button type="button" onClick={() => void resource.reload()}>Recarregar preferências privadas</button></p>;
  if (!resource.data) return <p role="status">Carregando suas preferências desta atividade…</p>;
  if (!readOnly && opened?.scope !== scope || opening.busy) return <p role="status">Registrando abertura nos seus recentes…</p>;
  const preference = resource.data.items[0]?.preference;
  return <>{opening.error && <p role="alert">{opening.error} <button type="button" onClick={() => void resource.reload()}>Recarregar acompanhamento desta atividade</button></p>}{resource.error && <p role="alert">{resource.error} <button type="button" onClick={() => void resource.reload()}>Recarregar preferências privadas</button></p>}{resource.loading && <p role="status">Revalidando suas preferências privadas…</p>}<PreferenceEditor targetType={targetType} targetId={targetId} preference={preference} initialPreference={opened?.preference ?? preference} disabled={readOnly || resource.loading || Boolean(resource.error)} onSaved={(result) => { const latest = latestResource.current; if (currentScope.current === scope && latest.data && !latest.loading && !latest.error && (latest.data.items[0]?.preference.version ?? 0) <= result.preference.version) latest.saved({ items: [result] }); }} /></>;
}
function PreferenceEditor({ targetType, targetId, preference, initialPreference, disabled, onSaved }: { targetType: WorkActivityTargetType; targetId: string; preference?: WorkActivityPreferenceView["preference"]; initialPreference?: WorkActivityPreferenceView["preference"]; disabled: boolean; onSaved: (result: WorkActivityPreferenceView) => void }) {
  // Our own opening is the editor base; concurrent reads still decide access and external conflicts.
  const command = usePlannerCommand(); const [base, setBase] = useState(initialPreference); const [note, setNote] = useState(initialPreference?.privateNote ?? ""); const [notice, setNotice] = useState(""); const [group, setGroup] = useState(initialPreference?.favoriteGroup ?? "");
  const active = useRef(true); useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const conflict = (preference?.version ?? 0) > (base?.version ?? 0);
  async function save(fields: { favorite?: boolean; following?: boolean; opened?: boolean; hiddenFromRecents?: boolean; privateNote?: string | null; favoriteGroup?: string | null }) {
    if (disabled || conflict) return;
    const result = await command.execute<WorkActivityPreferenceView>("/work-activity-preferences", "PUT", { targetType, targetId, expectedVersion: base?.version ?? 0, ...fields });
    if (!result || !active.current) return;
    setBase(result.preference);
    if (fields.privateNote !== undefined) setNote(result.preference.privateNote ?? "");
    if (fields.favoriteGroup !== undefined) setGroup(result.preference.favoriteGroup ?? "");
    setNotice("Preferência privada salva."); onSaved(result);
  }
  function reconcile() { if (disabled) return; setBase(preference); setNote(preference?.privateNote ?? ""); setGroup(preference?.favoriteGroup ?? ""); setNotice(""); }
  return <section className="panel" aria-label="Preferências privadas"><h2>Seu acompanhamento</h2><p className="field-hint">Favorito, acompanhamento e nota são pessoais. Não alteram responsabilidade, prioridade ou execução.</p>{conflict && <p role="alert">Outra alteração mudou estas preferências. Seu texto permanece. <button type="button" disabled={disabled || command.busy} onClick={reconcile}>Recarregar preferências e descartar meu texto</button></p>}<fieldset disabled={disabled || conflict || command.busy}><button type="button" aria-pressed={base?.favorite ?? false} onClick={() => void save({ favorite: !base?.favorite })}>{base?.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}</button><button type="button" aria-pressed={base?.following ?? false} onClick={() => void save({ following: !base?.following })}>{base?.following ? "Deixar de acompanhar" : "Acompanhar alterações"}</button><button type="button" onClick={() => void save({ opened: true, hiddenFromRecents: false })}>Registrar nos meus recentes</button>{base?.lastOpenedAt && <button type="button" onClick={() => void save({ hiddenFromRecents: true })}>Remover dos recentes</button>}<form aria-label="Agrupar favorito" onSubmit={(event) => { event.preventDefault(); void save({ favorite: true, favoriteGroup: group.trim() || null }); }}><label>Grupo pessoal do favorito<input maxLength={80} value={group} onChange={(event) => setGroup(event.target.value)} /></label><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar grupo do favorito</ActionButton></form><form aria-label="Nota privada" onSubmit={(event) => { event.preventDefault(); void save({ privateNote: note.trim() || null }); }}><label>Sua nota privada<textarea maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)} /></label><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar nota privada</ActionButton></form></fieldset>{command.error && <p role="alert">{command.error}</p>}{notice && <p role="status">{notice}</p>}</section>;
}
