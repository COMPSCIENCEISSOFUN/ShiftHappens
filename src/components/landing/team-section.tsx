/**
 * Meet the Team section (Boundary Layer).
 *
 * Sits between the testimonials and the contact form on the landing page.
 *
 * ## Editing this
 *
 * Everything you need to change is the `TEAM` array directly below — and
 * `SUPERVISOR`, if your department wants one credited. Nothing further down the
 * file needs touching: the grid adapts to however many people are in the array,
 * and a missing photo falls back to an initials circle on its own.
 *
 * Photos go in `public/team/`, named to match the `photo` path — a square crop,
 * at least 400×400 so it stays sharp on high-density screens.
 */
"use client";

import { Reveal } from "./reveal";
import { useState } from "react";

/**
 * Brand marks as inline SVG.
 *
 * lucide-react dropped its brand icons — `Github` and `Linkedin` are no longer
 * exported by the version this project pins, so importing them fails to
 * compile. Generic link icons would render, but a recognisable mark is the
 * whole point of a social link, so the two paths live here instead. Both are
 * single-path marks and inherit `currentColor`, which is why they theme
 * correctly alongside everything else on the page.
 */
function GithubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.73.5.9 5.33.9 11.6c0 4.9 3.18 9.06 7.6 10.53.55.1.75-.24.75-.53v-2.07c-3.1.67-3.75-1.3-3.75-1.3-.5-1.29-1.23-1.63-1.23-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.7 2.6 1.21 3.24.93.1-.72.39-1.21.7-1.49-2.47-.28-5.07-1.24-5.07-5.5 0-1.22.43-2.21 1.15-2.99-.12-.28-.5-1.41.11-2.94 0 0 .94-.3 3.07 1.14a10.6 10.6 0 0 1 5.6 0c2.12-1.44 3.06-1.14 3.06-1.14.61 1.53.23 2.66.11 2.94.72.78 1.15 1.77 1.15 2.99 0 4.27-2.6 5.21-5.08 5.49.4.35.76 1.03.76 2.08v3.08c0 .3.2.64.76.53a11.11 11.11 0 0 0 7.59-10.53C23.1 5.33 18.27.5 12 .5Z" />
    </svg>
  );
}

function LinkedinMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.55V9h3.57v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0Z" />
    </svg>
  );
}

export interface TeamMember {
  /** Displayed name. */
  name: string;
  /** Role ON THE PROJECT, not a job title — "Backend & Allocation Engine". */
  role: string;
  /** One concrete line on what this person built. Roughly 10–15 words. */
  contribution: string;
  /** Path under public/, e.g. "/team/jane-doe.jpg". Falls back to initials. */
  photo: string;
  github?: string;
  linkedin?: string;
}

// ---------------------------------------------------------------------------
// EDIT HERE — replace every TODO. Order here is the order shown on the page.
// ---------------------------------------------------------------------------

const TEAM: TeamMember[] = [
  {
    name: "Chen Zhijie",
    role: "UI/UX Designer, Frontend Developer, Documentation",
    contribution: "Supported the Web UI for user roles; Responsible for designing Dashboard layouts, Task Management views, Calendar integration, and iCal feed.",
    photo: "/team/zhijie.jpg",
    github: "", // optional — delete the line if unused
    linkedin: "", // optional — delete the line if unused
  },
  {
    name: "Cleon Lim Kang Wue",
    role: "Team Leader, Scrum Master, Product Owner, Documentation, Frontend Developer",
    contribution: "Facilitates Scrum activities (planning, reviews, retrospectives); Maintains product backlog; Defines acceptance criteria; Liaises with supervisors and stakeholders; Ensures team adheres to Scrum processes.",
    photo: "/team/cleon.jpg",
    github: "",
    linkedin: "",
  },
  {
    name: "Darryn Wan Jing Kai",
    role: "Lead Full-Stack Developer, Documentation",
    contribution: "Lead Frontend and Backend development; Oversees code quality, architecture, and integration; Implements core features and ensures system scalability; Supports documentation.",
    photo: "/team/darryn.jpg",
    github: "https://github.com/COMPSCIENCEISSOFUN",
    linkedin: "https://www.linkedin.com/in/darryn-w-2a8746164?utm_source=share_via&utm_content=profile&utm_medium=member_ios",
  },
  {
    name: "Delvinjit Singh",
    role: "Lead QA Tester, Backend Developer, Documentation",
    contribution: "Led quality assurance by designing and executing functional, integration, regression, and end-to-end tests, while supporting defect tracking and project documentation.",
    photo: "/team/delvin.jpg",
    github: "",
    linkedin: "",
  },
  {
    name: "Saumya Rengarajan",
    role: "Frontend Developer, QA Tester, Documentation",
    contribution: "Supported system testing and quality assurance, including test execution, documentation updates, user guidance, and validation of system workflows.",
    photo: "/team/saumya.jpg",
    github: "",
    linkedin: "",
  },
  {
    name: "Steven Lim",
    role: "Documentation Lead, Full-Stack Developer",
    contribution: "Led all project documentation; maintained requirements, user stories, diagrams, use cases and technical design; coordinated documentation revisions with implementation changes while contributing to full-stack development, testing and debugging.",
    photo: "/team/steven.jpg",
    github: "https://github.com/nvliteesm",
    linkedin: "https://www.linkedin.com/in/steven-lim-/",
  },
];

/**
 * Set to a TeamMember to credit a project supervisor in a separate row below
 * the team. Leave as null to omit the row entirely.
 */
const SUPERVISOR: TeamMember | null = null;

const COURSE_LINE = "FYP-26-S2-22 · University of Wollongong · 2026";

// ---------------------------------------------------------------------------
// Nothing below here needs editing.
// ---------------------------------------------------------------------------

/**
 * Column count by team size.
 *
 * Six people land on the three-across branch, which fills two clean rows.
 * Four is special-cased to a 2×2 instead: a row of four shrinks each card to
 * the point the photo stops carrying any weight, and three-across with a single
 * orphan underneath looks like a mistake rather than a layout.
 */
function gridClassFor(count: number): string {
  if (count <= 2) return "sm:grid-cols-2 sm:max-w-2xl";
  if (count === 4) return "sm:grid-cols-2 sm:max-w-3xl";
  return "sm:grid-cols-2 lg:grid-cols-3 sm:max-w-5xl";
}

/** First letter of the first and last word — "Jane Doe" → "JD". */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function Avatar({ member }: { member: TeamMember }) {
  const [failed, setFailed] = useState(false);
  const showInitials = failed || !member.photo;

  if (showInitials) {
    return (
      <div
        aria-hidden="true"
        className="h-28 w-28 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-2xl font-bold text-white shadow-lg ring-4 ring-slate-800"
      >
        {initialsOf(member.name)}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- see file header
    <img
      src={member.photo}
      alt={member.name}
      width={112}
      height={112}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-28 w-28 shrink-0 rounded-full object-cover shadow-lg ring-4 ring-slate-800"
    />
  );
}

function SocialLinks({ member }: { member: TeamMember }) {
  const links = [
    { href: member.github, Icon: GithubMark, label: "GitHub" },
    { href: member.linkedin, Icon: LinkedinMark, label: "LinkedIn" },
  ].filter((l) => l.href);

  if (links.length === 0) return null;

  return (
    <div className="mt-4 flex items-center justify-center gap-3">
      {links.map(({ href, Icon, label }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${member.name} on ${label}`}
          className="text-slate-500 hover:text-indigo-400 transition-colors"
        >
          <Icon className="h-5 w-5" />
        </a>
      ))}
    </div>
  );
}

function MemberCard({ member }: { member: TeamMember }) {
  return (
    <div className="h-full rounded-2xl border border-slate-700/60 bg-slate-800/40 p-8 text-center transition-all duration-300 hover:border-indigo-500/50 hover:bg-slate-800/70">
      <div className="flex justify-center">
        <Avatar member={member} />
      </div>

      <h3 className="mt-5 text-lg font-semibold text-white">{member.name}</h3>
      <p className="mt-1 text-sm font-medium text-indigo-400">{member.role}</p>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        {member.contribution}
      </p>

      <SocialLinks member={member} />
    </div>
  );
}

export default function TeamSection() {
  return (
    <section id="team" className="py-20 sm:py-24 bg-slate-900">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-16">
            <p className="text-sm font-medium text-indigo-400 mb-2">The team</p>
            <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
              Meet the people behind it
            </h2>
            <p className="mt-4 text-slate-400">
              ShiftHappens was built as a final-year project by a team
              of Computer Science students.
            </p>
            <p className="mt-3 text-sm text-slate-500">{COURSE_LINE}</p>
          </div>
        </Reveal>

        {/*
          A list, not a stack of divs — it is a list of people, and that is what
          a screen reader should announce.

          Below `sm` this is a horizontal swipe strip; from `sm` up it is the
          grid. Phones are where six tall cards become a tiring scroll, so the
          strip earns its place there — but on the wider screen a supervisor or
          marker will actually use, every card stays visible. Nothing is ever
          hidden behind an interaction on desktop.

          The negative margin plus matching padding lets the strip bleed to the
          screen edges while the cards stay aligned with the rest of the page,
          and `w-[78%]` leaves the next card peeking so it is obvious there is
          more to swipe to.

          `tabIndex` makes the strip reachable by keyboard. A scrollable region
          with no focusable child is unreachable without a mouse, and a card
          whose owner supplied no links has nothing focusable in it.
        */}
        <ul
          tabIndex={0}
          aria-label="Project team members"
          className={`flex gap-6 overflow-x-auto snap-x snap-mandatory -mx-6 px-6 pb-4 sm:grid sm:grid-cols-1 sm:overflow-visible sm:mx-auto sm:px-0 sm:pb-0 ${gridClassFor(TEAM.length)}`}
        >
          {TEAM.map((member, i) => (
            <li
              key={`${member.name}-${i}`}
              className="w-[78%] shrink-0 snap-center sm:w-auto sm:shrink h-full"
            >
              {/* Staggered so the cards arrive in sequence rather than as one
                  block, matching the other sections on this page. */}
              <Reveal delay={i * 100} className="h-full">
                <MemberCard member={member} />
              </Reveal>
            </li>
          ))}
        </ul>

        {SUPERVISOR && (
          <Reveal delay={TEAM.length * 100}>
            <div className="mt-12 pt-12 border-t border-slate-800">
              <p className="text-center text-sm font-medium text-slate-500 mb-6">
                Project Supervisor
              </p>
              <div className="mx-auto max-w-sm">
                <MemberCard member={SUPERVISOR} />
              </div>
            </div>
          </Reveal>
        )}
      </div>
    </section>
  );
}
