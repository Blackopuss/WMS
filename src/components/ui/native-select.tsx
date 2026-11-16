import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "cn";

/**
 * Native <select> styled like Input: the phone's own picker on mobile,
 * full keyboard support and no extra JavaScript. The open list takes the
 * popover colors: in dark mode it inherited the select's translucent
 * background and showed white text on gray.
 */
function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  // A width limit (`max-w-*`, also with a breakpoint) belongs to the wrapper:
  // on the select alone the chevron stayed at the far edge of the row.
  const classes = (className ?? "").split(/\s+/).filter(Boolean);
  const isWidth = (name: string) => /(^|:)max-w-/.test(name);
  return (
    <div className={cn("relative", classes.filter(isWidth).join(" "))}>
      <select
        data-slot="native-select"
        className={cn(
          "h-11 w-full min-w-0 appearance-none rounded-lg border border-input bg-card py-1 pr-10 pl-3 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:h-10 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_optgroup]:bg-popover [&_optgroup]:text-popover-foreground [&_option]:bg-popover [&_option]:text-popover-foreground",
          classes.filter((name) => !isWidth(name)).join(" "),
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export { NativeSelect };
