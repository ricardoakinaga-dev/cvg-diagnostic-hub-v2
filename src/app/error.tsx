"use client";

import { ErrorState } from "@/components/feedback-states";

export default function Error({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const reference = error.digest ? `Referência técnica: ${error.digest}` : null;

  return (
    <main className="screen-center">
      <ErrorState
        className="panel"
        style={{ width: "min(100% - 32px, 480px)", padding: "22px" }}
        title="Não foi possível carregar esta página."
        message="Ocorreu um problema inesperado. Tente novamente para continuar."
        onRetry={reset}
        retryLabel="Tentar novamente"
      />
        {reference ? <p className="sr-only">{reference}</p> : null}
    </main>
  );
}
