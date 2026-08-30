/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cloud Run / Docker: emit a self-contained server (.next/standalone) with
  // only the traced node_modules, so the runtime image stays small and needs
  // no `npm install`. This is the deploy target - the root Dockerfile builds
  // this output into the Cloud Run web image.
  output: "standalone",

  // W9: security headers. Nothing in the stack set ANY of these - no CDN or
  // LB in front of Cloud Run adds them, so the app itself is the only place
  // they can come from.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Two years, subdomains, preload-eligible. Cloud Run terminates TLS
          // for us; this stops a first visit over http from ever sticking.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nothing frames this app - not the admin panel, not the funnel.
          { key: "X-Frame-Options", value: "DENY" },
          // geolocation: the search page's "near me". microphone/camera: never
          // used (photos arrive as file uploads, which this does not gate).
          {
            key: "Permissions-Policy",
            value: "geolocation=(self), camera=(), microphone=(), payment=()",
          },
          // REPORT-ONLY on purpose, enforcement deferred with the reason on
          // record: script-src must admit Google Sign-In, AdSense and the
          // PayPal JS flows, and an enforced policy that guessed wrong would
          // break login for every traveller at once. frame-ancestors 'none'
          // mirrors the X-Frame-Options above (that one IS enforced). Watch
          // the console/reporting, tighten, then promote to enforcing.
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://pagead2.googlesyndication.com https://www.paypal.com",
              "style-src 'self' 'unsafe-inline' https://accounts.google.com",
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https://accounts.google.com https://pagead2.googlesyndication.com https://www.paypal.com https://api.paypal.com",
              "frame-src https://accounts.google.com https://googleads.g.doubleclick.net https://www.paypal.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
