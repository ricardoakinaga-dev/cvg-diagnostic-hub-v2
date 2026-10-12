import { AppShell } from "@/components/app-shell";
import { HospitalDocumentDetail } from "@/components/hospital-document-detail";
export default async function Page({ params }: { params: Promise<{ documentId: string }> }) { const { documentId } = await params; return <AppShell><HospitalDocumentDetail documentId={documentId} /></AppShell>; }
