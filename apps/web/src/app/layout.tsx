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
    <html lang="en" className="dark">
      <body className="h-full overflow-hidden bg-bg text-fg antialiased">
        <UserProvider user={user}>{children}</UserProvider>
      </body>
    </html>
  );
}
