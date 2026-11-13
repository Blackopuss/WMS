"use client";

import { CircleCheck, Loader2, PackageOpen, ScanLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PackageView, PackingView } from "@/modules/inventory";

import { CopyCode } from "../../../inventario/tarimas/[id]/copy-code";
import {
  finishPackingAction,
  packScanAction,
  reopenPackageAction,
  reportPackShortageAction,
  sealPackageAction,
  unpackPackageAction,
  type PackStepState,
} from "../../actions";

/** A step that is not a scan: one at a time, then the screen repaints. */
function useStep() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<PackStepState | null>(null);
  const run = (work: () => Promise<PackStepState>, done?: () => void) => {
    setAnswer(null);
    startTransition(async () => {
      const result = await work();
      setAnswer(result);
      if (result.ok) {
        toast.success(result.summary);
        done?.();
        router.refresh();
      }
    });
  };
  return { pending, answer, run };
}

/**
 * Packing an order (WMS-15): the scanner box on top, what each line has
 * packed, the open package and the closed ones. Scans wait in line (INV-29):
 * the box never blocks nor drops a reading while the server answers.
 */
export function PackStation({
  view,
  kinds,
}: {
  view: PackingView;
  kinds: readonly string[];
}) {
  const router = useRouter();
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const queue = useRef<{ code: string; quantity: string }[]>([]);
  const draining = useRef(false);

  function enqueue(text: string) {
    const typed = text.trim().slice(0, 100);
    codeRef.current?.focus();
    if (typed === "") return;
    queue.current.push({ code: typed, quantity: quantity.trim() });
    setCode("");
    setQuantity("");
    if (!draining.current) void drain();
  }

  async function drain() {
    draining.current = true;
    setBusy(true);
    try {
      for (
        let next = queue.current.shift();
        next !== undefined;
        next = queue.current.shift()
      ) {
        try {
          const result = await packScanAction(
            view.id,
            next.code,
            next.quantity,
          );
          setNotice(
            result.ok
              ? { text: result.summary, error: false }
              : { text: `«${next.code}»: ${result.error}`, error: true },
          );
        } catch {
          setNotice({
            text: `No pudimos registrar «${next.code}». Revisa tu conexión y vuelve a escanearlo.`,
            error: true,
          });
        }
      }
    } finally {
      draining.current = false;
      setBusy(false);
      router.refresh();
    }
  }

  const open = view.packages.find((each) => each.open) ?? null;
  const closed = view.packages.filter((each) => !each.open);
  const pendingLines = view.lines.filter((line) => !line.done).length;

  return (
    <div className="max-w-3xl space-y-6">
      <section
        aria-labelledby="escanear"
        className="space-y-3 rounded-xl border bg-card p-4 sm:px-5"
      >
        <h2 id="escanear" className="flex items-center gap-2 font-medium">
          <ScanLine aria-hidden="true" className="size-5 text-primary" />
          Escanea lo que tienes enfrente
        </h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="pack-code">Producto, serie o lote</Label>
            <Input
              ref={codeRef}
              id="pack-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  // What the box holds now, not what the last render saw.
                  enqueue(event.currentTarget.value);
                }
              }}
              maxLength={100}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="send"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pack-quantity">Cuántas</Label>
            <Input
              id="pack-quantity"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="1"
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
            />
          </div>
          <Button
            type="button"
            className="min-h-11"
            onClick={() => enqueue(code)}
          >
            {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
            Agregar
          </Button>
        </div>
        <p
          role="status"
          className={`min-h-5 text-sm [overflow-wrap:anywhere] ${notice?.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {notice?.text ??
            (open
              ? `Lo que escanees entra en ${open.name}.`
              : "El primer escaneo abre una caja.")}
        </p>
      </section>

      <section aria-labelledby="avance" className="rounded-xl border bg-card">
        <h2
          id="avance"
          className="flex flex-wrap items-baseline justify-between gap-x-4 border-b p-4 font-medium sm:px-5"
        >
          Productos
          <span className="text-sm font-normal text-muted-foreground">
            {pendingLines === 0
              ? "Todo está empacado"
              : pendingLines === 1
                ? "Falta 1 producto"
                : `Faltan ${pendingLines} productos`}
          </span>
        </h2>
        <ul className="divide-y">
          {view.lines.map((line) => (
            <li
              key={line.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4 sm:px-5"
            >
              <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
                <span className="block font-medium">{line.productName}</span>
                <span className="block text-sm text-muted-foreground">
                  {line.sku}
                  {line.leftLots.length > 0 &&
                    ` · lotes por empacar: ${line.leftLots.join(", ")}`}
                </span>
                {line.leftSerials.length > 0 && (
                  <span className="block font-mono text-sm text-muted-foreground">
                    Series por empacar: {line.leftSerials.join(", ")}
                  </span>
                )}
                {line.missingText && (
                  <span className="block text-sm text-warning">
                    Faltó {line.missingText}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-right tabular-nums">
                  <span className="block text-lg font-semibold">
                    {line.progressText}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    empacado de surtido
                  </span>
                </span>
                {line.done ? (
                  <CircleCheck
                    aria-label="Completo"
                    className="size-6 text-success"
                  />
                ) : (
                  <ShortageDialog
                    orderId={view.id}
                    lineId={line.id}
                    productName={line.productName}
                    leftText={line.leftText ?? ""}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {open && <OpenPackage orderId={view.id} box={open} kinds={kinds} />}

      {closed.length > 0 && (
        <section
          aria-labelledby="cerrados"
          className="rounded-xl border bg-card"
        >
          <h2 id="cerrados" className="border-b p-4 font-medium sm:px-5">
            Bultos cerrados
          </h2>
          <ul className="divide-y">
            {closed.map((box) => (
              <li
                key={box.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4 sm:px-5"
              >
                <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
                  <span className="block font-medium">
                    {box.name}
                    {box.weightText ? ` · ${box.weightText}` : ""}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {box.items
                      .map(
                        (item) => `${item.quantityText} de ${item.productName}`,
                      )
                      .join(" · ")}
                  </span>
                </span>
                {!open && <ReopenButton orderId={view.id} box={box} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.shortages.length > 0 && (
        <section
          aria-labelledby="faltantes"
          className="rounded-xl border bg-card"
        >
          <h2 id="faltantes" className="border-b p-4 font-medium sm:px-5">
            Lo que faltó
          </h2>
          <ul className="divide-y text-sm">
            {view.shortages.map((row) => (
              <li key={row.id} className="p-4 [overflow-wrap:anywhere] sm:px-5">
                <span className="font-medium">
                  {row.quantityText} de {row.productName}
                </span>
                {row.lotText ? ` · ${row.lotText}` : ""}
                {row.serials ? ` · series ${row.serials}` : ""}
                <span className="block text-muted-foreground">
                  {row.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A new state of the order starts without the last refusal. */}
      <FinishPacking
        key={`${view.complete}-${view.shortages.length}`}
        orderId={view.id}
        complete={view.complete}
      />
    </div>
  );
}

function OpenPackage({
  orderId,
  box,
  kinds,
}: {
  orderId: string;
  box: PackageView;
  kinds: readonly string[];
}) {
  return (
    <section
      aria-labelledby="bulto-abierto"
      className="space-y-3 rounded-xl border border-primary/40 bg-card p-4 sm:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="bulto-abierto" className="flex items-center gap-2 font-medium">
          <PackageOpen aria-hidden="true" className="size-5 text-primary" />
          {box.kind} abierta
        </h2>
        <Badge variant="secondary">En {box.locationName}</Badge>
      </div>
      <CopyCode code={box.code} />
      {box.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Está vacía: escanea lo que va dentro.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {box.items.flatMap((item) =>
            item.bySerial
              ? item.serials.map((serial) => (
                  <li
                    key={`${item.id}:${serial}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {item.productName} ·{" "}
                      <span className="font-mono">{serial}</span>
                    </span>
                    <UnpackButton
                      orderId={orderId}
                      packageId={box.id}
                      itemId={item.id}
                      label={`${item.productName} serie ${serial}`}
                      serial={serial}
                    />
                  </li>
                ))
              : [
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="font-medium">{item.quantityText}</span>{" "}
                      de {item.productName}
                      {item.lotText ? ` · ${item.lotText}` : ""}
                    </span>
                    <UnpackButton
                      orderId={orderId}
                      packageId={box.id}
                      itemId={item.id}
                      label={item.productName}
                      quantity={item.quantity}
                    />
                  </li>,
                ],
          )}
        </ul>
      )}
      <SealDialog orderId={orderId} box={box} kinds={kinds} />
    </section>
  );
}

/** Takes one unit by serial out, or asks how much of the rest. */
function UnpackButton({
  orderId,
  packageId,
  itemId,
  label,
  serial,
  quantity,
}: {
  orderId: string;
  packageId: string;
  itemId: string;
  label: string;
  serial?: string;
  quantity?: string;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(quantity ?? "1");
  const { pending, answer, run } = useStep();
  const id = useId();
  const error = answer && !answer.ok ? answer.error : null;
  if (serial) {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={pending}
          aria-label={`Sacar ${label}`}
          onClick={() =>
            run(() =>
              unpackPackageAction(orderId, {
                packageId,
                itemId,
                quantity: "1",
                serials: serial,
              }),
            )
          }
        >
          Sacar
        </Button>
        {error && (
          <span role="alert" className="text-sm text-destructive">
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          aria-label={`Sacar ${label}`}
        >
          Sacar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sacar de la caja</DialogTitle>
          <DialogDescription>
            Queda suelto en preparación, todavía para este pedido. Vuelve a
            escanearlo para empacarlo.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                unpackPackageAction(orderId, {
                  packageId,
                  itemId,
                  quantity: amount,
                }),
              () => setOpen(false),
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${id}-amount`}>Cuánto sacas de {label}</Label>
            <Input
              id={`${id}-amount`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            {error && (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Volver
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Sacar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SealDialog({
  orderId,
  box,
  kinds,
}: {
  orderId: string;
  box: PackageView;
  kinds: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(box.kind);
  const [weight, setWeight] = useState("");
  const { pending, answer, run } = useStep();
  const failed = answer && !answer.ok ? answer : null;
  const kindError = failed?.fieldErrors?.kind;
  const weightError = failed?.fieldErrors?.weight;
  const formError = failed && !kindError && !weightError ? failed.error : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
        >
          Cerrar bulto
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cerrar {box.name}</DialogTitle>
          <DialogDescription>
            {box.items.length === 0
              ? "Está vacía: al cerrarla se quita."
              : "Queda lista para salir. Lo siguiente que escanees abre otra."}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                sealPackageAction(orderId, {
                  packageId: box.id,
                  kind,
                  weight,
                }),
              () => setOpen(false),
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="seal-kind">Qué es</Label>
            <Input
              id="seal-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              list="seal-kinds"
              maxLength={40}
              autoComplete="off"
              aria-invalid={kindError ? true : undefined}
              aria-describedby={kindError ? "seal-kind-error" : undefined}
            />
            <datalist id="seal-kinds">
              {kinds.map((each) => (
                <option key={each} value={each} />
              ))}
            </datalist>
            {kindError && (
              <p
                id="seal-kind-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {kindError}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="seal-weight">Peso en kg (opcional)</Label>
            <Input
              id="seal-weight"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
              aria-invalid={weightError ? true : undefined}
              aria-describedby={weightError ? "seal-weight-error" : undefined}
            />
            {weightError && (
              <p
                id="seal-weight-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {weightError}
              </p>
            )}
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Volver
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Cerrar bulto
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReopenButton({ orderId, box }: { orderId: string; box: PackageView }) {
  const { pending, answer, run } = useStep();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        disabled={pending}
        aria-label={`Abrir de nuevo ${box.name}`}
        onClick={() => run(() => reopenPackageAction(orderId, box.id))}
      >
        Abrir de nuevo
      </Button>
      {answer && !answer.ok && (
        <span role="alert" className="text-sm text-destructive">
          {answer.error}
        </span>
      )}
    </span>
  );
}

function ShortageDialog({
  orderId,
  lineId,
  productName,
  leftText,
}: {
  orderId: string;
  lineId: string;
  productName: string;
  leftText: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, answer, run } = useStep();
  const id = useId();
  const error = answer && !answer.ok ? answer.error : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          aria-label={`Marcar faltante de ${productName}`}
        >
          Falta
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿No está lo que falta de {productName}?</DialogTitle>
          <DialogDescription>
            Se registra el faltante ({leftText}) y el pedido sale con lo que
            hay. Ya no queda apartado: si aparece, se corrige con un ajuste o un
            conteo.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => reportPackShortageAction(orderId, lineId, reason),
              () => setOpen(false),
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${id}-reason`}>Qué pasó</Label>
            <Input
              id={`${id}-reason`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            {error && (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Volver
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Registrar faltante
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FinishPacking({
  orderId,
  complete,
}: {
  orderId: string;
  complete: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        variant={complete ? "default" : "outline"}
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await finishPackingAction(orderId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            toast.success(result.summary);
            router.push(`/pedidos/${orderId}`);
          });
        }}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Terminar empaque
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!complete && !error && (
        <p className="text-sm text-muted-foreground">
          Al terminar, todo lo surtido debe estar en bultos o marcado como
          faltante.
        </p>
      )}
    </div>
  );
}
