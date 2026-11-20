/**
 * The lot a production report made, as a document with a process (WMS-29,
 * ADR 0087). Declared in Inventory (WMS-31, ADR 0093): «Se guardó» happens
 * when Inventory delivers a put-away task.
 */
export {
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_BATCH_STORED_OPERATION,
  PRODUCTION_BATCH_VERIFICATION_OPERATION,
} from "@/modules/inventory";
