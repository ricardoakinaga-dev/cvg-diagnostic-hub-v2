export default function Loading() {
  return (
    <main className="loading-state" aria-busy="true" aria-live="polite">
      <div role="status" aria-label="Carregando o conteúdo da página." aria-busy="true">
        <div className="loading-mark" aria-hidden="true" />
        <span className="sr-only">Carregando o conteúdo da página.</span>
      </div>
    </main>
  );
}
