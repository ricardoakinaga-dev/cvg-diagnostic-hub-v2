import { createFileStoreFromEnv, type FileStore } from "../storage/file-store";
import { createMalwareScannerFromEnv } from "../storage/malware-scanner";
import type { StateStore } from "../domain/models";
import { createAttachmentService } from "./attachment-service";
import { createManagementService } from "./management-service";
import { createReadService } from "./read-service";
import { createRegistryService } from "./registry-service";
import { createRequestService } from "./request-service";
import { createResultService } from "./result-service";
import { createWorkflowService } from "./workflow-service";
import type { ApplicationServiceContext } from "./service-context";

export type * from "./service-types";

export function createApplicationService(store: StateStore, dependencies: { storage?: FileStore } = {}) {
  const context: ApplicationServiceContext = {
    store,
    storage: dependencies.storage ?? createFileStoreFromEnv(),
    scanner: createMalwareScannerFromEnv()
  };
  return {
    ...createRequestService(context),
    ...createWorkflowService(context),
    ...createResultService(context),
    ...createAttachmentService(context),
    ...createManagementService(context),
    ...createRegistryService(context),
    ...createReadService(context)
  };
}
