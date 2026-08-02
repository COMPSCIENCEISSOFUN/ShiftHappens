/**
 * Scroll-reveal primitives for the landing page (Boundary Layer).
 *
 * Extracted from `landing-page.tsx` so more than one landing section can use
 * them. The alternative was a second copy in `team-section.tsx`, and two
 * copies of an IntersectionObserver drift apart the moment one is tuned.
 *
 * `useScrollReveal` is still used by `useCountUp` inside `landing-page.tsx`,
 * which is why it is exported rather than kept private to `Reveal`.
 */
"use client";

import { useRef, useState, useEffect } from "react";

/**
 * Reports when an element first scrolls into view.
 *
 * Honours `prefers-reduced-motion` by revealing immediately rather than
 * animating — a reader who has asked the OS for less motion should still get
 * the content, just without it sliding in.
 */
export function useScrollReveal(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReduced) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: reads prefers-reduced-motion and reveals immediately instead of on scroll
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, isVisible };
}

/** Fades and lifts its children into view once, on first scroll past. */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const { ref, isVisible } = useScrollReveal();
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
      } ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
