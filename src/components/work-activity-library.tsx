"use client";

import Link from "next/link";
import { useState } from "react";
import type { WorkActivityPreferenceView } from "@cvg/contracts";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { usePlannerIdentity, usePlannerPage } from "./use-planner";
import { WorkActivityDisclosure } from "./work-activity-controls";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";

export function WorkActivityLibrary() {
  const { user, error } = usePlannerIdentity(); const [mode, setMode] = useState("FAVORITES");
  const page = usePlannerPage<WorkActivityPreferenceView>(user?.id, `/work-activity-preferences?mode=${mode}&limit=50`, user?.permissions?.includes("work_activity.preference.manage"));
  if (error) return <ErrorState page title="Acompanhamento indisponível" message={error} onRetry={page.reload} />;
  if (!user) return <LoadingState label="Carregando acompanhamento pessoal" />;
  if (!user.permissions?.includes("work_activity.preference.manage")) return <ErrorState page title="Recurso fora do seu acesso" message="Você não tem acesso às preferências de trabalho." onRetry={page.reload} />;
  return <div className="detail-page"><h1>Meu acompanhamento</h1><p>Itens ainda autorizados, favoritos e notas particulares. Nenhum item desta lista amplia seu acesso.</p><label>Mostrar<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="FAVORITES">Favoritos</option><option value="RECENTS">Recentes</option><option value="FOLLOWING">Acompanhando</option><option value="NOTES">Com nota privada</option><option value="ALL">Todos</option></select></label>{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}{page.loading && <LoadingState label="Atualizando acompanhamento" />}<ul>{page.items.map(({ target, preference }) => <li key={preference.id}><Link href={target.deepLink}>{target.label}</Link> · {target.targetType}{preference.favoriteGroup && <p>Grupo pessoal: {preference.favoriteGroup}</p>}{preference.privateNote && <p>{preference.privateNote}</p>}{preference.lastOpenedAt && <p>Aberto em {formatHospitalDateTime(preference.lastOpenedAt)}</p>}<WorkActivityDisclosure user={user} targetType={target.targetType} targetId={target.targetId} readOnly={Boolean(page.error)} /></li>)}</ul>{!page.loading && !page.error && !page.items.length && <EmptyState title="Nenhum item nesta seleção" message="Use o acompanhamento no detalhe de uma atividade ou documento." />}{page.nextCursor && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>Carregar mais acompanhamentos</button>}</div>;
}
