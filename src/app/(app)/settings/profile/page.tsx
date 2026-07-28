/**
 * Profile Settings Page (Boundary Layer)
 *
 * Redesigned profile page with:
 * - Profile hero banner (avatar, name, email, contextual tags)
 * - Two-column layout: Personal Info + Password (separate save buttons)
 * - Password UX: show/hide toggle, strength meter
 * - Organisation Memberships card (dynamic from API)
 * - Account Details card (metadata)
 *
 * All data is fetched from GET /api/profile which returns the user
 * profile with org memberships via ProfileService.getFullProfile().
 */
"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";
import { PageLoading } from "@/components/ui/page-loading";
import { getSystemRoleLabel } from "@/lib/role-config";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ProfileMembership {
  id: string;
  role: string;
  status: string;
  employmentType: string | null;
  joinedAt: string;
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  customRole: {
    id: string;
    name: string;
    displayLabel: string;
  } | null;
}

interface FullProfile {
  id: string;
  name: string | null;
  email: string;
  emailVerified: string | null;
  image: string | null;
  createdAt: string;
  memberships: ProfileMembership[];
}

/* ------------------------------------------------------------------ */
/*  Password strength helper                                           */
/* ------------------------------------------------------------------ */

interface PasswordStrength {
  score: number; // 0-4
  label: string;
  color: string;
}

function evaluatePasswordStrength(password: string): PasswordStrength {
  if (!password) return { score: 0, label: "", color: "" };

  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const levels: PasswordStrength[] = [
    { score: 0, label: "", color: "" },
    { score: 1, label: "Weak", color: "bg-red-500" },
    { score: 2, label: "Fair", color: "bg-orange-500" },
    { score: 3, label: "Good", color: "bg-amber-500" },
    { score: 4, label: "Strong", color: "bg-green-500" },
  ];

  return levels[score];
}

/* ------------------------------------------------------------------ */
/*  Password input with show/hide toggle                               */
/* ------------------------------------------------------------------ */

function PasswordInput({
  id,
  name,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        aria-label={visible ? "Hide password" : "Show password"}
        tabIndex={-1}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page component                                                */
/* ------------------------------------------------------------------ */

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<FullProfile | null>(null);

  // ── Personal info form state ──
  const [name, setName] = useState("");
  const [nameMessage, setNameMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [nameLoading, setNameLoading] = useState(false);

  // ── Password form state ──
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const passwordStrength = useMemo(
    () => evaluatePasswordStrength(newPassword),
    [newPassword]
  );

  // ── Fetch profile ──
  useEffect(() => {
    fetch("/api/profile")
      .then((res) => res.json())
      .then((data: FullProfile) => {
        setProfile(data);
        setName(data.name || "");
      });
  }, []);

  // ── Save personal info ──
  async function onSaveName(e: React.FormEvent) {
    e.preventDefault();
    setNameMessage(null);
    setNameLoading(true);

    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await res.json();

      if (!res.ok) {
        setNameMessage({ type: "error", text: result.error || "Update failed" });
        return;
      }

      setProfile((prev) => (prev ? { ...prev, name: result.name } : prev));
      setNameMessage({ type: "success", text: "Name updated successfully" });
      router.refresh();
    } catch {
      setNameMessage({ type: "error", text: "Something went wrong" });
    } finally {
      setNameLoading(false);
    }
  }

  // ── Save password ──
  async function onSavePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordMessage(null);

    if (!currentPassword) {
      setPasswordMessage({
        type: "error",
        text: "Current password is required",
      });
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordMessage({ type: "error", text: "New passwords do not match" });
      return;
    }

    setPasswordLoading(true);

    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmNewPassword,
        }),
      });
      const result = await res.json();

      if (!res.ok) {
        setPasswordMessage({
          type: "error",
          text: result.error || "Update failed",
        });
        return;
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordMessage({
        type: "success",
        text: "Password changed successfully",
      });
    } catch {
      setPasswordMessage({ type: "error", text: "Something went wrong" });
    } finally {
      setPasswordLoading(false);
    }
  }

  if (!profile) return <PageLoading label="Loading profile..." />;

  // Saving an unchanged name is a no-op; the button reflects that.
  const nameChanged = name.trim() !== (profile.name ?? "").trim();
  const nameValid = name.trim().length > 0;

  // ── Derived display values ──
  const initials = profile.name
    ? profile.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : profile.email[0].toUpperCase();

  const primaryMembership = profile.memberships[0] ?? null;
  const joinedDate = new Date(profile.createdAt).toLocaleDateString("en-AU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="space-y-6">
      {/* ─── Hero Banner ─────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-8 text-white">
        {/* Dot-grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
          aria-hidden="true"
        />

        <div className="relative z-[1] flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          {/* Avatar */}
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-white/20 text-2xl font-bold backdrop-blur-sm ring-2 ring-white/30">
            {initials}
          </div>

          <div className="flex-1 text-center sm:text-left">
            <h1 className="text-2xl font-bold">
              {profile.name || "Unnamed User"}
            </h1>
            <p className="mt-0.5 text-sm text-white/70">{profile.email}</p>

            {/* Tags row */}
            <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
              {primaryMembership && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                  </svg>
                  {getSystemRoleLabel(
                    primaryMembership.role,
                    primaryMembership.employmentType
                  )}
                </span>
              )}

              {primaryMembership && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                  {primaryMembership.organization.name}
                </span>
              )}

              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm ${
                  profile.emailVerified
                    ? "bg-green-400/20 text-green-100"
                    : "bg-amber-400/20 text-amber-100"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                  {profile.emailVerified ? (
                    <>
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </>
                  ) : (
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </>
                  )}
                </svg>
                {profile.emailVerified ? "Verified" : "Unverified"}
              </span>

              <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                Joined {joinedDate}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Two-column: Personal Info + Password ────────────── */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Personal Information */}
        <form onSubmit={onSaveName} className="h-full">
          <Card className="h-full">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/30">
                  <svg
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    className="text-indigo-600"
                  >
                      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
                <div>
                  <CardTitle>Personal Information</CardTitle>
                  <CardDescription>Update your display name</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              {nameMessage && (
                <AlertBanner
                  message={nameMessage.text}
                  variant={nameMessage.type === "success" ? "success" : "error"}
                  onDismiss={() => setNameMessage(null)}
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={profile.email} disabled />
                <p className="text-xs text-muted-foreground">
                  Email cannot be changed
                </p>
              </div>
            </CardContent>
            <CardFooter>
              <button
                type="submit"
                // Nothing to save while the field still holds the stored value —
                // an enabled button that does nothing reads as a broken save.
                disabled={nameLoading || !nameChanged || !nameValid}
                title={
                  !nameValid
                    ? "Name cannot be empty"
                    : !nameChanged
                      ? "No changes to save"
                      : undefined
                }
                className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-default disabled:opacity-45"
              >
                {nameLoading ? "Saving..." : "Save name"}
              </button>
            </CardFooter>
          </Card>
        </form>

        {/* Password */}
        <form onSubmit={onSavePassword} className="h-full">
          <Card className="h-full">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/30">
                  <svg
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    className="text-amber-600"
                  >
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <div>
                  <CardTitle>Change Password</CardTitle>
                  <CardDescription>Update your password</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {passwordMessage && (
                <AlertBanner
                  message={passwordMessage.text}
                  variant={
                    passwordMessage.type === "success" ? "success" : "error"
                  }
                  onDismiss={() => setPasswordMessage(null)}
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current Password</Label>
                <PasswordInput
                  id="currentPassword"
                  name="currentPassword"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <PasswordInput
                  id="newPassword"
                  name="newPassword"
                  value={newPassword}
                  onChange={setNewPassword}
                />
                {/* Strength meter */}
                {newPassword && (
                  <div className="space-y-1">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((level) => (
                        <div
                          key={level}
                          className={`h-1 flex-1 rounded-full transition-colors ${
                            passwordStrength.score >= level
                              ? passwordStrength.color
                              : "bg-muted"
                          }`}
                        />
                      ))}
                    </div>
                    <p
                      className={`text-xs ${
                        passwordStrength.score <= 1
                          ? "text-red-500"
                          : passwordStrength.score === 2
                            ? "text-orange-500"
                            : passwordStrength.score === 3
                              ? "text-amber-500"
                              : "text-green-500"
                      }`}
                    >
                      {passwordStrength.label}
                    </p>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmNewPassword">Confirm New Password</Label>
                <PasswordInput
                  id="confirmNewPassword"
                  name="confirmNewPassword"
                  value={confirmNewPassword}
                  onChange={setConfirmNewPassword}
                />
                {confirmNewPassword && newPassword !== confirmNewPassword && (
                  <p className="text-xs text-red-500">
                    Passwords do not match
                  </p>
                )}
              </div>
            </CardContent>
            <CardFooter>
              <button
                type="submit"
                // Also requires the confirm field — without it the form could be
                // submitted only to fail the "passwords do not match" rule.
                disabled={
                  passwordLoading ||
                  !currentPassword ||
                  !newPassword ||
                  !confirmNewPassword
                }
                title={
                  !currentPassword || !newPassword || !confirmNewPassword
                    ? "Fill in all three password fields"
                    : undefined
                }
                className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-default disabled:opacity-45"
              >
                {passwordLoading ? "Changing..." : "Change password"}
              </button>
            </CardFooter>
          </Card>
        </form>
      </div>

      {/* ─── Organisation Memberships ────────────────────────── */}
      {profile.memberships.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/30">
                <svg
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  className="text-violet-600"
                >
                  <path d="M3 21h18" />
                  <path d="M5 21V7l7-4 7 4v14" />
                  <path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" />
                </svg>
              </div>
              <div>
                <CardTitle>Organisation Memberships</CardTitle>
                <CardDescription>
                  {profile.memberships.length === 1
                    ? "The organisation you belong to"
                    : "Organisations you belong to"}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border rounded-lg border">
              {profile.memberships.map((m) => (
                <div
                  key={m.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-3">
                    {/* Org avatar */}
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-xs font-bold text-white">
                      {m.organization.name[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium">
                        {m.organization.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {getSystemRoleLabel(m.role, m.employmentType)}
                        {m.customRole && (
                          <span className="ml-1.5 inline-flex items-center gap-0.5 text-purple-600 dark:text-purple-400">
                            <span>✦</span> {m.customRole.displayLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pl-12 sm:pl-0">
                    <StatusBadge
                      value={m.status}
                      palette="membershipStatus"
                    />
                    <span className="text-xs text-muted-foreground">
                      Joined{" "}
                      {new Date(m.joinedAt).toLocaleDateString("en-AU", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Account Details ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800/50">
              <svg
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                className="text-slate-600 dark:text-slate-400"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </div>
            <div>
              <CardTitle>Account Details</CardTitle>
              <CardDescription>
                Technical details about your account
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="text-xs font-medium text-muted-foreground">
                Account ID
              </dt>
              <dd className="font-mono text-xs">{profile.id}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs font-medium text-muted-foreground">
                Email Status
              </dt>
              <dd className="text-sm">
                {profile.emailVerified ? (
                  <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    Verified on{" "}
                    {new Date(profile.emailVerified).toLocaleDateString(
                      "en-AU",
                      {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      }
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    Not verified
                  </span>
                )}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs font-medium text-muted-foreground">
                Account Created
              </dt>
              <dd className="text-sm">{joinedDate}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs font-medium text-muted-foreground">
                Active Memberships
              </dt>
              <dd className="text-sm">
                {profile.memberships.filter((m) => m.status === "active").length}{" "}
                organisation
                {profile.memberships.filter((m) => m.status === "active")
                  .length !== 1
                  ? "s"
                  : ""}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
