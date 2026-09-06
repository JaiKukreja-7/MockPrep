"use client";

import { useId, type InputHTMLAttributes } from "react";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Authored in sentence case; the eyebrow style uppercases it in CSS. */
  label: string;
  /**
   * Validation message. Sets aria-invalid and switches the border to
   * --error, the one place that colour is allowed.
   */
  error?: string;
}

/**
 * The field is interactive, so it takes the pill radius and the 2px border.
 * The label above it does the identifying — there is no grey placeholder,
 * because hierarchy here is size, not opacity.
 */
export function Input({ label, error, className, ...props }: InputProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-2">
      <label className="eyebrow" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={["input", className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-u-eyebrow text-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
