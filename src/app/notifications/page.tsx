import { AppShell } from "@/components/app-shell";
import { NotificationsView } from "@/components/notifications-view";

export default function NotificationsPage() {
  return (
    <AppShell flush>
      <NotificationsView />
    </AppShell>
  );
}
