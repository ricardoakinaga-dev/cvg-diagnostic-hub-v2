import type { ApplicationServiceContext } from "./service-context";
import { createHospitalIntegrationCredentialService } from "./hospital-integration-credential-service";
import { createHospitalIntegrationIngressService } from "./hospital-integration-ingress-service";
import { createHospitalIntegrationExchangeService, type HospitalIntegrationExchangeDependencies } from "./hospital-integration-exchange-service";
export function createHospitalIntegrationService(context: ApplicationServiceContext, dependencies: HospitalIntegrationExchangeDependencies = {}) {
  return { ...createHospitalIntegrationCredentialService(context, dependencies), ...createHospitalIntegrationIngressService(context, dependencies), ...createHospitalIntegrationExchangeService(context, dependencies) };
}
