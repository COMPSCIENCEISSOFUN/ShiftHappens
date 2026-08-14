import type { Metadata } from "next";

import { Bullets, LegalPage, Section } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | ShiftHappens",
  description:
    "The terms that apply to organisations and members using ShiftHappens.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="14 August 2026"
      intro="These terms cover what ShiftHappens does, what it does not promise, and what is expected of the organisations and people who use it."
    >
      <Section heading="1. What ShiftHappens is">
        <p>
          ShiftHappens is a multi-tenant platform for shift-based workforce
          management. An organisation creates an account, invites its staff, and
          uses the system to publish shifts, record availability and leave, track
          certifications, and produce rosters with help from an allocation engine.
        </p>
        <p>
          It is built as a final year project. It is offered for demonstration
          and evaluation, not as a commercial service, and it carries no service
          level agreement.
        </p>
      </Section>

      <Section heading="2. Accounts">
        <Bullets
          items={[
            "You need an account to use anything beyond this public page. Give accurate details when you register, and keep your password to yourself.",
            "You are responsible for what happens under your account. Tell us if you think someone else has access to it.",
            "You must be old enough to work lawfully in your jurisdiction, since the system exists to roster people onto paid shifts.",
          ]}
        />
      </Section>

      <Section heading="3. Organisations, roles and what your employer can see">
        <p>
          The person who creates an organisation becomes its Company Admin. They
          invite everyone else and decide what each member is allowed to do,
          through roles and permissions that the organisation controls rather
          than we do.
        </p>
        <p>
          This is worth being direct about. If you join an organisation as a
          member, its admins and the managers of your departments can see your
          availability, your leave requests and the reasons you give for them,
          your certifications, the shifts you are assigned, your clock in and
          clock out times, and the reasons you give when you decline a shift.
          The system exists to make that information available to the people who
          build the roster.
        </p>
      </Section>

      <Section heading="4. Acceptable use">
        <Bullets
          items={[
            "Do not use the service unlawfully, or to do anything that breaches your local employment or working time rules.",
            "Do not try to reach data belonging to an organisation you are not a member of, or to escalate your own permissions beyond what your admin granted.",
            "Do not submit certifications you do not hold, or availability you know to be false.",
            "Do not attempt to overload, scrape or reverse engineer the service.",
          ]}
        />
      </Section>

      <Section heading="5. Plans and payment">
        <p>
          There is a Free plan and paid Pro and Enterprise plans. Paid plans are
          billed through Stripe. Card details are entered on Stripe's own hosted
          checkout and are never sent to or stored by ShiftHappens. We hold only
          the identifiers Stripe gives us for your customer and subscription
          records, plus your current tier and renewal date.
        </p>
        <p>
          You can cancel at any time. Cancelling stops the next renewal and your
          organisation keeps its paid features until the end of the period you
          have already paid for, after which it returns to Free. Features above
          the Free limits stop being available at that point, and existing data
          is not deleted because of a downgrade.
        </p>
      </Section>

      <Section heading="6. Automated scheduling">
        <p>
          Some features rank or select staff for shifts using a scoring engine
          and, on paid plans, a language model. These produce suggestions and
          drafts. A person confirms them.
        </p>
        <p>
          The engine applies the work rules your organisation configures, such as
          maximum hours and rest gaps. It is not a compliance tool. It does not
          know your jurisdiction's employment law, your collective agreements or
          anyone's contract, and it can be wrong. Responsibility for a published
          roster rests with the organisation that publishes it.
        </p>
      </Section>

      <Section heading="7. Your data">
        <p>
          Your organisation keeps ownership of the data it puts into the service.
          By using ShiftHappens you allow us to store and process that data for
          the purpose of running the features described here. The{" "}
          <a
            className="font-medium text-indigo-600 hover:text-indigo-500"
            href="/privacy"
          >
            Privacy Policy
          </a>{" "}
          sets out what is collected, who it reaches and how long it is kept.
        </p>
      </Section>

      <Section heading="8. Availability and changes">
        <p>
          The service is provided as it is, without any promise of uptime. It is
          a student project running on hosted infrastructure, and it may be
          unavailable, reset or withdrawn, including for reasons outside our
          control. Features may change or be removed as the project develops.
        </p>
      </Section>

      <Section heading="9. Suspension">
        <p>
          An account or an organisation may be suspended where these terms are
          broken, where use puts other users at risk, or where required by the
          platform we run on. A suspended organisation keeps its data and its
          administrators are told why.
        </p>
      </Section>

      <Section heading="10. Liability">
        <p>
          To the extent the law allows, ShiftHappens is provided without
          warranties of any kind, and we are not liable for loss arising from use
          of it. That includes rosters that turn out to be wrong, shifts that go
          unfilled, notifications that do not arrive and data that is lost.
          Nothing here limits liability that cannot lawfully be limited.
        </p>
      </Section>

      <Section heading="11. Governing law">
        <p>
          These terms are governed by the laws of Singapore, and the courts of
          Singapore have jurisdiction over any dispute arising from them.
        </p>
      </Section>

      <Section heading="12. Changes to these terms">
        <p>
          These terms may be updated as the project changes. The date at the top
          of this page shows when it was last revised. Continuing to use the
          service after a change means you accept the revised version.
        </p>
      </Section>
    </LegalPage>
  );
}
