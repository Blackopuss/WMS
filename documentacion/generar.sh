#!/usr/bin/env bash
# Genera los PDF de la carpeta documentacion a partir de documentacion/fuentes/*.md
# Requiere pandoc, python3 y node con playwright. Uso: bash documentacion/generar.sh
set -euo pipefail
cd "$(dirname "$0")"
node generar.mjs
