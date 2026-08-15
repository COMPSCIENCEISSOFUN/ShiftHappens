import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";
import { CONTACT_EMAIL } from "@/lib/site";

/** Chrome and typography shared by the terms and privacy pages. */
export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/" aria-label="ShiftHappens home">
            <Logo />
          </Link>
          <Link
            href="/"
            className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-sm text-slate-500">Last updated {updated}</p>
        <p className="mt-6 text-base leading-relaxed text-slate-600">{intro}</p>

        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm leading-relaxed text-amber-900">
            ShiftHappens is a student project built for CSIT321 at the
            University of Wollongong, SIM campus. This page describes how the
            system actually behaves, but it has not been reviewed by a lawyer
            and is not a commercial agreement.
          </p>
        </div>

        <div className="mt-12 space-y-10">{children}</div>

        <div className="mt-16 border-t border-slate-200 pt-8">
          <p className="text-sm text-slate-500">
            Questions about this page? Email{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="font-medium text-indigo-600 hover:text-indigo-500"
            >
              {CONTACT_EMAIL}
            </a>
            .
          </p>
          <div className="mt-4 flex flex-wrap gap-6 text-sm text-slate-500">
            <Link href="/terms" className="hover:text-slate-900">
              Terms of Service
            </Link>
            <Link href="/privacy" className="hover:text-slate-900">
              Privacy Policy
            </Link>
            <Link href="/" className="hover:text-slate-900">
              Home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

/** One headed section of a legal page. */
export function Section({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>
      <div className="space-y-3 text-base leading-relaxed text-slate-600">
        {children}
      </div>
    </section>
  );
}

/** A bulleted list. Static content, so the index is a stable key. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-slate-400">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
