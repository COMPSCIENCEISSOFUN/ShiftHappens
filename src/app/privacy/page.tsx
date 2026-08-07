import Link from "next/link";

export const metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return <main className="mx-auto max-w-3xl px-6 py-16 text-slate-700">
    <Link href="/" className="text-sm font-semibold text-indigo-600">← ShiftHappens</Link>
    <h1 className="mt-8 text-4xl font-bold text-slate-950">Privacy Policy</h1>
    <p className="mt-3 text-sm text-slate-500">Last updated: August 7, 2026</p>
    <div className="mt-10 space-y-7 leading-7">
      <section><h2 className="text-xl font-semibold text-slate-900">Information we process</h2><p>ShiftHappens processes account details, organization membership, schedules, availability, certification records, work activity, audit events, billing identifiers, and support enquiries needed to provide the service.</p></section>
      <section><h2 className="text-xl font-semibold text-slate-900">How information is used</h2><p>We use information to authenticate users, operate workforce planning features, enforce permissions and subscriptions, send requested notifications, protect the service, and respond to support or sales enquiries.</p></section>
      <section><h2 className="text-xl font-semibold text-slate-900">Sharing and retention</h2><p>Information is shared only with service providers needed to operate the product or when legally required. Organization administrators control workforce records. Records are retained while an account is active and as needed for security, billing, legal, and audit obligations.</p></section>
      <section><h2 className="text-xl font-semibold text-slate-900">Your choices</h2><p>You may update profile information and notification preferences in the application. For access, correction, deletion, or privacy questions, use the contact form on the ShiftHappens home page.</p></section>
    </div>
  </main>;
}
