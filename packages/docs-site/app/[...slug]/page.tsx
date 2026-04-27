import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocPage } from "@/components/doc-page";
import { type Doc, getDoc, listDocSlugs } from "@/lib/docs";

export const dynamic = "error";
export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  const slugs = await listDocSlugs();
  return slugs
    .filter((slug) => slug !== "")
    .map((slug) => ({ slug: slug.split("/") }));
}

async function tryGetDoc(slug: string): Promise<Doc | null> {
  try {
    return await getDoc(slug);
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = await tryGetDoc(slug.join("/"));
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description ?? undefined,
  };
}

export default async function DocSlugPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const doc = await tryGetDoc(slug.join("/"));
  if (!doc) notFound();
  return <DocPage doc={doc} />;
}
