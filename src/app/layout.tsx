import type { Metadata, Viewport } from "next";
import "./globals.css";

import { NotificationPanelWrapper } from "@/features/notifications/NotificationPanelWrapper";

export const metadata: Metadata = {
  title: "New Hope Work Desk",
  description: "Internal sales rotation, backup service, workload, and performance desk.",
  applicationName: "New Hope Work Desk",
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#223f7a",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <NotificationPanelWrapper />
        {children}
      </body>
    </html>
  );
}
