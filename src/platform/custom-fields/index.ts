// Custom fields of products, locations and suppliers (WMS-58, ADR 0056).
export {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPE_LABELS,
  MAX_CUSTOM_FIELDS,
  MAX_CUSTOM_OPTIONS,
  MAX_LABEL_LENGTH,
  MAX_TEXT_LENGTH,
  checkCustomInput,
  describeValue,
  fileValue,
  foldLabel,
  formatFieldDay,
  formValue,
  isCustomFieldEntity,
  isCustomFieldType,
  isFieldKey,
  parseCustomValue,
  parseFieldDay,
} from "./rules";
export type {
  CustomFieldDef,
  CustomFieldEntity,
  CustomFieldInput,
  CustomFieldType,
  CustomValueChange,
  StoredValue,
} from "./rules";
export {
  customFieldsFromForm,
  customFilterWhere,
  fieldViews,
  getCustomValues,
  listCustomFields,
  prepareCustomValues,
  readCustomFields,
  readCustomFieldValuesOf,
  readCustomValues,
  saveCustomValues,
  writeCustomValues,
} from "./values";
export type {
  CustomAuditChanges,
  CustomFieldView,
  CustomValuesOfRecords,
  CustomValueView,
  CustomValuesPlan,
} from "./values";
export {
  addCustomFieldOption,
  createCustomField,
  listCustomFieldSetup,
  moveCustomField,
  setCustomFieldArchived,
  updateCustomField,
  updateCustomFieldOption,
} from "./fields";
export type {
  CreateCustomFieldInput,
  CustomFieldResult,
  CustomFieldSetup,
  ReservedLabels,
} from "./fields";
