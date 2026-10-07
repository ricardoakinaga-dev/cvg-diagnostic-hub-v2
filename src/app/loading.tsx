import { LoadingState } from "@/components/feedback-states";

export default function Loading() {
  return <main aria-busy="true"><LoadingState className="loading-state" progressClassName="loading-mark" label="Carregando o conteúdo da página." /></main>;
}
