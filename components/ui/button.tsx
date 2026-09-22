import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

type ButtonVariant = "filled" | "outline";
type ButtonSize = "default" | "compact";

interface ButtonStyleProps {
  /**
   * `filled` — accent pill, 48px. The primary action.
   * `outline` — 2px currentColor pill, 68px. Inherits its colour, so the
   * same element works on white and on the black block.
   */
  variant?: ButtonVariant;
  /**
   * `compact` — 40px, eyebrow-sized label. For actions that sit inside a
   * ruled row, where the full-height button would outgrow the row.
   */
  size?: ButtonSize;
}

/**
 * With `href` the button is a link — one element, the button's styles on
 * the anchor itself. Never nest a <Button> in a <Link>: interactive content
 * inside an anchor is invalid HTML, and the focus ring follows the anchor's
 * box rather than the pill.
 */
export type ButtonProps =
  | (ButtonStyleProps & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined })
  | (ButtonStyleProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string });

/**
 * Copy stays sentence case. Uppercase belongs to display and eyebrow only.
 */
export function Button({ variant = "filled", size = "default", className, ...props }: ButtonProps) {
  const classes = ["button", `button-${variant}`, size === "compact" && "button-compact", className]
    .filter(Boolean)
    .join(" ");

  if (props.href !== undefined) {
    const { href, ...anchor } = props;
    return <Link href={href} className={classes} {...anchor} />;
  }

  const { type = "button", ...button } = props;
  return <button type={type} className={classes} {...button} />;
}
