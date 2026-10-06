import { AppShell } from "@/components/app-shell";
import { WorkItemsView } from "@/components/work-items/work-items-view";

export default function QueuesPage() {
  return (
    <AppShell flush>
      <WorkItemsView />
    </AppShell>
  );
}
