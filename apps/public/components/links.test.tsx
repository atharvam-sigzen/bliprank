import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActionLink } from './action-link'
import { BackLink } from './back-link'

const publicCss = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const webCss = readFileSync(new URL('../../web/app/globals.css', import.meta.url), 'utf8')

describe('Measurement Record link styling system', () => {
  it('global stylesheet styles bare <a> tags with primary color and full-strength underline', () => {
    for (const css of [publicCss, webCss]) {
      expect(css).toMatch(/a\s*\{[^}]*color:\s*var\(--color-primary\)/)
      expect(css).toMatch(/a\s*\{[^}]*text-decoration:\s*underline/)
      expect(css).toMatch(/a\s*\{[^}]*text-decoration-thickness:\s*1\.5px/)
      expect(css).toMatch(/a\s*\{[^}]*text-decoration-color:\s*currentColor/)
      expect(css).toMatch(/a:hover\s*\{[^}]*text-decoration-thickness:\s*2\.5px/)
    }
  })

  it('ActionLink renders forward action pattern with inline SVG arrow and accessible label', () => {
    const html = renderToStaticMarkup(<ActionLink href="/dashboard/workspace">Workspace settings</ActionLink>)
    expect(html).toContain('class="actionlink"')
    expect(html).toContain('href="/dashboard/workspace"')
    expect(html).toContain('Workspace settings')
    expect(html).toContain('class="actionlink__chevron"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('stroke="currentColor"')
  })

  it('ActionLink supports external links with rel="noreferrer"', () => {
    const html = renderToStaticMarkup(
      <ActionLink href="http://localhost:3000" external>
        Worked example
      </ActionLink>,
    )
    expect(html).toContain('class="actionlink"')
    expect(html).toContain('href="http://localhost:3000"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('BackLink renders backward control pattern with inline SVG arrow and accessible label', () => {
    const html = renderToStaticMarkup(<BackLink href="/dashboard" label="Back to the overview" />)
    expect(html).toContain('class="backlink"')
    expect(html).toContain('href="/dashboard"')
    expect(html).toContain('class="backlink__label">Back to the overview</span>')
    expect(html).toContain('class="backlink__arrow"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('stroke="currentColor"')
  })

  it('actionlink CSS rules include arrow alignment, hover transitions, and minimum target size', () => {
    expect(publicCss).toMatch(/\.actionlink\s*\{[^}]*min-height:\s*44px/)
    expect(publicCss).toMatch(/\.actionlink\s*\{[^}]*color:\s*var\(--color-primary\)/)
    expect(publicCss).toMatch(/\.actionlink__arrow/)
    expect(publicCss).toMatch(/\.actionlink:hover \.actionlink__arrow/)
  })
})