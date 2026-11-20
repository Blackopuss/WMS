// Public API of platform/tenancy: Organizations, memberships and active-organization context (PLT).
export {
  CREATE_ORGANIZATION_PATH,
  MEXICO_TIME_ZONES,
  createOrganization,
  hasOrganization,
} from "./organizations";
export type {
  CreateOrganizationResult,
  OrganizationField,
  OrganizationInput,
} from "./organizations";
export {
  SIGN_IN_AGAIN_MESSAGE,
  TERMINAL_SWITCH_MESSAGE,
  listMyOrganizations,
  requireOrganizationContext,
  resolveActiveOrganization,
  switchOrganization,
} from "./context";
export type {
  ActiveOrganization,
  MyOrganization,
  OrganizationContext,
  SwitchOrganizationResult,
} from "./context";
export { openSupportAccess, supportWindowFor } from "./support";
export type { SupportWindow } from "./support";
export { DEMO_REFUSED_MESSAGE, isDemoCompany } from "./demo";
