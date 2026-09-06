"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AppNavProps {
  /** Live counts from the layout's query. `null` renders no count. */
  counts: {
    sessions: number | null;
    reports: number | null;
    questions: number | null;
  };
}

const items = [
  { label: "Dashboard", href: "/dashboard", count: null },
  { label: "Sessions", href: "/sessions", count: "sessions" },
  { label: "Reports", href: "/reports", count: "reports" },
  { label: "Question bank", href: "/questions", count: "questions" },
  { label: "Resume", href: "/resume", count: null },
  { label: "Settings", href: "/settings", count: null },
] as const;

/**
 * Client-side only because the active item needs the pathname, which a
 * server layout cannot see. Counts are passed down from the server.
 */
export function AppNav({ counts }: AppNavProps) {
  const pathname = usePathname();

  return (
    <ul className="flex flex-row gap-8 overflow-x-auto lg:flex-col lg:gap-7">
      {items.map((item) => {
        const current = pathname === item.href;
        const count = item.count ? counts[item.count] : null;

        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={[
                "flex items-center justify-between gap-4 text-u-body",
                current ? "font-medium" : "font-normal",
              ].join(" ")}
            >
              <span>{item.label}</span>
              {count !== null ? (
                <span className="numeric">{count}</span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
