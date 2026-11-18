import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "assets.gemini.com", pathname: "/**" }],
  },
};

export default nextConfig;
