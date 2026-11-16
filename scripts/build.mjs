// Compila la aplicación (`npm run build`) dándole memoria a la revisión de
// tipos. `next build` revisa los tipos en un proceso aparte, que no hereda los
// argumentos de node pero sí `NODE_OPTIONS`; con el límite por omisión (unos
// 2 GB en equipos o contenedores con poca memoria) se queda sin espacio. No se
// usa `cross-env` para no agregar una dependencia: este lanzador sirve igual en
// Linux, macOS y Windows.
//
// Si quien llama ya trae su propio `--max-old-space-size`, se respeta.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HEAP_MB = 6144;

const require = createRequire(import.meta.url);
const next = require.resolve("next/dist/bin/next");

const current = process.env.NODE_OPTIONS ?? "";
const options = current.includes("--max-old-space-size")
  ? current
  : `${current} --max-old-space-size=${HEAP_MB}`.trim();

const result = spawnSync(
  process.execPath,
  [next, "build", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: options },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
