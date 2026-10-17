import { Suspense } from "react";
import { Builder } from "@/components/build/Builder";

export const metadata = { title: "Graph builder · Blastradius" };

export default function BuildPage() {
  return (
    <Suspense>
      <Builder />
    </Suspense>
  );
}
