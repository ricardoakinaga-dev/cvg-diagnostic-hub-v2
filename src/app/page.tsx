import { AppShell } from "@/components/app-shell";
import { Home } from "@/components/home-view";

export default function HomePage() {
  return (
    <AppShell flush>
      <Home />
    </AppShell>
  );
}
