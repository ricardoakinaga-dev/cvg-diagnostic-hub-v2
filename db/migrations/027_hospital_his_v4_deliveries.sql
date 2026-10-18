-- Coordinated cutover: stop app and worker and retain an isolated restore rehearsal.
-- HIS v4 receipts start empty; no external events, patients or clinical approvals are fabricated.
CREATE OR REPLACE FUNCTION cvg_runtime_entity_collections() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT ARRAY['hospitalHisV4Deliveries','hospitalIntegrationCredentials','hospitalIntegrationMessages','hospitalAiSuggestions','hospitalDocuments','hospitalTaskComments','hospitalTaskAttachments','workNotifications','workNotificationPreferences','workActivityPreferences','hospitalReports','hospitalReportJobs','hospitalInstitutionSettings','hospitalUserInvitations','savedPlannerViews','hospitalTaskTypes','hospitalTasks','hospitalTaskDependencies','hospitalIntakes','hospitalServices','hospitalResources','hospitalPlans','hospitalShifts','hospitalHandoffs','hospitalChecklistTemplates','hospitalRecurrences','examDefinitions','accessGroups','patientGrants','departments','users','sessions','patients','encounters','admissions','services','reasonCodes','requests','items','samples','procedures','schedules','results','resultVersions','notifications','idempotency','attachments']::text[]
$$;
CREATE UNIQUE INDEX cvg_hospital_his_v4_delivery_unique ON cvg_runtime_entities ((data->>'webhookId'),(data->>'deliveryId')) WHERE collection='hospitalHisV4Deliveries';
CREATE UNIQUE INDEX cvg_hospital_his_v4_event_unique ON cvg_runtime_entities ((data->>'accountId'),(data->>'providerPayloadId')) WHERE collection='hospitalHisV4Deliveries';
DO $$
DECLARE current_version bigint;
BEGIN
 SELECT version INTO current_version FROM cvg_runtime_state WHERE id=1 FOR UPDATE;
 IF current_version IS NOT NULL THEN
  UPDATE cvg_runtime_state SET state=cvg_runtime_state_header(state),version=current_version+1,updated_at=now() WHERE id=1;
  INSERT INTO audit_events(id,event_type,entity_type,entity_id,correlation_id,metadata,occurred_at)
   VALUES('audit-migration-027','HospitalHisV4ReceiptsEnabled','SchemaMigration','027_hospital_his_v4_deliveries','corr-migration-027',
    jsonb_build_object('clinicalScopeChanged',false,'providerEventsFabricated',false,'permissionsChanged',false),CURRENT_TIMESTAMP);
 END IF;
END $$;
ALTER TABLE cvg_runtime_state ADD CONSTRAINT runtime_hospital_his_v4_receipts_are_external CHECK(state->'hospitalHisV4Deliveries'='[]'::jsonb);
UPDATE relational_schema_markers SET schema_version='027_hospital_his_v4_deliveries' WHERE marker_key='RELATIONAL_CLINICAL_CORE_EXPAND_V1';
