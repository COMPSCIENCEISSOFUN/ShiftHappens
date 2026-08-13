/**
 * Profile settings (Boundary Layer).
 *
 * A COMPONENT rather than a page, because the same screen is reached from two
 * addresses and the difference between them is chrome, not content:
 *
 *   /org/[orgId]/profile  — from inside an organisation, wearing its sidebar
 *   /settings/profile     — for somebody who has no organisation yet
 *
 * The data is the person's own and is org-agnostic either way; `GET /api/profile`
 * takes no org id and never has. What the org-scoped address buys is the
 * sidebar: opening your profile from inside an organisation used to drop you
 * onto chrome that had to guess which organisation you meant, and for anyone in
 * two it guessed wrong or gave up. The menu you arrived with is the menu you
 * keep.
 *
 * Original notes follow.
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
import { BookOpen, Building2, Calendar, CircleAlert, CircleCheck, Eye, EyeOff, Info, Lock, Sparkles, User, Users } from "lucide-react";
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
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import { apiErrorMessage } from "@/lib/api-error";

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
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page component                                                */
/* ------------------------------------------------------------------ */

export default function ProfileSettings() {
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
        setNameMessage({ type: "error", text: apiErrorMessage(result, "Update failed") });
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
          text: apiErrorMessage(result, "Update failed"),
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
  const joinedDate = new Date(profile.createdAt).toLocaleDateString([], {
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
                  <User className="h-3 w-3" aria-hidden="true" />
                  {getSystemRoleLabel(
                    primaryMembership.role,
                    primaryMembership.employmentType
                  )}
                </span>
              )}

              {primaryMembership && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm">
                  <BookOpen className="h-3 w-3" aria-hidden="true" />
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
                {profile.emailVerified ? (
                    <CircleCheck className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <CircleAlert className="h-3 w-3" aria-hidden="true" />
                  )}
                {profile.emailVerified ? "Verified" : "Unverified"}
              </span>

              <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium backdrop-blur-sm">
                <Calendar className="h-3 w-3" aria-hidden="true" />
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
                  <Users className="h-[18px] w-[18px] text-indigo-600" aria-hidden="true" />
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
                className={PRIMARY_BUTTON}
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
                  <Lock className="h-[18px] w-[18px] text-amber-600" aria-hidden="true" />
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
                className={PRIMARY_BUTTON}
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
                <Building2 className="h-[18px] w-[18px] text-violet-600" aria-hidden="true" />
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
                          <span className="ml-1.5 inline-flex items-center gap-1 text-purple-600 dark:text-purple-400">
                            {/* The custom-role motif, same as the members page. */}
                            <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
                            {m.customRole.displayLabel}
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
                      {new Date(m.joinedAt).toLocaleDateString([], {
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
              <Info className="h-[18px] w-[18px] text-slate-600 dark:text-slate-400" aria-hidden="true" />
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
                    <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    Verified on{" "}
                    {new Date(profile.emailVerified).toLocaleDateString(
                      [],
                      {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      }
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
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
