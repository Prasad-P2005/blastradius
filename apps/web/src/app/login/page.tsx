import { Suspense } from "react";
import { Login } from "@/components/auth/Login";

export const metadata = { title: "Log in · Blastradius" };

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
