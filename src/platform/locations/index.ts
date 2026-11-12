// Physical facilities and locations shared by Inventario and Compras.
export { createDefaultLevels, ensureDefaultLocation } from "./bootstrap";
export {
  MAX_LOCATIONS,
  archiveLocation,
  setStagingLocation,
  createLocation,
  editLocation,
  listLocations,
  saveLocationLevels,
  moveLocation,
  renameLocation,
  restoreLocation,
} from "./hierarchy";
export type {
  CreateLocationInput,
  EditLocationInput,
  LevelsInput,
  LocationField,
  LocationNode,
  LocationResult,
  LocationTree,
} from "./hierarchy";
export {
  DEFAULT_LEVEL_NAMES,
  LOCATION_PARENTS,
  LOCATION_PATH_SEPARATOR,
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  MAX_LOCATION_LEVELS,
  canContain,
  compareLocationNames,
  fitProblem,
  formatLocationPath,
  isLocationType,
  levelsInside,
  locationPath,
  locationPathNames,
  normalizeLocationCode,
} from "./levels";
export type { LevelRef, LocationType, LocationWithParents } from "./levels";
export { getDefaultLocation } from "./locations";
export { STAGING_NAME, ensureStagingLocation } from "./staging";
export {
  FACILITY_OUT_OF_SCOPE_MESSAGE,
  OUT_OF_SCOPE_MESSAGE,
  assertFacilityInScope,
  assertLocationsInScope,
  assertWholeFacilityInScope,
  facilityInScope,
  isFacilityInScope,
  isLimited,
  locationScopeWhere,
  locationsOutOfScope,
} from "./scope";
export type { LocationScopeReader, LocationScopeWhere } from "./scope";
export type { LocationActor } from "./locations";
export {
  FACILITIES_LIMIT_KEY,
  NO_FACILITY_MESSAGE,
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
