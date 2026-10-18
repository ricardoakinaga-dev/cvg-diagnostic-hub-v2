export const ROLES = [
  "SUPERADMIN",
  "ADMIN",
  "MANAGER",
  "VETERINARIAN",
  "INPATIENT_TEAM",
  "LAB_TECH",
  "RADIOLOGY_TEAM",
  "ULTRASOUND_TEAM",
  "VIEWER"
] as const;
export type RoleCode = (typeof ROLES)[number];
