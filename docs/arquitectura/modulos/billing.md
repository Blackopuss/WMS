# Plataforma: plan, módulos y pagos (`platform/billing`)

## Responsabilidad

Qué módulos existen y cuáles tiene cada empresa: el contrato de módulo
(`defineModule`), el registro que valida el conjunto, el guard de servidor
(rol + módulo + solo lectura + límite), activar y quitar módulos, el plan de
una empresa (lo asigna el personal de plataforma), los pagos manuales por
transferencia y la lista de precios de referencia del sitio. No hay cobro en
línea (ADR 0037).

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Contrato | `contract.ts` | `defineModule`, `validateModuleContract`, `PLATFORM_FEATURES` (`catalog`, `contacts`) |
| Registro | `registry.ts` | `createModuleRegistry`: ids únicos, una sola base, dependencias registradas y sin ciclos, cada permiso con un dueño; si falla, la aplicación no arranca |
| Guard | `guard.ts` | `getModuleAccess()` (pantallas: `can`, `hasModule`, `moduleState`), `assertModulePermission` (servicios), `requireModulePermission`, `assertWithinLimit`, `isReadOrExport` |
| Activar módulos | `modules.ts` | `activateModule`, `deactivateModule` (bloquean la empresa y respetan dependencias) |
| Plan de una empresa | `provisioning.ts` | `provisionCompany` (límites, módulos, vigencia; avisa el trabajo a medias de lo que se quita), `getCompanyPlan`, `isPlatformStaff`, `requirePlatformStaff` |
| Vista del plan | `overview.ts`, `validity.ts` | `getPlanOverview`, aviso de vencimiento (`renewalDaysLeft`, `renewalText`) |
| Pagos | `payments.ts` | `recordManualPayment`, `reverseManualPayment`, `listManualPayments` |
| Sitio | `prices.ts`, `contact.ts` | `PLAN_TIERS` (referencia, nada se cobra desde aquí), `CONTACT_EMAIL` |

## Permisos

`platform.module.read|activate|deactivate`, `platform.plan.read|change`,
`platform.capacity.read`, `platform.subscription.create|cancel`,
`platform.billing.read|manage`; `platform.provisioning.manage` no lo concede
ningún rol de empresa (solo personal de plataforma). Los de contratar,
cancelar y cambiar plan son solo del titular (`OWNER_ONLY_PERMISSIONS`).

## Tablas

`plan_version`, `plan_offer`, `plan_module_price` (precios versionados, no se
modifican), `subscription`, `subscription_item`, `manual_payment`
(inmutable), `platform_staff`. Historial que nada escribe: `checkout_order`,
`promo_code`, `payment_event`. Lo que una empresa puede usar hoy está en
`entitlement` ([entitlements](entitlements.md)).

## Ajustes y trabajos

Ninguno. Recibe del registro de módulos `moduleOpenWork` para avisar al quitar
un módulo.

## ADR

0007 (contrato y registro), 0008 (modelo comercial), 0009 (consola interna),
0027 (pagos manuales), 0028 (compra en línea, historial), 0037 (sin cobro en
línea).
