import type { Metadata } from "next";
import { cookies } from "next/headers";
import { UserProvider } from "@/components/auth/UserMenu";
import { USER_COOKIE, decodeUser } from "@/lib/demo-user";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blastradius",
  description: "Incident console over one FalkorDB graph per tenant: blast radius, suspect PRs, experts and memory, each claim with a Why? path.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // the demo identity picked on /login (middleware already redirected if it's missing)
  const user = decodeUser((await cookies()).get(USER_COOKIE)?.value);
  return (
    <html lang="en">
      <head>
        {/* Open Sans: the typeface of AWS's open-source Cloudscape design system. Falls back to system-ui offline. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" />
      </head>
      <body className="h-full overflow-hidden bg-bg text-fg antialiased">
        <UserProvider user={user}>{children}</UserProvider>
      </body>
    </html>
  );
}
