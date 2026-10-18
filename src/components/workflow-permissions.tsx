"use client";

import { createContext, useContext } from "react";
import type { Permission } from "@cvg/contracts";

const NO_PERMISSIONS: readonly Permission[] = [];
const WorkflowPermissions = createContext<readonly Permission[]>(NO_PERMISSIONS);
export function WorkflowPermissionsProvider({ permissions, children }: { permissions?: readonly Permission[]; children: React.ReactNode }) {
  return <WorkflowPermissions.Provider value={permissions ?? NO_PERMISSIONS}>{children}</WorkflowPermissions.Provider>;
}
export function useWorkflowPermissions(permissions?: readonly Permission[]) {
  const inherited = useContext(WorkflowPermissions);
  return permissions ?? inherited;
}
