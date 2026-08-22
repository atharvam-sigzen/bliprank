import type { NextConfig } from 'next'

const config: NextConfig = {
  // The workspace packages are TypeScript source, not built artefacts.
  transpilePackages: ['@bliprank/stats', '@bliprank/scorer'],
  reactStrictMode: true,
  // The workspace packages are TypeScript source using NodeNext-style '.js'
  // specifiers. Webpack resolves those literally and finds nothing, so map them
  // back to the real extensions rather than rewriting every import.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }
    return config
  },
}

export default config
