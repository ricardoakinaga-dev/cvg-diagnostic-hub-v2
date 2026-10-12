import { AppShell } from "@/components/app-shell";
import { PlannerTaskDetail } from "@/components/planner-task-detail";
export default async function PlannerTaskPage({ params }: { params: Promise<{ taskId: string }> }) { const { taskId } = await params; return <AppShell><PlannerTaskDetail taskId={taskId} /></AppShell>; }
