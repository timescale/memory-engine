import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { Footer } from "@/components/footer";
import { MobileNav } from "@/components/mobile-nav";
import { Navbar } from "@/components/navbar";
import { SidebarNav } from "@/components/sidebar-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Memory Engine Docs",
    template: "%s -- Memory Engine",
  },
  description:
    "Permanent memory for AI agents. Store, search, and organize knowledge across conversations.",
  metadataBase: new URL("https://docs.memory.build"),
  openGraph: {
    siteName: "Memory Engine",
    type: "website",
    url: "https://docs.memory.build",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable}`}
    >
      <body className="bg-black text-white font-sans antialiased min-h-screen flex flex-col">
        <Navbar />
        <div className="flex-1 w-full">
          <div className="mx-auto max-w-[1440px] px-4 md:px-6 lg:px-8">
            <div className="flex gap-8 lg:gap-12">
              {/* Left rail (desktop) */}
              <aside className="hidden lg:block w-[260px] shrink-0">
                <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-8 pr-2">
                  <SidebarNav />
                </div>
              </aside>

              {/* Mobile drawer toggle */}
              <MobileNav />

              {/* Page content + right TOC composed inside [...slug]/page.tsx */}
              <main className="min-w-0 flex-1 py-8 md:py-10">{children}</main>
            </div>
          </div>
        </div>
        <Footer />
      </body>
    </html>
  );
}
