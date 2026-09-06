import type { HTMLAttributes } from "react";

export type PillTagProps = HTMLAttributes<HTMLSpanElement>;

/**
 * The categorical pill. Its border is currentColor and its background is
 * transparent, so it needs no light/dark variant — drop it inside
 * .surface-dark and it flips itself.
 *
 * Copy is authored in sentence case and uppercased in CSS.
 */
export function PillTag({ className, ...props }: PillTagProps) {
  return (
    <span
      className={["pill", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
