import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "filled" | "outline";
type ButtonSize = "default" | "compact";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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
 * Copy stays sentence case. Uppercase belongs to display and eyebrow only.
 */
export function Button({
  variant = "filled",
  size = "default",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        "button",
        `button-${variant}`,
        size === "compact" && "button-compact",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
