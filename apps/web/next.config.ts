import type { NextConfig } from "next";

export function resolveApiInternalUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredUrl = environment.API_INTERNAL_URL?.trim();
  if (!configuredUrl && environment.NODE_ENV === "production") {
    throw new Error("API_INTERNAL_URL is required in production");
  }

  const value = configuredUrl || "http://localhost:4000";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("API_INTERNAL_URL must be a valid HTTP or HTTPS URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("API_INTERNAL_URL must be a valid HTTP or HTTPS origin without credentials, path, query, or fragment");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (environment.NODE_ENV === "production" && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(hostname))) {
    throw new Error("API_INTERNAL_URL must not use a loopback host in production");
  }

  return parsed.origin;
}

const apiOrigin = resolveApiInternalUrl();
const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiOrigin}/api/v1/:path*` }];
  }
};

export default nextConfig;
