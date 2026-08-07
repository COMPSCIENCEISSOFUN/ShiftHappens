import Link from "next/link";

export const metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return <main className="mx-auto max-w-3xl px-6 py-16 text-slate-700">
    <Link href="/" className="text-sm font-semibold text-indigo-600">← ShiftHappens</Link>
    <h1 className="mt-8 text-4xl font-bold text-slate-950">Terms of Service</h1>
    <p className="mt-3 text-sm text-slate-500">Last updated: August 7, 2026</p>
    <div className="mt-10 space-y-7 leading-7">
      <section><h2 className="text-xl font-semibold text-slate-900">Using the service</h2><p>You must provide accurate account information, protect your credentials, and use ShiftHappens lawfully. Organization administrators are responsible for configuring roles, work rules, schedules, and employee data appropriately.</p></section>
      <section><h2 className="text-xl font-semibold text-slate-900">Workforce decisions</h2><p>Scheduling suggestions and AI-generated results are operational aids. Authorized users remain responsible for reviewing decisions, legal requirements, safety rules, and employment obligations before publishing or assigning work.</p></section>
      <section><h2 className="text-xl font-semibold text-slate-900">Subscriptions</h2><p>Plan limits apply to the resources and features shown at purchase. Paid subscriptions renew according to the selected billing interval until cancelled through the billing portal.</p></section>
      <section><h2 className="text-xl font-semibold text-slate-900">Availability and liability</h2><p>The service is provided subject to reasonable maintenance and availability constraints. Do not rely on it as the sole system for emergency, payroll, legal, or life-safety decisions.</p></section>
    </div>
  </main>;
}
