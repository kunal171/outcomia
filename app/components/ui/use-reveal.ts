"use client";
import { useEffect, useRef } from "react";

/** Reveals `[data-reveal]` descendants as they scroll into view. Without
 * JavaScript, or with reduced motion, everything is simply visible. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    root.classList.add("reveal-ready");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.reveal = "in";
            observer.unobserve(entry.target);
          }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);
  return ref;
}
