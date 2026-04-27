import type { Doc } from "@/lib/docs";
import { PageToc } from "./page-toc";
import { PrevNext } from "./prev-next";

export function DocPage({ doc }: { doc: Doc }) {
  return (
    <div className="flex gap-12 xl:gap-16">
      <article className="min-w-0 flex-1 max-w-[820px]">
        <div
          className="prose"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted content from local markdown source
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
        <PrevNext slug={doc.slug} />
      </article>
      <aside className="hidden xl:block w-[220px] shrink-0">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-8">
          <PageToc toc={doc.toc} />
        </div>
      </aside>
    </div>
  );
}
