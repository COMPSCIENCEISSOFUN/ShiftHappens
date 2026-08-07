import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: {
    default: "ShiftHappens — Workforce scheduling and operations",
    template: "%s | ShiftHappens",
  },
  description: "Plan shifts, assign eligible staff, manage compliance, and keep workforce operations in one place.",
  applicationName: "ShiftHappens",
  openGraph: {
    type: "website",
    siteName: "ShiftHappens",
    title: "ShiftHappens — Workforce scheduling and operations",
    description: "Plan shifts, assign eligible staff, and manage workforce operations.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
