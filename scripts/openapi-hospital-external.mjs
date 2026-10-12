import { z } from 'zod';
import * as integration from '../src/server/http/hospital-integration-schemas.ts';
import * as ai from '../src/server/http/hospital-ai-schemas.ts';
import * as hisV4 from '../src/server/http/hospital-his-v4-schemas.ts';
const fromZod = (schema, versioned = false) => { const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }); delete json.$schema; if (versioned && json.required) json.required = json.required.filter(key => key !== 'expectedVersion'); return json; };
function hisV4WebhookInput() {
 const json = fromZod(hisV4.hospitalHisV4WebhookSchema);
 const metadata = json.properties.data.properties._meta;
 const fields = metadata.properties;
 const nullableId = fields.causationId.anyOf.find(entry => entry.type === 'string');
 // JSON Schema length counts Unicode characters; exported regexes do not retain JavaScript's u flag.
 for (const field of [fields.accountId, fields.correlationId, fields.tenantId, fields.actor.properties.id, nullableId]) {
  Object.assign(field, { minLength: 1, maxLength: 255, pattern: '\\S', description: 'Technical identifier, 1 to 255 Unicode code points. It grants no Hub authority.' });
 }
 metadata.description = 'Known source-pinned EventBus metadata, schema version 1. Its account must match the business envelope. Technical IDs and actors are independent of webhook/delivery IDs and native command authorization.';
 return json;
}
const object = (properties, optional = []) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter(key => !optional.includes(key)) });
const string = { type: 'string' }; const integer = { type: 'integer', minimum: 1 }; const boolean = { type: 'boolean' }; const date = { type: 'string', format: 'date-time' };
const enumeration = (...values) => ({ type: 'string', enum: values }); const reference = name => ({ $ref: `#/components/schemas/${name}` }); const list = name => ({ type: 'array', items: reference(name) });
export const hospitalExternalRequestSchemas = {
 HospitalHisV4Webhook:hisV4WebhookInput(),
 HospitalIntegrationCredentialCreate: fromZod(integration.hospitalIntegrationCredentialCreateSchema), HospitalIntegrationCredentialRotate: fromZod(integration.hospitalIntegrationCredentialRotateSchema,true), HospitalIntegrationCredentialRevoke: fromZod(integration.hospitalIntegrationCredentialRevokeSchema,true), HospitalIntegrationMessage: fromZod(integration.hospitalIntegrationMessageSchema), HospitalIntegrationExchange: fromZod(integration.hospitalIntegrationExchangeSchema,true), HospitalIntegrationRetry: fromZod(integration.hospitalIntegrationRetrySchema,true), HospitalAiSuggest: fromZod(ai.hospitalAiSuggestSchema,true), HospitalAiReview: fromZod(ai.hospitalAiReviewSchema,true)
};
const receipt = object({ id:string,messageId:string,system:reference('HospitalIntegrationSystem'),purpose:enumeration('HIS_INTAKE','LIS_RESULT_DRAFT','PACS_RESULT_DRAFT'),externalEntityId:string,sequence:integer,direction:reference('HospitalIntegrationDirection'),status:reference('HospitalIntegrationStatus'),targetType:enumeration('HOSPITAL_INTAKE','DIAGNOSTIC_ITEM','RESULT'),targetId:string,remoteReceiptId:string,attempts:integer,retryable:boolean,nextAttemptAt:date,errorCode:string,createdAt:date,completedAt:date,version:integer }, ['targetType','targetId','remoteReceiptId','nextAttemptAt','errorCode','completedAt']);
export const hospitalExternalResponseSchemas = {
 HospitalHisV4Catalog:object({profile:enumeration('HIS_V4'),accountId:string,observedAt:date,contractReference:string,deploymentVerified:{type:'boolean',const:false},advertised:{type:'array',items:object({family:string,provider:string,endpoints:{type:'array',items:string},capabilities:{type:'array',items:string}},['provider'])}}),
 HospitalHisV4Receipt:object({profile:enumeration('HIS_V4_WEBHOOK_V2'),receiptId:string,deliveryId:string,providerPayloadId:string,status:enumeration('RECEIVED_FOR_TRIAGE')}),
 HospitalIntegrationOptions:object({departments:{type:'array',items:object({code:string,name:string})},actors:{type:'array',items:object({id:string,displayName:string,departmentCode:string})}}),
 HospitalIntegrationSystem: enumeration('HIS','LIS','PACS'), HospitalIntegrationDirection: enumeration('INBOUND','OUTBOUND'), HospitalIntegrationStatus: enumeration('CLAIMED','SUCCEEDED','FAILED'),
 HospitalIntegrationCredentialView: object({ id:string,profile:enumeration('CVG_OPERATIONAL_V1','HIS_V4'),system:reference('HospitalIntegrationSystem'),purpose:enumeration('HIS_INTAKE','LIS_RESULT_DRAFT','PACS_RESULT_DRAFT'),actorUserId:string,scope:object({ departmentCodes:{type:'array',items:string},patientIds:{type:'array',items:string}},['patientIds']),name:string,active:boolean,expiresAt:date,lastUsedAt:date,rotatedAt:date,revokedAt:date,createdBy:string,createdAt:date,version:integer },['profile','lastUsedAt','rotatedAt','revokedAt']),
 HospitalIntegrationCredentialIssued: object({credential:reference('HospitalIntegrationCredentialView'),token:string,tokenReturnedOnce:boolean},['token']), HospitalIntegrationCredentialList:list('HospitalIntegrationCredentialView'),
 HospitalIntegrationReceipt:receipt, HospitalIntegrationReceiptPage:object({items:list('HospitalIntegrationReceipt'),total:{type:'integer',minimum:0},nextCursor:string},['nextCursor']),
 HospitalIntegrationCapability:object({system:reference('HospitalIntegrationSystem'),contract:enumeration('CVG_OPERATIONAL_V1'),configured:boolean,deploymentVerified:{const:false,type:'boolean'},reason:enumeration('CONFIGURATION_MISSING','CONFIGURATION_INVALID')},['reason']),HospitalIntegrationCapabilityList:list('HospitalIntegrationCapability'),
 HospitalAiCapability:object({configured:boolean,purpose:enumeration('OPERATIONAL_DOCUMENT_TEXT'),provider:string,model:string,decisionReference:string,deploymentVerified:{const:false,type:'boolean'},requiresHumanReview:{const:true,type:'boolean'},reason:enumeration('CONFIGURATION_MISSING','CONFIGURATION_INVALID')},['provider','model','decisionReference','reason']),
 HospitalAiSuggestion:object({id:string,documentId:string,draftRevisionId:string,sourceDocumentVersion:integer,sourceDraftVersion:integer,sourceContentHash:string,requestedBy:string,createdAt:date,provider:string,model:string,remoteReceiptId:string,content:reference('HospitalDocumentContent'),status:enumeration('PENDING_REVIEW','APPLIED','REJECTED'),reviewedBy:string,reviewedAt:date,reviewReason:string,appliedDocumentVersion:integer,version:integer},['reviewedBy','reviewedAt','reviewReason','appliedDocumentVersion']),HospitalAiSuggestionList:list('HospitalAiSuggestion')
};
