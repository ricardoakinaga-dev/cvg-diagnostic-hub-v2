const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep framework development chrome out of application screenshots and local
  // visual review; it is not part of the product surface.
  devIndicators: false,
  // The Playwright harness starts one disposable dev server per project.
  // Keep their compiler locks and artifacts separate while preserving the
  // normal `.next` directory for local development and production builds.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Next 16 blocks dev assets requested from a LAN origin unless it is
  // explicitly allowlisted. Keep this limited to the local demo host.
  allowedDevOrigins: ["192.168.15.14", "localhost", "127.0.0.1"],
  turbopack: { root: process.cwd() },
  experimental: { proxyClientMaxBodySize: "25mb" },
  transpilePackages: ["@cvg/contracts", "@cvg/domain", "@cvg/ui", "@cvg/services", "@cvg/shared-state"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
