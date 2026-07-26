/**
 * Switch Component
 *
 * A toggle switch for boolean settings. Built as a styled checkbox
 * since @radix-ui/react-switch is not installed.
 *
 * Usage:
 *   <Switch checked={value} onCheckedChange={setValue} />
 *   <Switch checked={value} onCheckedChange={setValue} disabled />
 */
"use client";

import { forwardRef, useId } from "react";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled = false, id, className = "" }, ref) => {
    const autoId = useId();
    const switchId = id || autoId;

    return (
      <button
        ref={ref}
        id={switchId}
        role="switch"
        type="button"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={`
          relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center
          rounded-full border-2 border-transparent transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
          focus-visible:ring-offset-2 focus-visible:ring-offset-background
          disabled:cursor-not-allowed disabled:opacity-50
          ${checked ? "bg-primary" : "bg-input"}
          ${className}
        `}
      >
        <span
          className={`
            pointer-events-none block h-5 w-5 rounded-full bg-background
            shadow-lg ring-0 transition-transform
            ${checked ? "translate-x-5" : "translate-x-0"}
          `}
        />
      </button>
    );
  }
);

Switch.displayName = "Switch";

export { Switch };
