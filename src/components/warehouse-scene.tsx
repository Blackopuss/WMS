"use client";

import { motion } from "motion/react";

import { cn } from "cn";

import { MotionProvider } from "./motion";
import {
  CrateShape,
  FLOATING_CARD_CLASS,
  ForkliftShape,
  SceneArt,
  WarehouseSceneStill,
  type Box,
} from "./warehouse-scene-art";

/**
 * Animated warehouse illustration for the account screens. Two motions only
 * (skill guidance): boxes settle onto the racks once, and a forklift crosses
 * the floor. With reduced motion the scene renders still and complete.
 * Decorative: hidden from screen readers. The drawing lives in
 * `warehouse-scene-art.tsx`; this file only adds motion (ADR 0080).
 */

function Crate({ box, index }: { box: Box; index: number }) {
  return (
    <motion.g
      initial={{ opacity: 0, y: -24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: 0.15 + index * 0.07,
        type: "spring",
        stiffness: 380,
        damping: 22,
      }}
    >
      <CrateShape box={box} />
    </motion.g>
  );
}

/**
 * Moving forklift, or a parked one when the user asks for reduced motion.
 * Chosen with CSS (motion-reduce) so server and client render the same
 * markup (no hydration mismatch).
 */
function Forklift() {
  return (
    <>
      <motion.g
        className="motion-reduce:hidden"
        initial={{ x: -140 }}
        animate={{ x: 620 }}
        transition={{
          duration: 11,
          ease: "linear",
          repeat: Infinity,
          repeatDelay: 1.5,
          delay: 1.2,
        }}
      >
        <ForkliftShape />
      </motion.g>
      <g className="hidden motion-reduce:inline" transform="translate(150 0)">
        <ForkliftShape />
      </g>
    </>
  );
}

function FloatingCard({
  className,
  delay,
  children,
}: {
  className: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: [0, -6, 0], scale: 1 }}
      transition={{
        opacity: { delay, duration: 0.4 },
        scale: { delay, duration: 0.4 },
        y: {
          delay: delay + 0.4,
          duration: 4.5,
          repeat: Infinity,
          ease: "easeInOut",
        },
      }}
      className={cn(FLOATING_CARD_CLASS, className)}
    >
      {children}
    </motion.div>
  );
}

/**
 * `still` draws the finished scene with nothing moving (see
 * `WarehouseSceneStill`, which the public site imports directly so it does
 * not download motion).
 */
export function WarehouseScene({
  className,
  still = false,
}: {
  className?: string;
  still?: boolean;
}) {
  if (still) return <WarehouseSceneStill className={className} />;
  return (
    <MotionProvider>
      <SceneArt
        className={className}
        Crate={Crate}
        Forklift={Forklift}
        Card={FloatingCard}
      />
    </MotionProvider>
  );
}
