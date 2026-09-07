import type { Attachment, Result, Sample, StateStore, User } from "../domain/models";
import type { FileStore } from "../storage/file-store";
import type { MalwareScanner } from "../storage/malware-scanner";

export interface PatientDiagnosticsAuxiliaryRead {
  samples: Sample[];
  results: Result[];
  attachments: Attachment[];
}

export type PatientDiagnosticsAuxiliaryReader = (input: {
  state: Awaited<ReturnType<StateStore["readState"]>>;
  actor: User;
  patientId: string;
  requestIds: ReadonlySet<string>;
  itemIds: ReadonlySet<string>;
}) => Promise<PatientDiagnosticsAuxiliaryRead> | PatientDiagnosticsAuxiliaryRead;

export interface ApplicationServiceContext {
  store: StateStore;
  storage: FileStore;
  scanner: MalwareScanner;
  patientDiagnosticsAuxiliaryReader: PatientDiagnosticsAuxiliaryReader;
}
