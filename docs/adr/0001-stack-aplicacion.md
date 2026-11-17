# ADR 0001 — Stack de la aplicación

Fecha: 2026-10-02 · Estado: aceptada · Pasos: BAS-01, BAS-02, BAS-05

## Contexto

SaaS modular de inventario para pymes mexicanas, desarrollado por el fundador con apoyo de IA a medio tiempo. Se necesita un solo proyecto que cubra interfaz y servidor, con tipado estricto y límites claros entre módulos contratables.

## Decisión

- **Next.js 16.4.6 (App Router) + React 19.2.8 + TypeScript 5.9.3 estricto** (`noUncheckedIndexedAccess`, `noImplicitOverride`). Node ≥ 24.
- **Monolito modular**: `src/platform/*` (núcleo) y `src/modules/*` (módulos contratables), con límites impuestos por `eslint-plugin-boundaries` 7.2.0 y verificados por `npm run lint:boundaries`.
- **npm** con versiones exactas (`.npmrc`: `save-exact`, `engine-strict`) y `overrides` para dependencias transitivas con vulnerabilidades corregidas.
- Calidad: ESLint 9 + Prettier 3 + Vitest 5; `npm run check` y `npm run build` deben pasar para cerrar un paso.

## Dependencias de desarrollo con avisos abiertos

2026-10-02: `braces` (todas las versiones) tiene un aviso alto de denegación de servicio con patrones glob muy anidados, sin versión corregida. Solo llega por herramientas de desarrollo (`eslint-plugin-boundaries`, `shadcn`, ESLint de Next), que no reciben patrones de terceros. `shadcn` se movió a `devDependencies`: `npm audit --omit=dev` queda en 0. Revisar cuando exista corrección.

## Actualizaciones de Next.js

2026-11-16 (WMS-80): `next` y `eslint-config-next` de 16.4.3 a 16.4.6, la última estable (no hay una versión mayor nueva; 16.5 sigue en canary). Motivos: el aviso moderado GHSA-mfr8-8qww-v76h (16.3.0 a 16.4.4; fuga de datos entre parámetros raíz al llamar una función `'use cache'` desde `unstable_cache()`; la app no usa ninguna de las dos, así que no le afectaba) y que, por ese aviso, `next build` y `next dev` se detenían una de cada dos corridas con «SecurityFatalError» cuando los corre un agente (`node_modules/next/dist/lib/upgrade/nudge.js`, política `experimental.agentUpgrade`, `security` por omisión). React, los tipos y las demás dependencias no cambian. No hizo falta tocar código: dentro de la serie 16.4 solo cambiaron textos de la documentación (Proxy no aplica directivas como `use server` ni `use cache`; la app no las usa en `src/proxy.ts`) y la lista de opciones experimentales retiradas en 16.3 y 16.4 (`viewTransition`, `appNewScrollHandler`), que la app no usa. `npm audit --omit=dev` queda en 0. Ese aviso de Next volverá a detener una corrida de cada dos con cualquier aviso de seguridad futuro: la salida es actualizar, no apagar `agentUpgrade`.

## Alternativas consideradas

- Backend separado (Express/Nest) + SPA: más despliegues y contratos que mantener para una sola persona.
- Microservicios por módulo: complejidad operativa injustificada antes de validar el producto.

## Consecuencias

- Un solo despliegue web (más un worker en IMP-01).
- Next.js cambia rápido: leer `node_modules/next/dist/docs/` antes de usar APIs nuevas (ver `AGENTS.md`).
