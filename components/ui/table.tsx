import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

const cx = (...parts: (string | false | undefined)[]) =>
  parts.filter(Boolean).join(" ");

export type TableProps = TableHTMLAttributes<HTMLTableElement>;

/**
 * Structure is 1px rules and nothing else: no outer border, no zebra fill,
 * no radius, no shadow. Numerals are tabular for the whole table.
 */
export function Table({ className, ...props }: TableProps) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cx("w-full border-collapse text-left", className)}
        {...props}
      />
    </div>
  );
}

export function TableHead({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...props} />;
}

export function TableBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cx("border-b border-b-rule", className)} {...props} />
  );
}

export interface TableHeaderCellProps
  extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Right-aligns to match a numeric column. */
  numeric?: boolean;
}

/**
 * Column headers use the eyebrow: 13px, uppercased in CSS, no colour
 * change and no rule of their own beyond the row's.
 */
export function TableHeaderCell({
  numeric,
  className,
  ...props
}: TableHeaderCellProps) {
  return (
    <th
      scope="col"
      className={cx(
        "eyebrow px-4 first:pl-0 last:pr-0 py-4 font-medium align-bottom",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** Tabular figures, right-aligned. Use for every score, count or duration. */
  numeric?: boolean;
  /** 12px secondary column — the one place --u-micro is allowed. */
  meta?: boolean;
}

export function TableCell({
  numeric,
  meta,
  className,
  ...props
}: TableCellProps) {
  return (
    <td
      className={cx(
        "px-4 first:pl-0 last:pr-0 py-5 align-middle",
        meta ? "text-u-micro" : "text-u-body",
        numeric && "numeric text-right",
        className,
      )}
      {...props}
    />
  );
}
