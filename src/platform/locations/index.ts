// Physical facilities and locations shared by Inventario and Compras.
export { ensureDefaultLocation } from "./bootstrap";
export {
  MAX_LOCATIONS,
  archiveLocation,
  setStagingLocation,
  createLocation,
  listLocations,
  moveLocation,
  renameLocation,
  restoreLocation,
} from "./hierarchy";
export type {
  LocationField,
  LocationNode,
  LocationResult,
  LocationTree,
} from "./hierarchy";
export {
  LOCATION_KINDS,
  LOCATION_KIND_LABELS,
  LOCATION_PATH_SEPARATOR,
  canContain,
  compareLocationNames,
  formatLocationPath,
  isLocationKind,
  kindsInside,
} from "./kinds";
export type { AnyLocationKind, LocationKind } from "./kinds";
export { getDefaultLocation } from "./locations";
export { STAGING_NAME, ensureStagingLocation } from "./staging";
export type { LocationActor } from "./locations";
export {
  FACILITIES_LIMIT_KEY,
  activeFacilityOf,
  archiveFacility,
  createFacility,
  getActiveFacility,
  listFacilities,
  switchFacility,
  updateFacility,
} from "./facilities";
export type {
  FacilityField,
  FacilityInput,
  FacilityResult,
  FacilitySummary,
} from "./facilities";
