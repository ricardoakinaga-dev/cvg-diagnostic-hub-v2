import { AppShell } from "@/components/app-shell";
import { ArchivedRequest } from "@/components/archived-request";

export default async function ArchivedRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <ArchivedRequest requestId={id} />
    </AppShell>
  );
}
