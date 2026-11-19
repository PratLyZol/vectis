import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Hide the dev-only route indicator; compile and runtime errors still show.
  devIndicators: false,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "assets.gemini.com", pathname: "/**" }],
  },
};

export default nextConfig;
