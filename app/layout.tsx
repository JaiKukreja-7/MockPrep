import type { Metadata } from "next";
import { archivo, switzer } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "MockPrep",
  description: "AI mock interviews that get you ready for the real thing.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${switzer.variable} h-full`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
