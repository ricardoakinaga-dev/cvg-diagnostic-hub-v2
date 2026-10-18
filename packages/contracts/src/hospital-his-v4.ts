/** HIS v4 webhook IDs are provider identities; this profile has no sequence field. */
export interface HospitalHisV4Delivery {
  id: string;
  deliveryId: string;
  webhookId: string;
  accountId: string;
  event: "encounter.created";
  providerPayloadId: string;
  externalEncounterId: string;
  credentialId: string;
  credentialVersion: number;
  actorUserId: string;
  payloadHash: string;
  mappingHash: string;
  intakeId: string;
  receivedAt: string;
  correlationId: string;
}
/** A safe acknowledgement contains no patient details, mapping or secret material. */
export interface HospitalHisV4Receipt {
  profile: "HIS_V4_WEBHOOK_V2";
  receiptId: string;
  deliveryId: string;
  providerPayloadId: string;
  status: "RECEIVED_FOR_TRIAGE";
}
export interface HospitalHisV4Catalog {
  profile: "HIS_V4";
  accountId: string;
  observedAt: string;
  contractReference: string;
  deploymentVerified: false;
  /** Advertisements returned by the HIS; this does not validate clinical workflows. */
  advertised: Array<{ family: string; provider?: string; endpoints: string[]; capabilities: string[] }>;
}
