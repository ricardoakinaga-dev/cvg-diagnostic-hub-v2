const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 blocks dev assets requested from a LAN origin unless it is
  // explicitly allowlisted. Keep this limited to the local demo host.
  allowedDevOrigins: ["192.168.15.14"],
  turbopack: { root: process.cwd() },
  transpilePackages: ["@cvg/contracts", "@cvg/domain", "@cvg/ui", "@cvg/services", "@cvg/shared-state"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
