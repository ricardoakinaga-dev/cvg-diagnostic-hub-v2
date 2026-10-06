import { AppShell } from "@/components/app-shell";
import { PatientList } from "@/components/patient-list";

export default function PatientsPage() {
  return <AppShell flush><PatientList /></AppShell>;
}
