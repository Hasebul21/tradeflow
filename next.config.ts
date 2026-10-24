import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["tradeflow.orca.localhost"],
  devIndicators: false,
  experimental: {
    serverActions: { allowedOrigins: ["tradeflow.orca.localhost", "tradeflow.orca.*"] },
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
