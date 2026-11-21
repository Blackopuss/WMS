import { WHOLE_COMPANY_CONFIG_MESSAGE } from "@/platform/authorization";

/**
 * Said once on a configuration screen to someone limited to warehouses:
 * they see the values, only someone not limited changes them (WMS-93).
 */
export function WholeCompanyNotice() {
  return (
    <p
      role="status"
      className="max-w-3xl rounded-xl border bg-card p-4 text-sm sm:p-5"
    >
      {WHOLE_COMPANY_CONFIG_MESSAGE}
    </p>
  );
}
