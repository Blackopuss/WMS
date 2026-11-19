// Public API of the purchasing module: Purchase orders, receipts and supplier returns (CMP).
// Other modules and app/ may import only from this file.
export { purchasingModule } from "./contract";
export {
  PRODUCT_SUPPLIER_PAGE_SIZE,
  getProductSupplier,
  linkProductSupplier,
  listProductsOfSupplier,
  listSuppliersOfProduct,
  recordLastCost,
  updateProductSupplier,
} from "./product-suppliers";
export type {
  ProductSupplierField,
  ProductSupplierInput,
  ProductSupplierLink,
  ProductSupplierList,
  PurchasingActor,
  SaveProductSupplierResult,
} from "./product-suppliers";
export {
  PURCHASE_ORDER_MAX_LINES,
  PURCHASE_ORDER_PAGE_SIZE,
  addOrderLine,
  advanceOrderOnReceipt,
  cancelPurchaseOrder,
  createPurchaseOrder,
  formatOrderNumber,
  getPurchaseOrder,
  listPurchaseOrders,
  removeOrderLine,
  submitPurchaseOrder,
  updateOrderLine,
  updatePurchaseOrder,
} from "./orders";
export type {
  CreateOrderResult,
  OrderFailure,
  OrderField,
  OrderHeaderInput,
  OrderLineInput,
  OrderTransitionResult,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderPage,
  PurchaseOrderSummary,
} from "./orders";
export {
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_TRANSITIONS,
  canTransition,
  isPurchaseOrderStatus,
  transitionProblem,
} from "./order-states";
export type { PurchaseOrderStatus } from "./order-states";
export { buildOrderPdf, type OrderPdf } from "./order-pdf";
export { closePurchaseOrder, type CloseOrderResult } from "./order-close";
export { purchasingOpenWork } from "./deactivation";
export {
  PURCHASE_REPORT_KINDS,
  REPORT_MAX_ROWS,
  buildPurchaseReport,
  getPendingReport,
  getPurchasesBySupplier,
  isPurchaseReportKind,
  type PendingReport,
  type PendingRow,
  type PurchaseReportFile,
  type PurchaseReportKind,
  type SupplierReport,
  type SupplierRow,
} from "./reports";
export {
  generateSuggestedOrders,
  getPurchaseSuggestions,
  type GenerateSuggestedResult,
  type PurchaseSuggestions,
  type Suggestion,
  type SuggestionGroup,
} from "./suggestions";
export {
  findReturnConfirmation,
  returnToSupplier,
  type ReturnInput,
  type ReturnResult,
} from "./returns";
export {
  findReceiptConfirmation,
  getOrderReceipts,
  receivePurchaseOrder,
} from "./receipts";
export type {
  OrderReceipts,
  PendingLine,
  ReceiptSummary,
  ReceiveField,
  ReceiveInput,
  ReceiveLineField,
  ReceiveResult,
} from "./receipts";
export {
  ORDER_DELIVERY_JOB_TYPE,
  ORDER_DELIVERY_MAX_ATTEMPTS,
  ORDER_DELIVERY_STATUS_LABELS,
  getOrderDeliveries,
  purchasingJobHandlers,
  requestOrderDelivery,
} from "./order-delivery";
export type {
  OrderDelivery,
  OrderDeliveryPanel,
  RequestDeliveryResult,
} from "./order-delivery";
export {
  PURCHASE_REQUEST_MAX_LINES,
  PURCHASE_REQUEST_PAGE_SIZE,
  addRequestLine,
  cancelPurchaseRequest,
  convertPurchaseRequest,
  countRequestsToAttend,
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  rejectPurchaseRequest,
  removeRequestLine,
  submitPurchaseRequest,
  updatePurchaseRequest,
  updateRequestLine,
} from "./requests";
export type {
  ConvertRequestResult,
  CreateRequestResult,
  PurchaseRequestDetail,
  PurchaseRequestLineView,
  PurchaseRequestPage,
  PurchaseRequestSummary,
  PurchaseRequestView,
  RequestFailure,
  RequestField,
  RequestHeaderInput,
  RequestLineInput,
  RequestTransitionResult,
  SubmitRequestResult,
} from "./requests";
export {
  PURCHASE_REQUEST_STATUSES,
  PURCHASE_REQUEST_STATUS_LABELS,
  PURCHASE_REQUEST_TRANSITIONS,
  canRequestTransition,
  formatRequestNumber,
  isPurchaseRequestStatus,
  requestTransitionProblem,
} from "./request-states";
export type { PurchaseRequestStatus } from "./request-states";
export {
  COMPARE_MAX_ORDERS,
  COMPARE_ORDERS_PER_SUPPLIER,
  compareSuppliers,
} from "./supplier-comparison";
export type {
  ComparisonLine,
  SupplierComparison,
  SupplierOption,
} from "./supplier-comparison";
export { PURCHASING_APPROVAL_TYPES } from "./approvals";
export { COMPARE_MIN_FULFILLMENT, PURCHASING_SETTINGS } from "./settings";
export { PURCHASING_NOTIFICATION_TYPES } from "./notices";
export { PURCHASING_WEBHOOK_EVENTS } from "./webhooks";

// WMS-66: what Compras offers to the global search (ADR 0081).
export { PURCHASING_SEARCH_SOURCES } from "./search";
