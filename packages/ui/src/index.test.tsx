/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActionButton, SectionHeading, Surface } from "./index";

afterEach(() => {
  cleanup();
});

describe("Surface", () => {
  it("renders a labelled semantic section with forwarded props and children", () => {
    render(
      <Surface
        aria-label="Resumo do diagnóstico"
        className="diagnostic-surface"
        data-testid="diagnostic-surface"
        id="diagnostic-summary"
      >
        Conteúdo do resumo
      </Surface>,
    );

    const surface = screen.getByRole("region", { name: "Resumo do diagnóstico" });

    expect(surface).toHaveAttribute("data-ui-surface", "true");
    expect(surface).toHaveAttribute("data-testid", "diagnostic-surface");
    expect(surface).toHaveAttribute("id", "diagnostic-summary");
    expect(surface).toHaveClass("ui-surface", "diagnostic-surface");
    expect(surface).toHaveTextContent("Conteúdo do resumo");
  });
});

describe("ActionButton", () => {
  it("uses the primary/button defaults and renders icon before children", () => {
    render(
      <ActionButton
        aria-label="Adicionar paciente"
        className="compact-action"
        icon={<span aria-hidden="true" data-testid="action-icon">+</span>}
      >
        Novo paciente
      </ActionButton>,
    );

    const button = screen.getByRole("button", { name: "Adicionar paciente" });

    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("button", "button-primary", "compact-action");
    expect(screen.getByTestId("action-icon")).toBeInTheDocument();
    expect(button).toHaveTextContent("+Novo paciente");
  });

  it.each([
    ["ghost", "button-ghost"],
    ["danger", "button-danger"],
  ] as const)("maps the %s tone to its class and forwards button props", (tone, toneClass) => {
    render(
      <ActionButton
        aria-pressed="true"
        data-testid={`${tone}-action`}
        name={`${tone}-action`}
        tone={tone}
        type="submit"
      >
        Continuar
      </ActionButton>,
    );

    const button = screen.getByTestId(`${tone}-action`);

    expect(button).toHaveClass("button", toneClass);
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("name", `${tone}-action`);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("Continuar");
  });

  it("exposes transaction state and fails closed while pending or denied", () => {
    const { rerender } = render(<ActionButton state="pending">Enviar</ActionButton>);
    const button = screen.getByRole("button", { name: "Enviar" });

    expect(button).toHaveAttribute("data-action-state", "pending");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();

    rerender(<ActionButton state="denied" aria-busy={false}>Enviar</ActionButton>);
    expect(button).toHaveAttribute("data-action-state", "denied");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");

    rerender(<ActionButton state="unknown">Tentar reconciliar</ActionButton>);
    expect(button).toHaveAttribute("data-action-state", "unknown");
    expect(button).not.toBeDisabled();
  });
});

describe("SectionHeading", () => {
  it("renders eyebrow, title, description, action, className, and semantic props", () => {
    render(
      <SectionHeading
        aria-label="Cabeçalho dos resultados"
        className="results-heading"
        data-testid="results-heading"
        id="results-title"
        role="group"
        eyebrow="Resultados"
        title="Exames recentes"
        description="Acompanhe os exames mais recentes do paciente."
        action={<button type="button">Ver todos</button>}
      />,
    );

    const heading = screen.getByRole("group", { name: "Cabeçalho dos resultados" });

    expect(heading).toHaveClass("ui-section-heading", "results-heading");
    expect(heading).toHaveAttribute("data-testid", "results-heading");
    expect(heading).toHaveAttribute("id", "results-title");
    expect(screen.getByText("Resultados")).toHaveClass("eyebrow");
    expect(screen.getByRole("heading", { level: 2, name: "Exames recentes" })).toBeInTheDocument();
    expect(screen.getByText("Acompanhe os exames mais recentes do paciente.")).toHaveClass(
      "ui-section-heading-description",
    );
    expect(screen.getByRole("button", { name: "Ver todos" })).toBeInTheDocument();
  });

  it("omits optional slots when they are not provided", () => {
    render(<SectionHeading title="Fila de solicitações" />);

    expect(screen.getByRole("heading", { level: 2, name: "Fila de solicitações" })).toBeInTheDocument();
    expect(screen.queryByText("Resultados")).not.toBeInTheDocument();
    expect(screen.queryByText("Acompanhe os exames mais recentes do paciente.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector(".eyebrow")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-section-heading-description")).not.toBeInTheDocument();
  });
});
