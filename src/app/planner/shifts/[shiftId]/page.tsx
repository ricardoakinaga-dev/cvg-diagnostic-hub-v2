import { AppShell } from "@/components/app-shell";
import { PlannerShiftDetail } from "@/components/planner-shift-view";
export default async function Page({ params }: { params: Promise<{ shiftId: string }> }) { const { shiftId } = await params; return <AppShell><PlannerShiftDetail shiftId={shiftId} /></AppShell>; }
