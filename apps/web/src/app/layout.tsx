import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blastradius",
  description: "Incident console over one FalkorDB graph per tenant: blast radius, suspect PRs, experts and memory, each claim with a Why? path.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="h-full overflow-hidden bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
