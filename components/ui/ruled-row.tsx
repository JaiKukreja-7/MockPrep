import type { HTMLAttributes, ReactNode } from "react";

export type RuledRowListProps = HTMLAttributes<HTMLUListElement>;

/**
 * Wraps a run of rows and adds the leading 1px rule, so the list reads as
 * a set of rules rather than a stack of cards.
 */
export function RuledRowList({ className, ...props }: RuledRowListProps) {
  return (
    <ul
      className={["row-list", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

export interface RuledRowProps
  extends Omit<HTMLAttributes<HTMLLIElement>, "title"> {
  /** Left-hand label. Sentence case; not uppercased. */
  title: ReactNode;
  /** Secondary line under the title, at --u-micro. */
  meta?: ReactNode;
  /** Right-hand slot — a PillTag, a score, a compact Button. */
  trailing?: ReactNode;
  /**
   * `display` — --d-mid, the landing-page project row.
   * `ui` — --u-lg, the dashboard row. Same rule, compressed scale.
   */
  scale?: "display" | "ui";
  /**
   * 0–100. Draws the 2px interactive bar along the row's own 1px rule,
   * turning the rule into the meter's track. No new element type, no
   * second border weight — the structure was already there.
   */
  progress?: number;
}

/**
 * Rows, not cards: no radius, no fill, no shadow. A single 1px structural
 * rule underneath and the title carrying the weight.
 */
export function RuledRow({
  title,
  meta,
  trailing,
  scale = "display",
  progress,
  className,
  ...props
}: RuledRowProps) {
  const hasProgress = typeof progress === "number";
  const filled = hasProgress ? Math.max(0, Math.min(100, progress)) : 0;

  return (
    <li
      className={["row", hasProgress && "relative", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <span className="flex flex-1 flex-col gap-1">
        <span
          className={
            scale === "ui"
              ? "text-u-lg font-medium leading-tight"
              : "text-d-mid font-medium leading-tight"
          }
        >
          {title}
        </span>
        {meta ? (
          <span className="text-u-micro uppercase leading-tight">{meta}</span>
        ) : null}
      </span>

      {trailing ? <span className="shrink-0">{trailing}</span> : null}

      {hasProgress ? (
        // aria-hidden: the value is already rendered as text in `trailing`,
        // so announcing the bar too would just repeat it.
        <span
          aria-hidden
          className="link-bar absolute left-0 -bottom-px"
          style={{ width: `${filled}%` }}
        />
      ) : null}
    </li>
  );
}
