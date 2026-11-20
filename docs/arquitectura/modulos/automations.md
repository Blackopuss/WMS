# Plataforma: automatizaciones (`platform/automations`)

## Responsabilidad

Reglas de cada empresa (WMS-64, ADR 0092): **cuando** pasa algo (un hecho
que el sistema ya publica o un estado que se revisa cada hora), **en** un
almacén o en todos, **si** se cumplen condiciones de un catálogo fijo,
**entonces** de una a tres acciones (avisar, abrir una incidencia, abrir un
conteo, bloquear un lote por caducar). No importa módulos: cada módulo
declara sus disparadores y acciones y `src/modules/registry/automations.ts`
los junta en `automationCatalog`.

## Cómo se ejecuta

1. El servicio del hecho llama `emitWebhookEvent` como siempre. Al
   principio, `queueAutomationEvent` lee **una vez** el índice
   `(organizationId, status, triggerKey)` de `automation_rule`; si una regla
   encendida escucha, encola `platform.automation_event` con los datos del
   evento (recortados a 48 KB), la profundidad y la cadena de reglas.
2. El worker (`platform.automation_event`) describe el hecho con
   `trigger.describe` (una línea sin costos, ids, almacén y lugares), evalúa
   las condiciones de cada regla (`conditionsHold`) y abre una ejecución
   (`automation_run`, única por regla y `eventKey`) con su trabajo
   `platform.automation_run`, dentro de los topes por hora.
3. `platform.automation_run` reclama la ejecución (`PENDING → RUNNING`),
   revisa que la regla siga encendida y en la misma versión, que sus módulos
   estén en uso pleno, que el almacén no esté archivado y que la persona de
   la regla siga leyendo lo que el disparador describe, y corre cada acción
   en su propia transacción **dentro de `runDelegated`**: la persona de la
   regla, recortada a los permisos de esa acción y al almacén del hecho. Un
   `ForbiddenError` apaga la regla (`ACTOR`); un error inesperado se
   reintenta (3 intentos) y salta las acciones ya hechas.
4. La ronda `platform.automations` (cada hora, solo empresas con reglas
   encendidas) apaga las reglas cuyo módulo ya no está contratado y revisa
   los disparadores de estado con `trigger.scan`, como la persona de la
   regla y almacén por almacén.

Una acción que causa otro hecho lleva la cadena en la delegación:
`queueAutomationEvent` no encola nada a profundidad `AUTOMATION_MAX_DEPTH`
(2) ni para una regla que ya está en la cadena.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Catálogo (puro) | `definitions.ts` | Tipos `AutomationTrigger`, `AutomationAction`, `AutomationField`, `AutomationSubject`; `assertValidAutomationCatalog`, `parseRuleDefinition` (lo que la persona escribió contra el catálogo: lo desconocido se descarta), `conditionsHold`, `ruleSentence`, `plainLine` |
| Motor | `engine.ts` | `queueAutomationEvent` (la usa `emitWebhookEvent`), `automationJobHandlers(catálogo)`, `runAutomationRound`, `pauseRule`, `purgeAutomationRuns`, `organizationsWithAutomations`, `organizationsWithAutomationRuns`, topes |
| Reglas | `rules.ts` | `createAutomationRule`, `updateAutomationRule`, `setAutomationRuleOn`, `archiveAutomationRule`, `listAutomationRules`, `getAutomationRule`, `getAutomationFormCatalog` |
| Avisar | `notify-action.ts` | `NOTIFY_ACTION` (`platform.notify`) |
| Avisos | `notices.ts` | `automations.rule_fired` y `automations.rule_paused` |

## Permisos

- Configurar: `platform.organization.update` **y** ver toda la empresa
  (`seesWholeCompany`). Titular y Administración.
- Leer reglas e historial: `platform.automation.read` (titular,
  Administración, Gerencia) **y** ver toda la empresa.
- Una sesión de PIN no conserva ninguno (`platform.*`); soporte solo lee.

## Tablas

`automation_rule` y `automation_run` (de empresa, en `TENANT_MODELS`).
Una regla no se borra (se archiva), no cambia de disparador ni de autor y
su versión solo sube; una ejecución no cambia de regla, llave ni versión y
una terminada no cambia (disparadores). El historial se borra a los 90 días
(ronda `platform.automations_cleanup`).

## Agregar un disparador o una acción

- **Disparador de un hecho:** el hecho debe publicarse antes con
  `emitWebhookEvent` (su evento de webhook); el disparador usa la misma
  clave y su `describe` lee lo que necesita con `forOrganization`, sin
  costos ni nombres de personas.
- **Disparador de un estado:** `scan` lee con el servicio de la pantalla
  que deriva ese estado (corre delegado a la persona de la regla, recortado
  a `readPermission` y al almacén), con un `key` estable por sujeto y
  `repeat` (`once` o `day`).
- **Acción:** llama al servicio de la pantalla, nunca escribe tablas a mano;
  declara `permissions` (lo que la persona de la regla necesita), `needs`
  (lo que el sujeto debe traer) y, si aplica solo a ciertos disparadores,
  `onlyTriggers`; usa `context.idempotencyKey` para no repetirse y responde
  `done`, `already` (no es falla) o `refused` (cuenta como falla). Una
  acción que mueve o cambia existencias pasa además por un revisor
  independiente y agrega su carrera a `tests/server/lock-order.int.test.ts`.
- Todo caso nuevo va en `tests/platform/automations.int.test.ts`.
