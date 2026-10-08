import { AppShell } from "@/components/app-shell";
import { SampleLabelView } from "@/components/sample-label";

export default async function SampleLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <SampleLabelView sampleId={id} />
    </AppShell>
  );
}
