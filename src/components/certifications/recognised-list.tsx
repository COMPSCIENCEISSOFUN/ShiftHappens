/**
 * The organisation's list of recognised certificates, and the panel that edits it.
 *
 */
"use client";

import { useState } from "react";
import { Award, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";

export interface RecognisedCertification {
  id: string;
  name: string;
}

export function RecognisedList({
  types,
  onAdd,
  onRemove,
  canManage,
  busy,
}: {
  types: RecognisedCertification[];
  onAdd: (name: string) => Promise<void>;
  onRemove: (type: RecognisedCertification) => Promise<void>;
  /** `certifications:review` — the same permission that verifies a submission. */
  canManage: boolean;
  busy: boolean;
}) {
  const [draft, setDraft] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    await onAdd(name);
    // Cleared unconditionally. A failed add leaves an error banner above with
    // the reason in it, and leaving the text behind after a duplicate would
    // invite pressing the button again.
    setDraft("");
  }

  return (
    <Panel title="Recognised certificates" icon={Award} count={types.length}>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          The names a shift may require. Members can still record certificates
          that are not on this list.
        </p>
        {types.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing here yet. Until something is added, a shift cannot require a
            certificate at all.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {types.map((type) => (
              <span
                key={type.id}
                className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
              >
                {type.name}
                {canManage && (
                  <button
                    type="button"
                    onClick={() => onRemove(type)}
                    disabled={busy}
                    aria-label={`Remove ${type.name}`}
                    className="text-muted-foreground transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {canManage && (
          <form onSubmit={submit} className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. Food Safety Level 2"
              aria-label="Certificate name"
              className="h-8 text-xs"
            />
            <button
              type="submit"
              disabled={busy || draft.trim().length === 0}
              className={`${PRIMARY_BUTTON} shrink-0 disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          </form>
        )}
      </div>
    </Panel>
  );
}
