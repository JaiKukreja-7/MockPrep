"use client";

import { useEffect } from "react";

/**
 * Scroll reveal for the landing page. Behaviour only — the styles are the
 * [data-reveal] rules in globals.css.
 *
 * Order matters for the no-JS guarantee: every section renders visible with
 * a bare `data-reveal` attribute. Only here, once React has mounted and an
 * IntersectionObserver exists, do sections that sit below the viewport get
 * marked "pending" (hidden, 12px low); the observer marks each "in" as it
 * enters and then stops watching it, so nothing replays on the way back up.
 * Sections already on screen at mount are left alone: fading in what the
 * visitor is already looking at is the kind of motion this must not be.
 *
 * Stagger is three tiers (0 / 40 / 80ms) so a section's last item has
 * landed within 480ms of its first starting — under the 500ms line.
 *
 * Under prefers-reduced-motion nothing is marked at all.
 */
export function Reveal() {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const sections = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const below = sections.filter((el) => el.getBoundingClientRect().top > window.innerHeight);
    if (below.length === 0) return;

    for (const el of below) {
      el.querySelectorAll<HTMLElement>("[data-reveal-item]").forEach((item, i) => {
        item.style.setProperty("--reveal-i", String(Math.min(i, 2)));
      });
      el.dataset.reveal = "pending";
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.reveal = "in";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const el of below) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return null;
}
