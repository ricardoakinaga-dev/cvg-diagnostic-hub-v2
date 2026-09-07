"use client";

export default function Error({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const reference = error.digest ? `Referência técnica: ${error.digest}` : null;

  return (
    <main className="screen-center" aria-labelledby="error-title">
      <section
        className="panel"
        style={{ width: "min(100% - 32px, 480px)", padding: "22px" }}
        role="alert"
      >
        <div className="error-state">
          <span aria-hidden="true">!</span>
          <div>
            <h1 id="error-title" className="error-state-title">Não foi possível carregar esta página.</h1>
            <p>Ocorreu um problema inesperado. Tente novamente para continuar.</p>
          </div>
        </div>

        <button className="button button-primary" type="button" onClick={reset}>
          Tentar novamente
        </button>

        {reference ? <p className="sr-only">{reference}</p> : null}
      </section>
    </main>
  );
}
