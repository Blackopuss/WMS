"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

import { setRecipeAreaAction } from "../../../produccion/actions";

/**
 * Where the orders of this recipe are proposed to be made (WMS-28): a
 * production area, or none. The areas are armed on the server.
 */
export function RecipeAreaForm({
  productId,
  areas,
  current,
}: {
  productId: string;
  areas: { id: string; path: string }[];
  current: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await setRecipeAreaAction(productId, value);
          if (!result.ok) {
            setError(result.message);
            return;
          }
          toast.success(result.message);
          router.refresh();
        });
      }}
    >
      <div className="min-w-56 flex-1 space-y-2">
        <Label htmlFor="recipe-area">Área de producción de sus órdenes</Label>
        <NativeSelect
          id="recipe-area"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "recipe-area-error" : undefined}
        >
          <option key="none" value="">
            Ninguna
          </option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.path}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button
        type="submit"
        variant="outline"
        className="min-h-11"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Guardar área
      </Button>
      {error && (
        <p
          id="recipe-area-error"
          role="alert"
          className="w-full text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </form>
  );
}
