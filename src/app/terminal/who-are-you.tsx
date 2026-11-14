"use client";

import { ArrowLeft, Delete } from "lucide-react";
import Link from "next/link";
import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { pinSignInAction, type PinSignInState } from "./actions";

type Person = { userId: string; name: string };

/** Digits a PIN may have (the company decides 4, 5 or 6). */
const PIN_MAX = 6;
const PIN_MIN = 4;
/** With more people than this, the search box appears. */
const SEARCH_FROM = 8;

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * «¿Quién eres?» and the keypad (WMS-38). Big targets, works with touch
 * only; a physical keyboard or a USB keypad also types digits.
 */
export function WhoAreYou({ people }: { people: Person[] }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const words = query
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return people;
    return people.filter((each) => {
      const name = each.name
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
      return words.every((word) => name.includes(word));
    });
  }, [people, query]);

  if (person) {
    return (
      <Keypad
        key={person.userId}
        person={person}
        onBack={() => setPerson(null)}
      />
    );
  }

  return (
    <section aria-labelledby="quien" className="space-y-5">
      <h1 id="quien" className="text-3xl font-semibold tracking-tight">
        ¿Quién eres?
      </h1>
      {people.length === 0 ? (
        <div className="space-y-2 rounded-xl border bg-card p-6">
          <p className="font-medium">
            Nadie de este almacén puede entrar con PIN todavía.
          </p>
          <p className="text-muted-foreground">
            Quien administra la empresa decide quién puede usar las terminales.
          </p>
        </div>
      ) : (
        <>
          {people.length > SEARCH_FROM && (
            <div className="space-y-1.5">
              <label htmlFor="buscar-persona" className="text-sm font-medium">
                Busca tu nombre
              </label>
              <Input
                id="buscar-persona"
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-12 text-base"
              />
            </div>
          )}
          {visible.length === 0 ? (
            <p className="text-muted-foreground" role="status">
              Nadie con ese nombre.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((each) => (
                <li key={each.userId}>
                  <button
                    type="button"
                    onClick={() => setPerson(each)}
                    className="flex min-h-16 w-full items-center rounded-xl border bg-card px-5 py-3 text-left text-lg font-medium transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {each.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="text-sm text-muted-foreground">
        ¿No tienes PIN?{" "}
        <Link
          href="/ingresar"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Entra con tu correo
        </Link>{" "}
        y ponlo en Configuración › Mi PIN.
      </p>
    </section>
  );
}

function Keypad({ person, onBack }: { person: Person; onBack: () => void }) {
  const [state, formAction, pending] = useActionState<PinSignInState, FormData>(
    pinSignInAction,
    { answers: 0 },
  );
  const [pin, setPin] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // A new answer: the keypad starts empty and the message is read out.
  const [seen, setSeen] = useState(state.answers);
  if (seen !== state.answers) {
    setSeen(state.answers);
    setPin("");
  }
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  const press = useCallback(
    (digit: string) =>
      setPin((current) =>
        current.length < PIN_MAX ? current + digit : current,
      ),
    [],
  );
  const erase = useCallback(
    () => setPin((current) => current.slice(0, -1)),
    [],
  );
  const submit = useCallback(() => {
    if (pin.length >= PIN_MIN && !pending) formRef.current?.requestSubmit();
  }, [pin, pending]);

  // A physical keyboard or keypad types too.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        erase();
      } else if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, erase, submit]);

  if (state.notTerminal) {
    return (
      <div className="mx-auto max-w-md space-y-4 rounded-xl border bg-card p-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Este dispositivo ya no es una terminal compartida
        </h1>
        <Button asChild size="lg" className="w-full">
          <Link href="/ingresar">Ingresar</Link>
        </Button>
      </div>
    );
  }

  const keyClass = "min-h-16 text-2xl font-semibold sm:min-h-20" as const;

  return (
    <section
      aria-labelledby="pin-titulo"
      className="mx-auto max-w-sm space-y-5"
    >
      <Button
        type="button"
        variant="ghost"
        size="lg"
        onClick={onBack}
        className="-ml-3"
      >
        <ArrowLeft aria-hidden="true" />
        No soy yo
      </Button>
      <div className="space-y-1">
        <h1 id="pin-titulo" className="text-3xl font-semibold tracking-tight">
          {person.name}
        </h1>
        <p className="text-muted-foreground">Escribe tu PIN.</p>
      </div>
      <form ref={formRef} action={formAction} className="space-y-5">
        <input type="hidden" name="userId" value={person.userId} />
        <input type="hidden" name="pin" value={pin} />
        <div
          className="flex h-14 items-center justify-center gap-3 rounded-xl border bg-card"
          role="status"
          aria-live="polite"
          aria-label={`${pin.length} de ${PIN_MAX} números escritos`}
        >
          {Array.from({ length: PIN_MAX }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={`size-3.5 rounded-full border-2 border-foreground/60 ${
                index < pin.length ? "bg-foreground" : ""
              }`}
            />
          ))}
        </div>
        {state.error && (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-center font-medium text-destructive outline-none"
          >
            {state.error}
          </p>
        )}
        <div className="grid grid-cols-3 gap-3">
          {KEYS.map((digit) => (
            <Button
              key={digit}
              type="button"
              variant="outline"
              className={keyClass}
              onClick={() => press(digit)}
              disabled={pending}
            >
              {digit}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-16 text-base sm:min-h-20"
            onClick={erase}
            disabled={pending || pin.length === 0}
          >
            <Delete aria-hidden="true" />
            Borrar
          </Button>
          <Button
            type="button"
            variant="outline"
            className={keyClass}
            onClick={() => press("0")}
            disabled={pending}
          >
            0
          </Button>
          <Button
            type="submit"
            className="min-h-16 text-base sm:min-h-20"
            disabled={pending || pin.length < PIN_MIN}
          >
            {pending ? "Entrando…" : "Entrar"}
          </Button>
        </div>
      </form>
    </section>
  );
}
