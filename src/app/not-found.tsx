import Link from "next/link";

export default function NotFound() {
  return (
    <main className="screen-center" aria-labelledby="not-found-title">
      <section
        className="panel empty-state"
        style={{ width: "min(100% - 32px, 420px)" }}
      >
        <span aria-hidden="true">404</span>
        <h1 id="not-found-title">Página não encontrada</h1>
        <p id="not-found-description">
          O endereço informado não corresponde a uma página disponível no CVG Diagnostics Hub.
        </p>
        <Link className="button button-primary" href="/" aria-describedby="not-found-description">
          Voltar ao início
        </Link>
      </section>
    </main>
  );
}
