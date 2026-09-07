/** @vitest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "./error";
import Loading from "./loading";
import NotFound from "./not-found";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

describe("application boundaries", () => {
  it("announces the root loading boundary without exposing a decorative spinner", () => {
    render(<Loading />);

    const status = screen.getByRole("status", { name: "Carregando o conteúdo da página." });
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.querySelector(".loading-mark")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the global error boundary actionable without leaking raw error details", () => {
    const reset = vi.fn();
    render(<ErrorPage error={Object.assign(new Error("internal database detail"), { digest: "digest-123" })} reset={reset} />);

    expect(screen.getByRole("heading", { name: "Não foi possível carregar esta página." })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Tente novamente para continuar.");
    expect(screen.queryByText("internal database detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("gives a missing route a clear heading and recovery link", () => {
    render(<NotFound />);

    expect(screen.getByRole("heading", { name: "Página não encontrada" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar ao início" })).toHaveAttribute("href", "/");
  });
});
