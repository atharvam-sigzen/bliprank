/**
 * DEMO-SCOPED prompt bank — Password managers. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const PASSWORD_MANAGERS: PromptBank = {
  category: 'password-managers',
  displayName: 'Password managers',
  description: 'Software that stores, generates and shares passwords, passkeys and other credentials for individuals, families and businesses.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Proton Pass is matched on pass.proton.me only; proton.me/pass is a path and cannot be matched host-side, so its citation rate is a LOWER BOUND.',
  leaders: [
    { id: '1password', name: '1Password', aliases: ['1password'], domains: ['1password.com'] },
    { id: 'bitwarden', name: 'Bitwarden', aliases: ['bitwarden'], domains: ['bitwarden.com'] },
    { id: 'dashlane', name: 'Dashlane', aliases: ['dashlane'], domains: ['dashlane.com'] },
    { id: 'nordpass', name: 'NordPass', aliases: ['nordpass', 'nord pass'], domains: ['nordpass.com'] },
    { id: 'keeper', name: 'Keeper Security', aliases: ['keeper', 'keeper security', 'keepersecurity', 'keeper password manager'], domains: ['keepersecurity.com'] },
    { id: 'proton-pass', name: 'Proton Pass', aliases: ['proton pass', 'protonpass'], domains: ['pass.proton.me'], siteDomains: ['proton.me'] },
    { id: 'lastpass', name: 'LastPass', aliases: ['lastpass', 'lastpass.com'], domains: ['lastpass.com'] },
    { id: 'keepass', name: 'KeePass', aliases: ['keepass'], domains: ['keepass.info'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best password manager for a family?', intent: 'discovery' },
    { text: 'Best password manager for a 10-person startup', intent: 'discovery' },
    { text: 'Which password manager should a solo freelancer use?', intent: 'discovery' },
    { text: 'Best password manager for enterprise teams that need SSO and SCIM provisioning', intent: 'discovery' },
    { text: 'Best password manager for developers who share API keys and SSH keys', intent: 'discovery' },
    { text: 'Recommended password manager for a UK accountancy firm managing client logins', intent: 'discovery' },
    { text: 'What is the best free password manager that does not cap how many passwords you can store?', intent: 'discovery' },
    { text: 'Password manager recommendations for an Indian SME with about 50 staff', intent: 'discovery' },
    { text: 'Which password manager works best across iPhone, Mac and Windows?', intent: 'discovery' },
    { text: 'Best self-hosted open source password manager for a privacy-focused team', intent: 'discovery' },
    // comparison
    { text: '1Password vs Bitwarden for a small team', intent: 'comparison' },
    { text: 'Dashlane or NordPass for a family plan?', intent: 'comparison' },
    { text: 'What are the best alternatives to LastPass?', intent: 'comparison' },
    { text: 'Bitwarden vs Proton Pass for a privacy-conscious individual', intent: 'comparison' },
    { text: 'Keeper vs 1Password for a company that needs compliance reporting', intent: 'comparison' },
    { text: 'Cheapest alternatives to Dashlane for a five-person team', intent: 'comparison' },
    { text: 'How does Proton Pass compare to 1Password for business use?', intent: 'comparison' },
    { text: 'NordPass vs Keeper for a mid-market company rolling out to 300 employees', intent: 'comparison' },
    // problem-led
    { text: 'How do I move my passwords out of my browser into a proper password manager?', intent: 'problem-led' },
    { text: 'My team keeps sharing passwords over Slack, how do we stop that?', intent: 'problem-led' },
    { text: 'How can I share logins with contractors without giving them the actual password?', intent: 'problem-led' },
    { text: 'Our password manager renewal price jumped, what are our options?', intent: 'problem-led' },
    { text: 'How do I get back into my vault if I forget the master password?', intent: 'problem-led' },
    { text: 'Our company needs credentials kept on EU servers, how should we handle password management?', intent: 'problem-led' },
    { text: 'We have a SOC 2 audit coming and our credentials live in spreadsheets, where do we start?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Bitwarden a good choice for a small business?', intent: 'brand-verification' },
    { text: 'What are the downsides of 1Password for a small team on a budget?', intent: 'brand-verification' },
    { text: 'Is Dashlane worth paying for if I only need it on my own devices?', intent: 'brand-verification' },
    { text: 'Is LastPass still a safe choice for personal use?', intent: 'brand-verification' },
    { text: 'Is Keeper any good for a mid-sized company?', intent: 'brand-verification' },
  ],
}
