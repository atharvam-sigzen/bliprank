import type { NextConfig } from 'next'

// Vercel (ADR-0002 Amendment 1, 2026-09-10): eight route handlers need a Node
// function host. Each route file carries its own `maxDuration`, which is where
// Vercel's docs put it for the App Router; `vercel.json` pins the framework.
const config: NextConfig = {
  transpilePackages: ['@bliprank/stats'],
  reactStrictMode: true,
  // No floating dev badge over the UI during a demo. The overlay that reports
  // real errors is unaffected — this only hides the idle indicator.
  devIndicators: false,
  // The workspace packages are TypeScript source using NodeNext-style '.js'
  // specifiers. Webpack resolves those literally and finds nothing, so map them
  // back to the real extensions rather than rewriting every import.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }
    return config
  },
}

export default config
