import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "New Hope Work Desk",
    short_name: "Work Desk",
    description: "New Hope Insurance internal sales operations desk.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#115c43",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
