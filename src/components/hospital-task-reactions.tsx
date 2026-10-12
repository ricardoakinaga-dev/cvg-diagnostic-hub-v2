"use client";

import type { HospitalTaskView, HospitalTaskCommentView, SessionUser } from "@cvg/contracts";
import { usePlannerCommand } from "./planner-command";

export function HospitalTaskReactions({ user, view, comment, disabled = false, onChanged }: { user: SessionUser; view: HospitalTaskView; comment?: HospitalTaskCommentView; disabled?: boolean; onChanged: () => void }) {
  const command = usePlannerCommand(); const may = user.permissions?.includes("hospital_task.comment.create") && view.permissions.includes("hospital_task.comment.create") && !view.task.isDraft && !view.task.archivedAt && !comment?.comment.deletedAt;
  if (!may) return null;
  const target = comment?.comment ?? view.task;
  return <div aria-label="Reações de conveniência"><p className="field-hint">Reações não confirmam leitura clínica, execução ou recebimento de plantão.</p>{(["LIKE", "THANKS", "QUESTION"] as const).map((code) => { const active = target.reactions?.some((reaction) => reaction.userId === user.id && reaction.code === code) === true; return <button type="button" key={code} disabled={disabled || command.busy} aria-pressed={active} onClick={() => void command.execute(`/hospital-tasks/${view.task.id}${comment ? `/comments/${comment.comment.id}` : ""}/reactions`, "PUT", { code, active: !active, expectedVersion: target.version }).then((result) => { if (result) onChanged(); })}>{{ LIKE: "Gostei", THANKS: "Obrigado", QUESTION: "Tenho uma dúvida" }[code]} · {target.reactions?.filter((reaction) => reaction.code === code).length ?? 0}</button>; })}{command.error && <p role="alert">{command.error}</p>}</div>;
}
