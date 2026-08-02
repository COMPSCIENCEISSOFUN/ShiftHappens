/**
 * Landing Page Component (Boundary Layer)
 *
 * Public-facing marketing page for Smart Task Allocation.
 * Pricing section pulls from the centralized tier config —
 * same source of truth as the backend enforcement.
 *
 * Design: Indigo/violet hero with animated background,
 * floating UI preview cards, animated counters, typewriter text,
 * bento feature grid with gradient-glow hover, and full mobile
 * responsiveness.
 */
"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useScrollReveal, Reveal } from "./reveal";
import TeamSection from "./team-section";
import {
  Brain,
  CalendarClock,
  ArrowLeftRight,
  ShieldCheck,
  Users,
  BarChart3,
  Check,
  X,
  ChevronRight,
  Zap,
  Clock,
  Target,
  Play,
  Menu,
  Bell,
  TrendingUp,
  Star,
  Send,
  MessageSquare,
} from "lucide-react";
import {
  TIER_CONFIG,
  PRICING_FEATURES,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

// ─── Video Source Configuration ───────────────────────────────────────────
// Replace null with your video details when ready.
//
// Examples:
//   { url: "https://www.youtube.com/embed/VIDEO_ID", type: "embed" }
//   { url: "/videos/product-demo.mp4", type: "file" }
//
const VIDEO_SOURCES: Record<
  string,
  { url: string; type: "embed" | "file" } | null
> = {
  demo: null,
  technical: null,
};

// Industries for the typewriter effect
const INDUSTRIES = [
  "healthcare",
  "retail",
  "hospitality",
  "logistics",
  "security",
];

// ─── Hooks ────────────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 1200) {
  const { ref, isVisible } = useScrollReveal(0.5);
  const [count, setCount] = useState(0);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!isVisible || hasAnimated.current) return;
    hasAnimated.current = true;

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReduced) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: reads prefers-reduced-motion and skips straight to the final value
      setCount(target);
      return;
    }

    const startTime = performance.now();
    function step(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }, [isVisible, target, duration]);

  return { ref, count };
}

function useTypewriter(words: string[]) {
  const [display, setDisplay] = useState("");
  const state = useRef({ wordIdx: 0, charIdx: 0, deleting: false });

  useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReduced) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: reads prefers-reduced-motion and shows the word without typing it out
      setDisplay(words[0]);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const s = state.current;

    function tick() {
      const word = words[s.wordIdx];

      if (!s.deleting) {
        s.charIdx++;
        setDisplay(word.slice(0, s.charIdx));
        if (s.charIdx === word.length) {
          timer = setTimeout(() => {
            s.deleting = true;
            tick();
          }, 2000);
        } else {
          timer = setTimeout(tick, 70 + Math.random() * 50);
        }
      } else {
        s.charIdx--;
        setDisplay(word.slice(0, s.charIdx));
        if (s.charIdx === 0) {
          s.deleting = false;
          s.wordIdx = (s.wordIdx + 1) % words.length;
          timer = setTimeout(tick, 400);
        } else {
          timer = setTimeout(tick, 35);
        }
      }
    }

    timer = setTimeout(tick, 1500);
    return () => clearTimeout(timer);
  }, [words]);

  return display;
}

// ─── Shared Components ────────────────────────────────────────────────────

function CountUpStat({ value, label }: { value: number; label: string }) {
  const { ref, count } = useCountUp(value);
  return (
    <div ref={ref} className="text-center">
      <p className="text-2xl font-bold text-white">{count}</p>
      <p className="text-[11px] sm:text-xs text-white/50 mt-1">{label}</p>
    </div>
  );
}

// ─── Navbar ───────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#demo", label: "Demo" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "#pricing", label: "Pricing" },
  { href: "#team", label: "Team" },
];

function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 768) setMobileOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/90 backdrop-blur-md shadow-sm border-b border-slate-200"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto max-w-6xl px-6 flex items-center justify-between h-16">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-sm font-extrabold text-white shadow-sm">
            S
          </div>
          <span
            className={`text-lg font-bold tracking-tight transition-colors hidden sm:inline ${
              scrolled ? "text-slate-900" : "text-white"
            }`}
          >
            Smart Task Allocation
          </span>
        </div>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`text-sm transition-colors ${
                scrolled
                  ? "text-slate-600 hover:text-indigo-600"
                  : "text-white/70 hover:text-white"
              }`}
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Desktop auth */}
        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/login"
            className={`text-sm font-medium transition-colors ${
              scrolled
                ? "text-slate-700 hover:text-indigo-600"
                : "text-white/80 hover:text-white"
            }`}
          >
            Log in
          </Link>
          <Link
            href="/register"
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all shadow-sm ${
              scrolled
                ? "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white hover:from-indigo-700 hover:to-indigo-600"
                : "bg-white text-indigo-600 hover:bg-white/90"
            }`}
          >
            Get Started Free
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className={`md:hidden p-2 rounded-lg transition-colors ${
            scrolled ? "text-slate-700" : "text-white"
          }`}
          aria-label="Toggle menu"
        >
          {mobileOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <Menu className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* Mobile menu */}
      <div
        className={`md:hidden overflow-hidden transition-all duration-300 bg-white border-b border-slate-200 shadow-lg ${
          mobileOpen ? "max-h-80 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="px-6 py-4 space-y-3">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={closeMobile}
              className="block text-sm text-slate-600 hover:text-indigo-600 transition-colors py-1"
            >
              {link.label}
            </a>
          ))}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <Link
              href="/login"
              className="block text-sm font-medium text-slate-700 hover:text-indigo-600 py-1"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="block rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-2.5 text-sm font-medium text-white text-center"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────

function Hero() {
  const typedIndustry = useTypewriter(INDUSTRIES);

  return (
    <section className="relative min-h-[90vh] flex items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-500">
      {/* ---- Animated background ---- */}

      {/* Floating orbs */}
      <div className="absolute -top-20 -right-20 h-[400px] w-[400px] rounded-full bg-white/[0.07] animate-[float_20s_ease-in-out_infinite]" />
      <div className="absolute top-1/3 -left-16 h-[250px] w-[250px] rounded-full bg-white/[0.05] animate-[float_15s_ease-in-out_infinite_reverse]" />
      <div className="absolute -bottom-10 right-1/4 h-[300px] w-[300px] rounded-full bg-violet-400/20 animate-[float_25s_ease-in-out_infinite_2s]" />
      <div className="absolute top-1/4 right-1/3 h-[150px] w-[150px] rounded-full bg-indigo-300/10 animate-[float_18s_ease-in-out_infinite_reverse_1s]" />

      {/* Pulse rings */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full border border-white/[0.08] animate-[pulse-ring_4s_ease-in-out_infinite]" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[450px] w-[450px] rounded-full border border-white/[0.05] animate-[pulse-ring_4s_ease-in-out_infinite_1s]" />

      {/* Dot grid */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "radial-gradient(circle, white 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* Shine sweep */}
      <div className="absolute -top-1/2 -right-1/2 h-full w-full bg-gradient-to-bl from-white/[0.08] via-transparent to-transparent animate-[shine_8s_ease-in-out_infinite]" />

      {/* ---- Floating UI preview cards (desktop only) ---- */}

      {/* AI Suggestion card */}
      <div className="hidden lg:block absolute top-[18%] right-[6%] xl:right-[10%] z-[5] animate-[float_12s_ease-in-out_infinite_0.5s]">
        <div className="rounded-xl bg-white/[0.12] backdrop-blur-md border border-white/20 px-4 py-3 shadow-lg w-52">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="h-3.5 w-3.5 text-white/80" />
            <span className="text-[11px] font-semibold text-white/90 uppercase tracking-wide">
              AI Suggestion
            </span>
          </div>
          <p className="text-sm font-medium text-white mb-1.5">
            Sarah M.
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/20 overflow-hidden">
              <div className="h-full w-[98%] rounded-full bg-gradient-to-r from-emerald-400 to-emerald-300" />
            </div>
            <span className="text-xs font-semibold text-emerald-300">
              98%
            </span>
          </div>
        </div>
      </div>

      {/* Coverage card */}
      <div className="hidden lg:block absolute top-[55%] left-[4%] xl:left-[8%] z-[5] animate-[float_14s_ease-in-out_infinite_reverse_1s]">
        <div className="rounded-xl bg-white/[0.12] backdrop-blur-md border border-white/20 px-4 py-3 shadow-lg w-44">
          <div className="flex items-center gap-2 mb-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-emerald-300" />
            <span className="text-[11px] font-semibold text-white/90 uppercase tracking-wide">
              Coverage
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold text-white">100%</span>
            <span className="text-[11px] text-white/50">Mon–Fri</span>
          </div>
        </div>
      </div>

      {/* Notification card */}
      <div className="hidden lg:block absolute bottom-[22%] right-[12%] xl:right-[16%] z-[5] animate-[float_16s_ease-in-out_infinite_2s]">
        <div className="rounded-xl bg-white/[0.12] backdrop-blur-md border border-white/20 px-4 py-2.5 shadow-lg">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-400/30">
              <Bell className="h-3.5 w-3.5 text-white" />
            </div>
            <div>
              <p className="text-xs font-medium text-white">
                Shift swap approved
              </p>
              <p className="text-[10px] text-white/50">Just now</p>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Content ---- */}
      <div className="relative z-10 mx-auto max-w-4xl px-6 text-center pt-20">
        <Reveal>
          <p className="mb-4 inline-block rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm text-white/90 backdrop-blur-sm">
            AI-powered workforce management
          </p>
        </Reveal>

        <Reveal delay={100}>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-white leading-[1.1]">
            Smarter shifts.
            <br />
            Happier teams.
          </h1>
        </Reveal>

        <Reveal delay={200}>
          <p className="mt-6 text-base sm:text-lg text-white/70 max-w-2xl mx-auto leading-relaxed">
            Smart Task Allocation matches staff to shifts using AI that
            considers availability, certifications, work rules, and fairness
            — so your schedule builds itself.
          </p>
        </Reveal>

        {/* Typewriter line */}
        <Reveal delay={250}>
          <p className="mt-3 text-sm text-white/40">
            Built for{" "}
            <span className="text-white/80 font-medium">
              {typedIndustry}
            </span>
            <span className="animate-[blink_1s_step-end_infinite] text-white/60">
              |
            </span>{" "}
            teams.
          </p>
        </Reveal>

        <Reveal delay={300}>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/register"
              className="w-full sm:w-auto rounded-lg bg-white px-6 py-3 text-base font-semibold text-indigo-600 hover:bg-white/90 transition-colors flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/25"
            >
              Get started free <ChevronRight className="h-4 w-4" />
            </Link>
            <a
              href="#demo"
              className="w-full sm:w-auto rounded-lg border border-white/30 px-6 py-3 text-base font-medium text-white hover:bg-white/10 transition-colors backdrop-blur-sm text-center"
            >
              Watch the demo
            </a>
          </div>
        </Reveal>

        {/* Animated counter stats */}
        <Reveal delay={400}>
          <div className="mt-16 grid grid-cols-3 gap-4 sm:gap-8 max-w-lg mx-auto">
            <CountUpStat value={4} label="Eligibility checks per assignment" />
            <CountUpStat value={6} label="AI-powered features" />
            <CountUpStat value={3} label="Role-based access levels" />
          </div>
        </Reveal>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-white to-transparent" />
    </section>
  );
}

// ─── Video Showcase ──────────────────────────────────────────────────────

const VIDEO_TABS = [
  {
    key: "demo" as const,
    label: "Product Demo",
    placeholder: "Product demo coming soon",
  },
  {
    key: "technical" as const,
    label: "Technical Guide",
    placeholder: "Technical walkthrough coming soon",
  },
];

function VideoShowcase() {
  const [activeTab, setActiveTab] = useState<"demo" | "technical">("demo");
  const tab = VIDEO_TABS.find((t) => t.key === activeTab)!;
  const source = VIDEO_SOURCES[activeTab];

  return (
    <section id="demo" className="py-20 sm:py-24 bg-white">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-10">
            <p className="text-sm font-medium text-indigo-600 mb-2">
              See it in action
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
              Watch how it works
            </h2>
          </div>
        </Reveal>

        {/* Toggle tabs */}
        <Reveal delay={100}>
          <div className="flex justify-center mb-8">
            <div className="inline-flex rounded-lg bg-slate-100 p-1">
              {VIDEO_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition-all ${
                    activeTab === t.key
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Video container */}
        <Reveal delay={200}>
          <div className="relative aspect-video w-full rounded-2xl overflow-hidden border border-slate-200 shadow-lg">
            {source ? (
              source.type === "embed" ? (
                <iframe
                  src={source.url}
                  className="absolute inset-0 h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  title={tab.label}
                />
              ) : (
                <video
                  src={source.url}
                  className="absolute inset-0 h-full w-full object-cover"
                  controls
                  playsInline
                />
              )
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col items-center justify-center gap-4">
                <div
                  className="absolute inset-0 opacity-[0.03]"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle, white 1px, transparent 1px)",
                    backgroundSize: "20px 20px",
                  }}
                />
                <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 hover:scale-110 transition-transform duration-300 cursor-pointer">
                  <Play className="h-6 w-6 ml-0.5" fill="currentColor" />
                </div>
                <p className="relative text-sm text-slate-400">
                  {tab.placeholder}
                </p>
              </div>
            )}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ─── Features (Bento Grid) ──────────────────────────────────────────────

const FEATURES = [
  {
    icon: Brain,
    title: "AI Staff Suggestions",
    description:
      "The engine ranks every eligible staff member by availability, certifications, hours worked, and historical performance — then recommends the best match.",
    featured: true,
  },
  {
    icon: CalendarClock,
    title: "One-Click Auto-Schedule",
    description:
      "Generate a full week of assignments in seconds. The AI balances workload fairly, respects all constraints, and lets you review before confirming.",
    featured: false,
  },
  {
    icon: ArrowLeftRight,
    title: "Smart-Swap Replacements",
    description:
      "When someone cancels, the system immediately finds qualified replacements and notifies you with the top recommendation.",
    featured: false,
  },
  {
    icon: ShieldCheck,
    title: "Work Rules Engine",
    description:
      "Define break intervals, daily hour caps, and weekly limits — per department or per role. The eligibility engine enforces them automatically.",
    featured: false,
  },
  {
    icon: Users,
    title: "Role-Based Access",
    description:
      "Admins see everything. Managers see their department. Staff see their own schedule. Custom roles add granular permissions on top.",
    featured: false,
  },
  {
    icon: BarChart3,
    title: "Real-Time Insights",
    description:
      "Coverage gaps, rejection trends, staffing ratios, and AI recommendations — all on a dashboard tailored to your role.",
    featured: true,
  },
];

function FeatureCard({
  feature,
  delay,
}: {
  feature: (typeof FEATURES)[number];
  delay: number;
}) {
  return (
    <Reveal
      className={feature.featured ? "sm:col-span-2" : ""}
      delay={delay}
    >
      <div className="group relative h-full">
        {/* Gradient glow on hover */}
        <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-500 opacity-0 group-hover:opacity-70 blur transition-opacity duration-500" />

        {/* Card */}
        <div className="relative rounded-xl border border-slate-200 bg-white p-6 h-full transition-colors duration-300 group-hover:border-indigo-200/50">
          {feature.featured ? (
            /* Featured: horizontal layout */
            <div className="sm:flex sm:items-start sm:gap-6">
              <div className="shrink-0 mb-4 sm:mb-0 inline-flex rounded-xl bg-indigo-50 p-3.5 text-indigo-600 group-hover:bg-indigo-100 transition-colors">
                <feature.icon className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-lg sm:text-xl font-semibold text-slate-900 mb-2">
                  {feature.title}
                </h3>
                <p className="text-sm text-slate-500 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            </div>
          ) : (
            /* Regular: vertical layout */
            <>
              <div className="mb-4 inline-flex rounded-lg bg-indigo-50 p-2.5 text-indigo-600 group-hover:bg-indigo-100 transition-colors">
                <feature.icon className="h-5 w-5" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-slate-500 leading-relaxed">
                {feature.description}
              </p>
            </>
          )}
        </div>
      </div>
    </Reveal>
  );
}

function Features() {
  return (
    <section id="features" className="py-20 sm:py-24 bg-slate-50">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-16">
            <p className="text-sm font-medium text-indigo-600 mb-2">
              Features
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
              Everything your scheduling needs
            </h2>
            <p className="mt-4 text-slate-500">
              Built for shift-based teams in hospitality, healthcare, retail,
              and beyond.
            </p>
          </div>
        </Reveal>

        {/* Bento grid: 1 col mobile → 2 col sm → 4 col lg */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {FEATURES.map((feature, i) => (
            <FeatureCard key={feature.title} feature={feature} delay={i * 80} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── How It Works ────────────────────────────────────────────────────────

const STEPS = [
  {
    icon: Target,
    title: "Set up your organization",
    description:
      "Create departments, define work rules, and configure operating hours. Choose an industry template or start from scratch.",
  },
  {
    icon: Users,
    title: "Invite your team",
    description:
      "Add staff with their availability, certifications, and employment type. The system knows who can work when.",
  },
  {
    icon: Zap,
    title: "Let AI schedule",
    description:
      "Click auto-schedule or assign manually with AI suggestions. Review the plan, adjust if needed, and confirm.",
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 sm:py-24 bg-white">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-16">
            <p className="text-sm font-medium text-indigo-600 mb-2">
              How it works
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
              Up and running in minutes
            </h2>
          </div>
        </Reveal>

        <div className="grid md:grid-cols-3 gap-8 sm:gap-10">
          {STEPS.map((step, i) => (
            <Reveal key={step.title} delay={i * 120}>
              <div className="relative text-center">
                <div className="mx-auto mb-5 inline-flex rounded-full bg-indigo-50 p-4 border border-indigo-100">
                  <step.icon className="h-6 w-6 text-indigo-600" />
                </div>
                <div className="mb-2 text-xs font-bold text-indigo-400 uppercase tracking-wider">
                  Step {i + 1}
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-2">
                  {step.title}
                </h3>
                <p className="text-sm text-slate-500 leading-relaxed">
                  {step.description}
                </p>
                {i < STEPS.length - 1 && (
                  <div className="hidden md:block absolute top-8 left-[60%] w-[80%] border-t border-dashed border-slate-300" />
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Pricing ─────────────────────────────────────────────────────────────

const TIER_ORDER: SubscriptionTier[] = ["free", "pro", "enterprise"];

function Pricing() {
  return (
    <section id="pricing" className="py-20 sm:py-24 bg-slate-50">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-16">
            <p className="text-sm font-medium text-indigo-600 mb-2">
              Pricing
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
              Start free, scale when ready
            </h2>
            <p className="mt-4 text-slate-500">
              Every plan includes all AI features. Upgrade when your team grows.
            </p>
          </div>
        </Reveal>

        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {TIER_ORDER.map((tierKey, i) => {
            const tier = TIER_CONFIG[tierKey];
            const isPro = tierKey === "pro";

            return (
              <Reveal key={tierKey} delay={i * 100}>
                <div
                  className={`relative rounded-xl p-6 flex flex-col h-full transition-all duration-300 hover:shadow-lg ${
                    isPro
                      ? "border-2 border-indigo-600 bg-white shadow-md"
                      : "border border-slate-200 bg-white"
                  }`}
                >
                  {isPro && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-medium text-white">
                      Most popular
                    </span>
                  )}

                  <div className="mb-6">
                    <h3 className="text-lg font-semibold text-slate-900">
                      {tier.displayName}
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">
                      {tier.tagline}
                    </p>
                    <div className="mt-4">
                      {tier.monthlyPrice !== null ? (
                        <div className="flex items-baseline gap-1">
                          <span className="text-4xl font-bold text-slate-900">
                            ${tier.monthlyPrice}
                          </span>
                          {tier.monthlyPrice > 0 && (
                            <span className="text-slate-500 text-sm">
                              /month
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-4xl font-bold text-slate-900">
                          Custom
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Limits */}
                  <div className="space-y-2 mb-6 pb-6 border-b border-slate-100">
                    {Object.entries(tier.limits).map(([key, value]) => (
                      <div
                        key={key}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-slate-600">
                          {key === "members"
                            ? "Team members"
                            : key === "active_tasks"
                              ? "Active tasks"
                              : key === "departments"
                                ? "Departments"
                                : key === "work_rules"
                                  ? "Work rules"
                                  : "Custom roles"}
                        </span>
                        <span className="font-medium text-slate-900">
                          {value === null
                            ? "Unlimited"
                            : value === 0
                              ? "—"
                              : `Up to ${value}`}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Feature checklist */}
                  <div className="space-y-2 flex-1">
                    {PRICING_FEATURES.filter((f) => f.category === "tools").map(
                      (feature) => {
                        const val =
                          feature[tierKey as keyof typeof feature];
                        const available = val === true;
                        return (
                          <div
                            key={feature.name}
                            className="flex items-center gap-2 text-sm"
                          >
                            {available ? (
                              <Check className="h-4 w-4 text-indigo-500 shrink-0" />
                            ) : (
                              <X className="h-4 w-4 text-slate-300 shrink-0" />
                            )}
                            <span
                              className={
                                available
                                  ? "text-slate-700"
                                  : "text-slate-400"
                              }
                            >
                              {feature.name}
                            </span>
                          </div>
                        );
                      }
                    )}
                  </div>

                  <div className="mt-6">
                    <Link
                      href={tierKey === "enterprise" ? "#contact" : "/register"}
                      className={`block w-full rounded-lg py-2.5 text-center text-sm font-medium transition-colors ${
                        isPro
                          ? "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white hover:from-indigo-700 hover:to-indigo-600"
                          : tierKey === "enterprise"
                            ? "bg-slate-900 text-white hover:bg-slate-800"
                            : "bg-slate-100 text-slate-900 hover:bg-slate-200"
                      }`}
                    >
                      {tierKey === "enterprise"
                        ? "Contact us"
                        : tierKey === "pro"
                          ? "Get started"
                          : "Start free"}
                    </Link>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={350}>
          <p className="text-center text-sm text-slate-400 mt-8">
            All plans include AI suggestions, auto-schedule, smart-swap,
            natural language tasks, dashboard insights, and coverage detection.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

// ─── Testimonials ────────────────────────────────────────────────────────

const TESTIMONIALS = [
  {
    name: "Rachel Lim",
    role: "Operations Manager",
    company: "Greenfield Medical Centre",
    quote:
      "We used to spend hours juggling nurse rosters across three wards. Now the AI handles the heavy lifting — compliance checks, fair distribution, the lot. Our scheduling time dropped significantly.",
    rating: 5,
  },
  {
    name: "Marcus Chen",
    role: "Store Manager",
    company: "Urban Threads Retail",
    quote:
      "The smart-swap feature alone justified the switch. When someone calls in sick, I get a qualified replacement suggestion within seconds instead of working through a call list.",
    rating: 5,
  },
  {
    name: "Priya Nair",
    role: "Shift Coordinator",
    company: "Horizon Hotel Group",
    quote:
      "Managing availability across full-time, part-time, and casual staff was a nightmare on spreadsheets. The role-based dashboards mean everyone sees exactly what they need.",
    rating: 4,
  },
];

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${
            i < rating
              ? "text-amber-400 fill-amber-400"
              : "text-slate-200"
          }`}
        />
      ))}
    </div>
  );
}

function Testimonials() {
  return (
    <section className="py-20 sm:py-24 bg-white">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-16">
            <p className="text-sm font-medium text-indigo-600 mb-2">
              Testimonials
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
              Trusted by teams across industries
            </h2>
            <p className="mt-4 text-slate-500">
              See what managers and coordinators say about switching to
              Smart&nbsp;Task&nbsp;Allocation.
            </p>
          </div>
        </Reveal>

        <div className="grid md:grid-cols-3 gap-6">
          {TESTIMONIALS.map((t, i) => (
            <Reveal key={t.name} delay={i * 100}>
              <div className="group h-full rounded-xl border border-slate-200 bg-white p-6 hover:shadow-lg hover:border-indigo-200/50 transition-all duration-300 flex flex-col">
                {/* Stars */}
                <StarRating rating={t.rating} />

                {/* Quote */}
                <p className="mt-4 flex-1 text-sm leading-relaxed text-slate-600">
                  &ldquo;{t.quote}&rdquo;
                </p>

                {/* Author */}
                <div className="mt-6 flex items-center gap-3 pt-4 border-t border-slate-100">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-sm font-bold text-white">
                    {t.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {t.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {t.role}, {t.company}
                    </p>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Contact / Enquiry Form ─────────────────────────────────────────────

function ContactForm() {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setSubmitted(true);
    }, 800);
  }

  return (
    <section id="contact" className="py-20 sm:py-24 bg-slate-50">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-start">
          {/* Left — info */}
          <Reveal>
            <div>
              <p className="text-sm font-medium text-indigo-600 mb-2">
                Get in touch
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
                Have a question?
              </h2>
              <p className="mt-4 text-slate-500 leading-relaxed">
                Whether you&apos;re exploring the platform for your team or need
                help with an Enterprise setup, we&apos;d love to hear from you.
              </p>

              <div className="mt-10 space-y-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <MessageSquare className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      General enquiries
                    </p>
                    <p className="text-sm text-slate-500">
                      Questions about features, pricing, or getting started.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <Users className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      Enterprise &amp; custom plans
                    </p>
                    <p className="text-sm text-slate-500">
                      Need unlimited members, audit logs, or priority support?
                      Let&apos;s talk.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      Quick response
                    </p>
                    <p className="text-sm text-slate-500">
                      We typically respond within one business day.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>

          {/* Right — form */}
          <Reveal delay={150}>
            <div className="rounded-2xl border border-slate-200 bg-white p-8 sm:p-10 shadow-sm">
              {submitted ? (
                <div className="text-center py-16">
                  <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
                    <Check className="h-8 w-8 text-indigo-600" />
                  </div>
                  <h3 className="text-xl font-semibold text-slate-900">
                    Message sent!
                  </h3>
                  <p className="mt-3 text-sm text-slate-500 max-w-xs mx-auto">
                    Thanks for reaching out. We&apos;ll get back to you shortly.
                  </p>
                  <button
                    onClick={() => setSubmitted(false)}
                    className="mt-8 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
                  >
                    Send another message
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Form header */}
                  <div className="mb-2">
                    <h3 className="text-lg font-semibold text-slate-900">
                      Send us a message
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">
                      Fill out the form below and we&apos;ll be in touch.
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-5">
                    <div>
                      <label
                        htmlFor="contact-name"
                        className="block text-sm font-medium text-slate-700 mb-2"
                      >
                        Name
                      </label>
                      <input
                        id="contact-name"
                        type="text"
                        required
                        placeholder="Your name"
                        className="w-full rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-all"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="contact-email"
                        className="block text-sm font-medium text-slate-700 mb-2"
                      >
                        Email
                      </label>
                      <input
                        id="contact-email"
                        type="email"
                        required
                        placeholder="you@company.com"
                        className="w-full rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-all"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="contact-company"
                      className="block text-sm font-medium text-slate-700 mb-2"
                    >
                      Company{" "}
                      <span className="text-slate-400 font-normal">
                        (optional)
                      </span>
                    </label>
                    <input
                      id="contact-company"
                      type="text"
                      placeholder="Your company"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-all"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="contact-message"
                      className="block text-sm font-medium text-slate-700 mb-2"
                    >
                      Message
                    </label>
                    <textarea
                      id="contact-message"
                      required
                      rows={5}
                      placeholder="Tell us what you're looking for..."
                      className="w-full rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-all resize-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-6 py-3.5 text-sm font-medium text-white hover:from-indigo-700 hover:to-indigo-600 transition-colors flex items-center justify-center gap-2 disabled:opacity-60 mt-2"
                  >
                    {loading ? (
                      "Sending..."
                    ) : (
                      <>
                        Send message <Send className="h-4 w-4" />
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ─── Final CTA ───────────────────────────────────────────────────────────

function FinalCTA() {
  return (
    <section className="py-20 sm:py-24 bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-500 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute -top-20 -right-20 h-[300px] w-[300px] rounded-full bg-white/[0.06] animate-[float_20s_ease-in-out_infinite]" />
      <div className="absolute bottom-0 -left-16 h-[200px] w-[200px] rounded-full bg-white/[0.04] animate-[float_15s_ease-in-out_infinite_reverse]" />
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "radial-gradient(circle, white 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <div className="relative z-10 mx-auto max-w-3xl px-6 text-center">
        <Reveal>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Stop wrestling with spreadsheets
          </h2>
          <p className="mt-4 text-base sm:text-lg text-white/70">
            Join teams that schedule smarter with AI — free to start,
            no credit card required.
          </p>
          <div className="mt-8">
            <Link
              href="/register"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-8 py-3 text-base font-semibold text-indigo-600 hover:bg-white/90 transition-colors shadow-lg shadow-indigo-600/20"
            >
              Get started free <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </Reveal>

        <Reveal delay={200}>
          <div className="mt-16 flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-8 text-sm text-white/60">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span>Set up in under 5 minutes</span>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              <span>No credit card required</span>
            </div>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              <span>Free for teams up to 10</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="bg-slate-950 border-t border-slate-800 py-12">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-sm font-extrabold text-white">
              S
            </div>
            <div>
              <span className="text-lg font-bold text-white tracking-tight">
                Smart Task Allocation
              </span>
              <p className="text-sm text-slate-500">
                Intelligent workforce scheduling for modern teams.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500">
            <a
              href="#features"
              className="hover:text-slate-300 transition-colors"
            >
              Features
            </a>
            <a
              href="#pricing"
              className="hover:text-slate-300 transition-colors"
            >
              Pricing
            </a>
            <Link
              href="/login"
              className="hover:text-slate-300 transition-colors"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="hover:text-slate-300 transition-colors"
            >
              Sign up
            </Link>
          </div>
        </div>
        <div className="mt-8 pt-8 border-t border-slate-800 text-center text-xs text-slate-600">
          &copy; {new Date().getFullYear()} Smart Task Allocation. CSIT321
          Final Year Project — University of Wollongong (SIM Campus).
        </div>
      </div>
    </footer>
  );
}

// ─── Landing Page ────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      <Navbar />
      <Hero />
      <VideoShowcase />
      <Features />
      <HowItWorks />
      <Pricing />
      <Testimonials />
      <TeamSection />
      <ContactForm />
      <FinalCTA />
      <Footer />
    </div>
  );
}
