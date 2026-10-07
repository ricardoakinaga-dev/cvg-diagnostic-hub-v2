"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Patient, SearchResult } from "@cvg/contracts";
import { apiFetch } from "./api-client";
import { Icon } from "./ui-icons";
import { useDialogFocus } from "./use-dialog-focus";
import styles from "./command-palette.module.css";

interface CommandPaletteProps {
  canCreatePatient: boolean;
  canCreateRequest: boolean;
  onClose: () => void;
  onNewPatient: () => void;
  onNewRequest: () => void;
  onNavigate: (href: string) => void;
}

interface SearchState {
  query: string;
  patients: Patient[];
  exams: SearchResult[];
  error: string;
}

interface Command {
  id: string;
  label: string;
  detail: string;
  run: () => void;
}

const navigationCommands = [
  { label: "Ir para Início", href: "/" },
  { label: "Ir para Meu trabalho", href: "/queues?view=mine" },
  { label: "Ir para Todos os exames", href: "/queues" },
  { label: "Ir para Caixa de entrada", href: "/notifications" },
  { label: "Ir para Pacientes", href: "/patients" },
  { label: "Exames em atraso", href: "/queues?preset=overdue" },
  { label: "Resultados para revisar", href: "/queues?preset=results" }
];

function normalizeCommand(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
}

export function CommandPalette({ canCreatePatient, canCreateRequest, onClose, onNewPatient, onNewRequest, onNavigate }: CommandPaletteProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState<SearchState | null>(null);
  const listId = useId();
  const titleId = useId();
  const term = query.trim();
  const searchable = Array.from(term).length >= 2;
  const currentSearch = search?.query === term ? search : null;
  const busy = searchable && !currentSearch;
  useDialogFocus(dialogRef, onClose, inputRef);

  useEffect(() => {
    const version = ++requestVersion.current;
    if (!searchable) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        apiFetch<Patient[]>(`/patients?q=${encodeURIComponent(term)}`, { signal: controller.signal }),
        apiFetch<SearchResult[]>(`/search?q=${encodeURIComponent(term)}&types=ITEM&limit=10`, { signal: controller.signal })
      ]).then(([patients, exams]) => {
        if (controller.signal.aborted || requestVersion.current !== version) return;
        setSearch({
          query: term,
          patients: patients.status === "fulfilled" ? patients.value.slice(0, 10) : [],
          exams: exams.status === "fulfilled" ? exams.value.filter((exam) => /^\/requests\/[^/?#]+(?:#[^/?#]+)?$/.test(exam.deepLink)).slice(0, 10) : [],
          error: patients.status === "rejected" && exams.status === "rejected"
            ? "Não foi possível buscar pacientes e exames."
            : patients.status === "rejected" ? "Não foi possível buscar pacientes."
              : exams.status === "rejected" ? "Não foi possível buscar exames." : ""
        });
      });
    }, 180);
    return () => {
      requestVersion.current = version + 1;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [retry, searchable, term]);

  const commands: Command[] = [
    ...(searchable ? currentSearch?.patients ?? [] : []).map((patient) => ({
      id: `patient-${patient.id}`,
      label: patient.displayName,
      detail: `Paciente · ${patient.species} · ${patient.ownerLabel}`,
      run: () => onNavigate(`/patients/${encodeURIComponent(patient.id)}/diagnostics`)
    })),
    ...(searchable ? currentSearch?.exams ?? [] : []).map((exam) => ({
      id: `exam-${exam.id}`,
      label: exam.label,
      detail: `Exame · ${exam.patient}`,
      run: () => onNavigate(exam.deepLink)
    })),
    ...(canCreateRequest ? [{ id: "new-request", label: "Novo exame", detail: "Abrir solicitação de exames", run: onNewRequest }] : []),
    ...(canCreatePatient ? [{ id: "new-patient", label: "Novo paciente", detail: "Cadastrar paciente", run: onNewPatient }] : []),
    ...navigationCommands.filter((command) => !term || normalizeCommand(command.label).includes(normalizeCommand(term))).map((command) => ({ id: `go-${command.href}`, label: command.label, detail: "Navegar", run: () => onNavigate(command.href) }))
  ];
  const selectedIndex = Math.min(activeIndex, Math.max(0, commands.length - 1));
  const resultCount = searchable ? (currentSearch?.patients.length ?? 0) + (currentSearch?.exams.length ?? 0) : 0;

  useEffect(() => {
    document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [commands.length, listId, selectedIndex, term]);

  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || commands.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : commands.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commands[selectedIndex]?.run();
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="dialog command-palette" role="dialog" aria-modal="true" aria-labelledby={titleId} data-dialog-layer="true">
      <div className="dialog-heading"><h2 id={titleId}>Atalhos e busca</h2><button type="button" className="icon-button" aria-label="Fechar atalhos e busca" onClick={onClose}><Icon name="close" size={18} /></button></div>
      <label>Buscar paciente ou exame<input ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={commands.length ? `${listId}-${selectedIndex}` : undefined} value={query} maxLength={200} placeholder="Nome, tutor, identificador ou exame…" onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleKeys} /></label>
      <p className="field-hint">Digite ao menos 2 caracteres. Use ↑ ↓ e Enter para escolher; Esc para fechar.</p>
      <div id={listId} role="listbox" aria-label="Pacientes, exames e ações" aria-busy={busy} className={styles.list}>
        {commands.map((command, index) => <div key={command.id} id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} className={styles.option} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={command.run}><span className={styles.copy}><strong>{command.label}</strong><small>{command.detail}</small></span><Icon name="arrow-right" size={15} /></div>)}
      </div>
      <p role="status" aria-live="polite">{busy ? "Buscando pacientes e exames…" : searchable ? `${resultCount} resultado${resultCount === 1 ? "" : "s"} encontrado${resultCount === 1 ? "" : "s"}.` : "Busque no seu escopo de acesso ou escolha uma ação."}</p>
      {currentSearch?.error && <div role="alert" className="form-alert">{currentSearch.error}<button type="button" className="button button-ghost" onClick={() => { setSearch(null); setRetry((current) => current + 1); }}>Tentar novamente</button></div>}
    </section>
  </div>;
}
