import type { Metadata } from "next";

import { Bullets, LegalPage, Section } from "@/components/legal/legal-page";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy | ShiftHappens",
  description:
    "What personal data ShiftHappens collects, who it reaches, and the rights you have over it.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="14 August 2026"
      intro="This page describes the personal data ShiftHappens holds, the third parties it reaches, and what you can ask us to do with it. It is written against what the system actually does rather than as a general template."
    >
      <Section heading="1. Who handles your data">
        <p>
          Your employer decides what goes into ShiftHappens about you and who in
          your organisation can see it. ShiftHappens stores and processes that
          data on their behalf. If you want something changed or removed, your
          organisation's admin is usually the fastest route, and you can also
          write to us at the address at the foot of this page.
        </p>
      </Section>

      <Section heading="2. What is collected">
        <Bullets
          items={[
            "Account details. Your name, email address, an optional profile image, and your password stored only as a bcrypt hash. We never hold the password itself.",
            "Membership details. Your role in an organisation, your employment type, the departments you belong to, and your seniority level.",
            "Scheduling data. Your weekly availability, leave and date-specific overrides including any reason you write on them, the shifts you are assigned, the times you clock in and out, and the reason you select when you decline a shift.",
            "Certifications. The name of a qualification, its issue and expiry dates, its review status, and a link to a supporting document if you provide one. The document itself is not uploaded to or stored by ShiftHappens, only the address you give.",
            "Activity records. An audit log of significant actions such as assignments, approvals, role changes and verifications, recording who acted, on what, and when. Also the notifications sent to you.",
            "Things you write. Feedback about a shift, questions submitted to your organisation, and reviews of the product.",
            "Billing details. Your organisation's plan, renewal date, and the customer and subscription identifiers issued by Stripe. Card numbers are handled by Stripe and never reach us.",
          ]}
        />
      </Section>

      <Section heading="3. Why it is used">
        <p>
          To run the features you are using: signing you in, building and
          publishing rosters, checking a person is eligible for a shift under
          your organisation's work rules, warning about expiring certifications,
          sending notifications, producing reports, and taking payment for paid
          plans. The audit log exists so an organisation can answer who changed
          something and when.
        </p>
      </Section>

      <Section heading="4. Who can see it inside your organisation">
        <p>
          Access is decided by the permissions your admin grants, and every
          database query is scoped to a single organisation, so members of one
          organisation cannot see another's data. Managers restricted to
          particular departments see only members of those departments.
          Company Admins see everything within their own organisation.
        </p>
      </Section>

      <Section heading="5. Third parties that receive data">
        <Bullets
          items={[
            "Google, for email delivery. Verification, password reset and invitation emails are sent through Gmail's SMTP service, so recipient addresses and message contents pass through Google.",
            "Resend, an alternative email provider. It is only used when Gmail credentials are not configured, and it receives the same information when it is.",
            "Stripe, for payments. It receives your billing details directly through its own hosted checkout.",
            "Groq, which runs the GPT-OSS-20B model used for scheduling assistance and the in-app assistant.",
            "Google, which runs the Gemini model used as a fallback when Groq is unavailable.",
            "Vercel, which hosts and serves the application.",
            "Supabase, which hosts the PostgreSQL database in the deployed environment.",
          ]}
        />
        <p>
          Nothing is sold, and nothing is shared for advertising. There is no
          advertising or analytics tracking in the product.
        </p>
      </Section>

      <Section heading="6. What reaches the AI providers">
        <p>
          This deserves stating precisely, because it is the part people are
          most often not told.
        </p>
        <Bullets
          items={[
            "When a draft roster is generated, the model receives staff names, and for anyone with no name recorded, their email address instead. It also receives department names, certification names, declared availability, hours already worked in the period, and the organisation's work rules.",
            "When you use the in-app assistant, the model receives the text you type.",
            "It does not receive passwords, payment details, audit history, or contact details other than the email fallback noted above.",
          ]}
        />
        <p>
          The model holds no credentials and cannot query the database. For the
          assistant it returns one identifier from a fixed list, and every fact
          in the answer is then fetched by services that check your permissions
          independently. A model cannot widen what you are allowed to see.
        </p>
      </Section>

      <Section heading="7. How long it is kept">
        <p>
          Account and scheduling data is kept while your membership exists.
          Deleting an organisation removes its records, and the related rows are
          removed with it. Audit entries are retained for as long as the
          organisation exists, because their purpose is accountability and an
          audit trail that can be edited is not one.
        </p>
      </Section>

      <Section heading="8. How it is protected">
        <Bullets
          items={[
            "Passwords are hashed with bcrypt and never stored or logged in readable form.",
            "Sessions use a signed token in an HTTP-only cookie.",
            "Every query is scoped to one organisation, which is enforced in the data layer rather than left to individual screens.",
            "Access to each feature is checked twice on entry, against the permission your admin granted and against your organisation's plan.",
          ]}
        />
        <p>
          No system is completely secure, and this one is a student project
          rather than an audited commercial platform. Please do not put data into
          it that you could not tolerate being exposed.
        </p>
      </Section>

      <Section heading="9. Your rights">
        <p>
          Under Singapore's Personal Data Protection Act you may ask for a copy
          of the personal data held about you, ask for it to be corrected, and
          withdraw consent for its use. Withdrawing consent will usually mean
          your account can no longer be used, since the data described here is
          what makes the features work.
        </p>
        <p>
          Ask your organisation's admin, or write to{" "}
          <a
            className="font-medium text-indigo-600 hover:text-indigo-500"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section heading="10. Cookies">
        <p>
          One cookie is used, and it holds your sign-in session. It is necessary
          for the application to work and is removed when you sign out. There are
          no advertising, tracking or analytics cookies.
        </p>
      </Section>

      <Section heading="11. Changes to this policy">
        <p>
          This policy will be updated as the system changes. The date at the top
          of the page shows when it was last revised.
        </p>
      </Section>
    </LegalPage>
  );
}
