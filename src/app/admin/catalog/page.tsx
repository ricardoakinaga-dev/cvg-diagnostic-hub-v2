import { AppShell } from "@/components/app-shell";
import { AdminConsole } from "@/components/admin-console";

export default function AdminCatalogPage() {
  return (
    <AppShell>
      <AdminConsole section="catalog" />
    </AppShell>
  );
}
