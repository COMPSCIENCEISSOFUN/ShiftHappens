/**
 * Theme Provider Component
 *
 * Provides a small local theme context without injecting inline script tags.
 * This keeps theme switching compatible with the current Next.js 16 runtime.
 */
"use client";

import * as React from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  forcedTheme?: Theme;
};

type ThemeProviderProps = React.PropsWithChildren<{
  attribute?: "class" | `data-${string}`;
  defaultTheme?: Theme;
  disableTransitionOnChange?: boolean;
  enableColorScheme?: boolean;
  enableSystem?: boolean;
  forcedTheme?: Theme;
  storageKey?: string;
}>;

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined
);

const THEME_VALUES: ResolvedTheme[] = ["light", "dark"];
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function resolveTheme(theme: Theme, enableSystem: boolean): ResolvedTheme {
  if (theme === "system" && enableSystem && typeof window !== "undefined") {
    return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
  }

  return theme === "dark" ? "dark" : "light";
}

function applyThemeAttribute(
  attribute: ThemeProviderProps["attribute"],
  resolvedTheme: ResolvedTheme,
  enableColorScheme: boolean
) {
  const root = document.documentElement;

  if (attribute === "class") {
    root.classList.remove(...THEME_VALUES);
    root.classList.add(resolvedTheme);
  } else {
    root.setAttribute(attribute ?? "data-theme", resolvedTheme);
  }

  if (enableColorScheme) {
    root.style.colorScheme = resolvedTheme;
  }
}

function temporarilyDisableTransitions() {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{transition:none!important}"
    )
  );
  document.head.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    window.setTimeout(() => {
      document.head.removeChild(style);
    }, 1);
  };
}

export function ThemeProvider({
  attribute = "class",
  children,
  defaultTheme = "system",
  disableTransitionOnChange = false,
  enableColorScheme = true,
  enableSystem = true,
  forcedTheme,
  storageKey = "theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] =
    React.useState<ResolvedTheme>("light");

  React.useEffect(() => {
    try {
      const storedTheme = window.localStorage.getItem(storageKey) as Theme | null;
      if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
        setThemeState(storedTheme);
      }
    } catch {
      // Ignore storage failures and continue with defaults.
    }
  }, [storageKey]);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(MEDIA_QUERY);

    const syncResolvedTheme = () => {
      const activeTheme = forcedTheme ?? theme;
      setResolvedTheme(resolveTheme(activeTheme, enableSystem));
    };

    syncResolvedTheme();
    mediaQuery.addEventListener("change", syncResolvedTheme);

    return () => {
      mediaQuery.removeEventListener("change", syncResolvedTheme);
    };
  }, [enableSystem, forcedTheme, theme]);

  React.useEffect(() => {
    const cleanup = disableTransitionOnChange
      ? temporarilyDisableTransitions()
      : undefined;
    applyThemeAttribute(attribute, resolvedTheme, enableColorScheme);
    cleanup?.();
  }, [
    attribute,
    disableTransitionOnChange,
    enableColorScheme,
    resolvedTheme,
  ]);

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      if (forcedTheme) return;
      setThemeState(nextTheme);
      try {
        window.localStorage.setItem(storageKey, nextTheme);
      } catch {
        // Ignore storage failures and still update in memory.
      }
    },
    [forcedTheme, storageKey]
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme: forcedTheme ?? theme,
      resolvedTheme,
      setTheme,
      forcedTheme,
    }),
    [forcedTheme, resolvedTheme, setTheme, theme]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = React.useContext(ThemeContext);

  return (
    context ?? {
      theme: "system",
      resolvedTheme: "light",
      setTheme: () => undefined,
    }
  );
}
