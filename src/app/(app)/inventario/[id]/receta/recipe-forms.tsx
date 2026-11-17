"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusFirstError } from "@/components/focus-first-error";

import {
  activateRecipeAction,
  createRecipeAction,
  discardRecipeAction,
  removeRecipeInputAction,
  removeRecipeOutputAction,
  saveRecipeInputAction,
  saveRecipeOutputAction,
  startRecipeChangeAction,
  updateRecipeBaseAction,
  type RecipeBaseState,
  type RecipeLineState,
  type RecipeStepState,
} from "./actions";

/**
 * «Para cuánto»: creates the recipe (no version yet) or changes it in the
 * draft. In the unit of the product of the card.
 */
export function RecipeBaseForm({
  productId,
  versionId,
  baseQuantity,
  unit,
}: {
  productId: string;
  /** The draft; null to create the recipe. */
  versionId: string | null;
  baseQuantity: string;
  /** «piezas», «kilogramos». */
  unit: string;
}) {
  const [state, formAction, pending] = useActionState(
    versionId
      ? updateRecipeBaseAction.bind(null, productId, versionId)
      : createRecipeAction.bind(null, productId),
    { values: { baseQuantity }, answers: 0 } satisfies RecipeBaseState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-2">
      <FormField
        id={versionId ? "baseQuantity" : "newBaseQuantity"}
        label={`Para cuánto (${unit})`}
        error={state.error}
      >
        {(control) => (
          <div className="flex max-w-sm items-center gap-2">
            <Input
              {...control}
              name="baseQuantity"
              inputMode="decimal"
              autoComplete="off"
              maxLength={40}
              defaultValue={state.values.baseQuantity}
              key={`base-${state.answers}`}
              className="tabular-nums"
            />
            <Button
              type="submit"
              variant={versionId ? "outline" : "default"}
              disabled={pending}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {versionId ? "Guardar" : "Agregar receta"}
            </Button>
          </div>
        )}
      </FormField>
      {state.saved && !pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {state.saved}
        </p>
      )}
    </form>
  );
}

export type CaptureChoice = { value: string; label: string };

/**
 * A material or a product of «lo que sale»: new (typed or scanned, or
 * picked among several alike) or already in the draft (`line`).
 */
export function RecipeLineForm({
  kind,
  productId,
  versionId,
  line,
}: {
  kind: "input" | "output";
  productId: string;
  versionId: string;
  /** The line being changed; absent to add one. */
  line?: {
    productId: string;
    name: string;
    capture: string;
    quantity: string;
    scrapPercent: string;
    costShare: string;
    /** How the quantity may be written (materials only). */
    captures: CaptureChoice[];
  };
}) {
  const action =
    kind === "input" ? saveRecipeInputAction : saveRecipeOutputAction;
  const [state, formAction, pending] = useActionState(
    action.bind(null, productId, versionId, line?.productId ?? null),
    {
      values: {
        code: "",
        capture: line?.capture ?? "base",
        quantity: line?.quantity ?? "",
        scrapPercent: line?.scrapPercent ?? "",
        costShare: line?.costShare ?? (kind === "output" ? "0" : ""),
      },
      answers: 0,
    } satisfies RecipeLineState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  // Ids stay unique when several forms are on the page.
  const id = (name: string) => `${kind}-${line?.productId ?? "nuevo"}-${name}`;
  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-start"
    >
      {!line && (
        <FormField
          id={id("code")}
          label="Producto"
          hint="Nombre, clave o código de barras."
          error={errors.code}
        >
          {(control) => (
            <Input
              {...control}
              name="code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={state.values.code}
              key={key("code")}
            />
          )}
        </FormField>
      )}
      <FormField
        id={id("quantity")}
        label={kind === "input" ? "Cantidad para la base" : "Cuánto sale"}
        error={errors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            maxLength={40}
            defaultValue={state.values.quantity}
            key={key("quantity")}
            className="tabular-nums"
          />
        )}
      </FormField>
      {kind === "input" && line && line.captures.length > 1 && (
        <FormField id={id("capture")} label="En" error={errors.capture}>
          {(control) => (
            <NativeSelect
              {...control}
              name="capture"
              defaultValue={state.values.capture}
              key={key("capture")}
            >
              {line.captures.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      )}
      {kind === "input" ? (
        <FormField
          id={id("scrapPercent")}
          label="Merma esperada (%)"
          error={errors.scrapPercent}
        >
          {(control) => (
            <Input
              {...control}
              name="scrapPercent"
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
              defaultValue={state.values.scrapPercent}
              key={key("scrapPercent")}
              className="tabular-nums"
            />
          )}
        </FormField>
      ) : (
        <FormField
          id={id("costShare")}
          label="Parte del costo (%)"
          error={errors.costShare}
        >
          {(control) => (
            <Input
              {...control}
              name="costShare"
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
              defaultValue={state.values.costShare}
              key={key("costShare")}
              className="tabular-nums"
            />
          )}
        </FormField>
      )}
      <Button
        type="submit"
        className="min-h-11 sm:self-end lg:mt-5.5 lg:self-start"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {line ? "Guardar" : "Agregar"}
      </Button>
      {state.choices && state.choices.length > 0 && (
        <ul
          aria-label="Productos parecidos"
          className="divide-y rounded-lg border sm:col-span-2 lg:col-span-4"
        >
          {state.choices.map((choice) => (
            <li key={choice.sku}>
              <button
                type="submit"
                name="pick"
                value={choice.sku}
                disabled={pending}
                className="flex min-h-11 w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span className="font-medium [overflow-wrap:anywhere]">
                  {choice.name}
                </span>
                <span className="text-muted-foreground">{choice.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(state.saved || state.error) && !pending && (
        <p
          role={state.error ? "alert" : "status"}
          className={`text-sm sm:col-span-2 lg:col-span-4 ${state.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {state.error ?? state.saved}
        </p>
      )}
    </form>
  );
}

function useStep() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<RecipeStepState | null>(null);
  const run = (work: () => Promise<RecipeStepState>) => {
    setAnswer(null);
    startTransition(async () => {
      const result = await work();
      setAnswer(result);
      if (result.ok) {
        toast.success(result.summary);
        router.refresh();
      }
    });
  };
  return { pending, answer, run };
}

function StepError({ answer }: { answer: RecipeStepState | null }) {
  if (!answer || answer.ok) return null;
  return (
    <div role="alert" className="space-y-1 text-sm text-destructive">
      {answer.problems && answer.problems.length > 1 ? (
        <ul className="list-disc space-y-1 pl-5">
          {answer.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : (
        <p>{answer.error}</p>
      )}
    </div>
  );
}

/** «Quitar» a material or a product of «lo que sale». */
export function RemoveRecipeLine({
  kind,
  productId,
  lineId,
  name,
}: {
  kind: "input" | "output";
  productId: string;
  lineId: string;
  name: string;
}) {
  const { pending, answer, run } = useStep();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        disabled={pending}
        aria-label={`Quitar ${name} de la receta`}
        onClick={() =>
          run(() =>
            kind === "input"
              ? removeRecipeInputAction(productId, lineId)
              : removeRecipeOutputAction(productId, lineId),
          )
        }
      >
        Quitar
      </Button>
      <StepError answer={answer} />
    </span>
  );
}

/** «Activar esta versión» and «Descartar borrador», with a confirmation. */
export function RecipeDraftActions({
  productId,
  versionId,
  label,
}: {
  productId: string;
  versionId: string;
  /** «v2». */
  label: string;
}) {
  const activate = useStep();
  const discard = useStep();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          size="lg"
          className="min-h-12"
          disabled={activate.pending || discard.pending}
          onClick={() =>
            activate.run(() => activateRecipeAction(productId, versionId))
          }
        >
          {activate.pending && (
            <Loader2 aria-hidden="true" className="animate-spin" />
          )}
          Activar {label}
        </Button>
        {!confirming && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-12"
            disabled={activate.pending || discard.pending}
            onClick={() => setConfirming(true)}
          >
            Descartar borrador
          </Button>
        )}
      </div>
      <StepError answer={activate.answer} />
      {confirming && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm">
            ¿Descartar el borrador {label}? La receta vigente no cambia.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={discard.pending}
              onClick={() =>
                discard.run(() => discardRecipeAction(productId, versionId))
              }
            >
              {discard.pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Sí, descartar
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={discard.pending}
              onClick={() => setConfirming(false)}
            >
              No
            </Button>
          </div>
          <StepError answer={discard.answer} />
        </div>
      )}
    </div>
  );
}

/** «Cambiar receta»: opens the draft of the next version. */
export function StartRecipeChange({
  productId,
  recipeId,
}: {
  productId: string;
  recipeId: string;
}) {
  const { pending, answer, run } = useStep();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="min-h-11"
        disabled={pending}
        onClick={() => run(() => startRecipeChangeAction(productId, recipeId))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Cambiar receta
      </Button>
      <StepError answer={answer} />
    </div>
  );
}
