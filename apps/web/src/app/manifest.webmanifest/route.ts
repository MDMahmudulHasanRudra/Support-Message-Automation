import { connection, NextResponse } from "next/server";
import { getBranding } from "@/server/branding";

/** What a phone needs to install the app. Per request, because the name and icon are the installation's own (BRANDING.md). */
export async function GET() {
  await connection();
  const brand = await getBranding();
  const icons = brand.hasCustomIcon
    ? [{ src: brand.iconUrl, sizes: "any", purpose: "any" }]
    : [
        { src: "/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ];
  return NextResponse.json(
    {
      id: "/open",
      name: brand.productName,
      short_name: brand.productName,
      description: "Customer support inbox",
      start_url: "/open",
      scope: "/",
      display: "standalone",
      background_color: "#083138",
      theme_color: "#083138",
      icons,
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } },
  );
}
