import { AppShell } from "@/components/app-shell";
import { AdminConsole } from "@/components/admin-console";

export default function AdminUsersPage() {
  return (
    <AppShell>
      <AdminConsole section="users" />
    </AppShell>
  );
}
