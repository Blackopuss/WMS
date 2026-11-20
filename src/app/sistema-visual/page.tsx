import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Toasts } from "@/components/providers";

import { Showcase } from "./showcase";

export const metadata: Metadata = { title: "Sistema visual" };

/** Development-only preview of the design system (BAS-12). */
export default function SistemaVisualPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <Showcase />
      <Toasts />
    </>
  );
}
