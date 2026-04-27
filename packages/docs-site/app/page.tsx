import type { Metadata } from "next";
import { DocPage } from "@/components/doc-page";
import { getDoc } from "@/lib/docs";

export async function generateMetadata(): Promise<Metadata> {
  const doc = await getDoc("");
  return {
    title: doc.title,
    description: doc.description ?? undefined,
  };
}

export default async function Home() {
  const doc = await getDoc("");
  return <DocPage doc={doc} />;
}
