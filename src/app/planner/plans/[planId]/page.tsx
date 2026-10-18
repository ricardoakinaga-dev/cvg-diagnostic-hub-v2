import { AppShell } from "@/components/app-shell";
import { PlannerPlanDetail } from "@/components/planner-plan-view";
export default async function Page({ params }: { params: Promise<{ planId: string }> }) { const { planId } = await params; return <AppShell><PlannerPlanDetail planId={planId} /></AppShell>; }
