"use client";

/**
 * The ShiftHappens mark, in one place.
 */
import Image from "next/image";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The artwork. One constant, so swapping the file is a single edit rather than
 * a search.
 *
 * A PNG, so it must carry its own resolution: the largest render here is 36px,
 * and a retina screen draws that at 72 real pixels. Anything under ~96px
 * square will look soft on exactly the machines people demo on. An SVG would
 * make the size question go away entirely, if one ever exists.
 */
export const LOGO_SRC = "/logo.png";

export const BRAND_NAME = "ShiftHappens";

/**
 * How big the mark is. Everywhere.
 *
 * It was a prop, and within a day of being one it had two values — 32 in three
 * places and 36 in a fourth — which is the same drift the five hand-typed
 * copies had before this component existed, arriving through the door the
 * component left open. A brand mark that is a different size on the auth page
 * from the landing page is not expressing anything; nobody decided that.
 *
 * One number. If a placement genuinely needs its own size, that is a decision
 * worth making here, with a name, rather than a number typed at a call site.
 */
export const LOGO_SIZE = 32;

/**
 * Just the mark.
 *
 * `tone` is about the BACKGROUND it sits on, not about the artwork. On the
 * indigo gradient — the sidebar header and the auth strip — a translucent tile
 * sits behind the mark so a dark logo stays legible; on a light page the mark
 * stands alone. Without it, whichever of the two the artwork was drawn for
 * would look right and the other would disappear.
 */
export function LogoMark({
  tone = "plain",
  className,
}: {
  tone?: "plain" | "on-brand";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px]",
        tone === "on-brand" && "bg-white/20 backdrop-blur-sm",
        // The letter tile only carries its own colour when the artwork is gone.
        failed &&
          tone === "plain" &&
          "bg-gradient-to-br from-indigo-500 to-indigo-600 text-white",
        failed && "text-sm font-extrabold",
        className
      )}
      /*
        A fixed square, and `object-contain` on the image inside it.

        The box does not follow the artwork — replacing the file must not
        change the layout of four pages. Anything that is not square is
        letterboxed inside the square rather than stretched to fill it, which
        is the one distortion nobody catches in review and everybody sees on
        the page.
      */
      style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
    >
      {failed ? (
        BRAND_NAME[0]
      ) : (
        <Image
          src={LOGO_SRC}
          alt=""
          /*
            Twice the rendered size, so a retina screen has real pixels to draw
            with. These are what the optimiser fetches, not what the browser
            lays out — the classes below decide that.
          */
          width={LOGO_SIZE * 2}
          height={LOGO_SIZE * 2}
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
          /*
            Decorative. Every place this renders sits beside the word
            "ShiftHappens" or inside a link that already names itself, so an
            alt text here would be read out twice.
          */
          aria-hidden="true"
          priority
        />
      )}
    </span>
  );
}

/**
 * The mark and the name together — the lockup.
 *
 * `tone` again follows the background: `light` is white text for the gradient
 * panels, `dark` is the theme's foreground for a normal page. The landing
 * header is neither, because it changes as the page scrolls, so it passes its
 * own class instead.
 */
export function Logo({
  tone = "dark",
  nameClassName,
  className,
  showName = true,
}: {
  tone?: "light" | "dark";
  /**
   * Overrides the name's colour and size. One caller needs it: the landing
   * header sits over the hero until it scrolls and then over white, so its
   * colour is a function of scroll position — a thing only that header knows.
   */
  nameClassName?: string;
  className?: string;
  showName?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark tone={tone === "light" ? "on-brand" : "plain"} />
      {showName && (
        <span
          className={cn(
            "text-lg font-bold tracking-tight",
            tone === "light" ? "text-white" : "text-foreground",
            nameClassName
          )}
        >
          {BRAND_NAME}
        </span>
      )}
    </span>
  );
}
