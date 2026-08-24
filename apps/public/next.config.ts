import type { NextConfig } from 'next'

// Cloudflare Pages (ADR-0002): static asset requests are free and unlimited,
// and this tool sits on acquisition traffic we cannot forecast.
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
