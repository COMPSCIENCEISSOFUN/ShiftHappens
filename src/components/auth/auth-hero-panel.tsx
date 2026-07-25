/**
 * Auth Hero Panel Component (Boundary Layer)
 *
 * Branded left-side panel for the split-screen auth layout.
 * Displays product tagline, feature highlights, and animated
 * background elements. Shared across all auth pages.
 */
import {
  CalendarDays,
  Users,
  Sparkles,
  BarChart3,
} from "lucide-react";

const FEATURES = [
  { icon: CalendarDays, label: "Intelligent shift scheduling" },
  { icon: Users, label: "Real-time team availability" },
  { icon: Sparkles, label: "AI-driven recommendations" },
  { icon: BarChart3, label: "Compliance & hour tracking" },
];

export function AuthHeroPanel() {
  return (
    <div className="hidden lg:flex lg:flex-1 relative flex-col justify-center overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-500 px-12 py-16 xl:px-16">
      {/* ---- Animated background elements ---- */}

      {/* Floating orbs */}
      <div className="absolute -top-20 -right-20 h-[400px] w-[400px] rounded-full bg-white/[0.07] animate-[float_20s_ease-in-out_infinite]" />
      <div className="absolute top-1/3 -left-16 h-[250px] w-[250px] rounded-full bg-white/[0.05] animate-[float_15s_ease-in-out_infinite_reverse]" />
      <div className="absolute -bottom-10 right-1/4 h-[300px] w-[300px] rounded-full bg-violet-400/20 animate-[float_25s_ease-in-out_infinite_2s]" />
      <div className="absolute top-1/4 right-1/3 h-[150px] w-[150px] rounded-full bg-indigo-300/10 animate-[float_18s_ease-in-out_infinite_reverse_1s]" />

      {/* Glowing pulse ring */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full border border-white/[0.08] animate-[pulse-ring_4s_ease-in-out_infinite]" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[450px] w-[450px] rounded-full border border-white/[0.05] animate-[pulse-ring_4s_ease-in-out_infinite_1s]" />

      {/* Dot grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "radial-gradient(circle, white 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* Subtle top-right shine sweep */}
      <div className="absolute -top-1/2 -right-1/2 h-full w-full bg-gradient-to-bl from-white/[0.08] via-transparent to-transparent animate-[shine_8s_ease-in-out_infinite]" />

      {/* ---- Content ---- */}
      <div className="relative z-10 max-w-md">
        <h1 className="text-3xl font-extrabold leading-tight text-white xl:text-4xl">
          Smarter shifts.
          <br />
          Happier teams.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-white/80 xl:text-lg">
          AI-powered task allocation that balances workload, respects
          availability, and keeps your operation running smoothly.
        </p>

        <div className="mt-12 flex flex-col gap-4">
          {FEATURES.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-3 text-sm font-medium text-white/90"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 backdrop-blur-sm">
                <Icon className="h-4 w-4" />
              </div>
              {label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
