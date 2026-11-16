/**
 * Reference price list shown on the public site (/precios): monthly, in
 * MXN, VAT included. A proposal until the founder sets the WMS prices.
 * Producción and Calidad cost the same in every tier (founder, 2026-11-16,
 * a placeholder for now); Calidad is never contracted without Producción.
 * Nothing is charged from here: plans are paid by transfer and recorded by
 * platform staff (`recordManualPayment`). Pure: no database.
 */

export const PLAN_TIERS = [
  {
    id: "t100",
    productLimit: 100,
    users: 2,
    prices: {
      inventory: "349.00",
      purchasing: "179.00",
      production: "3000.00",
      quality: "3000.00",
    },
  },
  {
    id: "t500",
    productLimit: 500,
    users: 3,
    prices: {
      inventory: "649.00",
      purchasing: "299.00",
      production: "3000.00",
      quality: "3000.00",
    },
  },
  {
    id: "t1000",
    productLimit: 1000,
    users: 5,
    prices: {
      inventory: "949.00",
      purchasing: "449.00",
      production: "3000.00",
      quality: "3000.00",
    },
  },
  {
    id: "t3000",
    productLimit: 3000,
    users: 8,
    prices: {
      inventory: "1690.00",
      purchasing: "790.00",
      production: "3000.00",
      quality: "3000.00",
    },
  },
  {
    id: "t10000",
    productLimit: 10000,
    users: 15,
    prices: {
      inventory: "3490.00",
      purchasing: "1490.00",
      production: "3000.00",
      quality: "3000.00",
    },
  },
] as const;
