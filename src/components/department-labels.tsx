"use client";

import { createContext, useContext } from "react";
import { departmentLabel } from "./work-items/model";

const DepartmentLabels = createContext<Record<string, string> | undefined>(undefined);

export function DepartmentLabelsProvider({ names, children }: { names: Record<string, string>; children: React.ReactNode }) {
  return <DepartmentLabels.Provider value={names}>{children}</DepartmentLabels.Provider>;
}

/** The provider holds only names already authorized for the current viewer. */
export function useDepartmentName() {
  const names = useContext(DepartmentLabels);
  return (code: string) => names ? names[code] ?? code : departmentLabel(code);
}
