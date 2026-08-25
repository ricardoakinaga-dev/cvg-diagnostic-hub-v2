import type { StateStore } from "../domain/models";
import type { FileStore } from "../storage/file-store";
import type { MalwareScanner } from "../storage/malware-scanner";

export interface ApplicationServiceContext {
  store: StateStore;
  storage: FileStore;
  scanner: MalwareScanner;
}
