import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Smart Task Allocation",
  description: "AI-powered workforce management platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
          {/*
            Transient confirmations, for the whole application.

            `sonner` and this themed wrapper have been in the repository since
            the shadcn install and were never mounted — so `toast()` would have
            done nothing anywhere, silently, and every page grew its own
            `success` state and its own banner instead. Eight of them did.

            Mounted at the ROOT rather than in the signed-in chrome, because
            the auth pages and the platform console need it too and there is no
            second place for it to live: two Toasters render two stacks, and
            the second one to mount wins arguments about position.

            One line, and it retires ~40 lines of state across eight files.
          */}
          {/*
            Top-right, not bottom-right.

            The assistant's launcher takes the bottom-right corner, and a
            confirmation that pops out from behind a floating button is a
            confirmation people miss. Top-right is also where the eye already
            is after pressing a button in a page header, which is where most of
            these actions start.
          */}
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}