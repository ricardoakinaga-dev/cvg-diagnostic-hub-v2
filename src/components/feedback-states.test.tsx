/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState, ErrorState, LoadingState, PartialNotice, StaleNotice } from "./feedback-states";

describe("feedback state primitives", () => {
  afterEach(() => {
    cleanup();
  });

  it("descreve dados confirmados preservados e expõe a ação de atualização", () => {
    const onRetry = vi.fn();

    render(<StaleNotice lastConfirmedAt="Hoje, às 10:30" onRetry={onRetry} />);

    const notice = screen.getByRole("status", { name: "Dados desatualizados" });
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent("A última informação confirmada continua visível");
    expect(notice).toHaveTextContent("Última confirmação: Hoje, às 10:30");

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("expõe a leitura parcial como um status não bloqueante", () => {
    render(<PartialNotice title="Resultados incompletos" message="A seção de anexos está indisponível." />);

    const notice = screen.getByRole("status", { name: "Resultados incompletos" });
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent("A seção de anexos está indisponível.");
  });

  it("expõe erro recuperável e chama o callback de retry", () => {
    const onRetry = vi.fn();

    render(
      <ErrorState
        title="Não foi possível carregar os pacientes"
        message="A conexão pode ter sido interrompida."
        onRetry={onRetry}
        retryLabel="Recarregar pacientes"
      />
    );

    const error = screen.getByRole("alert", { name: "Não foi possível carregar os pacientes" });
    expect(error).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByRole("button", { name: "Recarregar pacientes" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Recarregar pacientes" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("expõe estado vazio e chama a ação opcional", () => {
    const onAction = vi.fn();

    render(
      <EmptyState
        title="Nenhuma solicitação encontrada"
        message="Ajuste os filtros para ampliar a busca."
        actionLabel="Limpar filtros"
        onAction={onAction}
      />
    );

    expect(screen.getByRole("status", { name: "Nenhuma solicitação encontrada" })).toHaveTextContent(
      "Ajuste os filtros para ampliar a busca."
    );
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("marca o carregamento com status e busy para tecnologias assistivas", () => {
    render(<LoadingState label="Carregando fila de exames" />);

    const loading = screen.getByRole("status", { name: "Carregando fila de exames" });
    expect(loading).toHaveAttribute("aria-live", "polite");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Carregando fila de exames");
  });
});
