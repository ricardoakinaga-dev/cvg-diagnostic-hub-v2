import type { CommandMeta } from "./service-types";
export type HospitalTaskAttachmentUploadInput = CommandMeta & { filename: string; mimeType: string; sizeBytes: number; checksum: string };
export interface HospitalTaskAttachmentFilters { limit?: number; cursor?: string }
