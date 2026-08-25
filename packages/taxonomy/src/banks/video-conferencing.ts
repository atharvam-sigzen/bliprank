/**
 * DEMO-SCOPED prompt bank — video conferencing. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders.
 */

import type { PromptBank } from '../types.js'

export const VIDEO_CONFERENCING: PromptBank = {
  category: 'video-conferencing',
  displayName: 'Video conferencing',
  description: 'Software for running video meetings, webinars and remote calls.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. This bank has the worst bare-name problem of any of them: "zoom", "teams" and "meet" are all ordinary English and all banned as aliases, so Zoom, Microsoft Teams and Google Meet are each tracked through two-word aliases only and every one of those three rates is a LOWER BOUND — an answer that says "use Zoom" scores nothing. Attribution is narrowed for the same reason: Microsoft Teams is claimed on teams.microsoft.com rather than microsoft.com, and Google Meet on meet.google.com, so citations to a parent marketing page are missed rather than over-credited.',
  leaders: [
    { id: 'zoom', name: 'Zoom', aliases: ['zoom meetings', 'zoom video', 'zoom.us'], domains: ['zoom.us'] },
    { id: 'microsoft-teams', name: 'Microsoft Teams', aliases: ['microsoft teams', 'ms teams'], domains: ['teams.microsoft.com'] },
    { id: 'google-meet', name: 'Google Meet', aliases: ['google meet'], domains: ['meet.google.com'] },
    { id: 'webex', name: 'Webex', aliases: ['webex', 'cisco webex'], domains: ['webex.com'] },
    { id: 'whereby', name: 'Whereby', aliases: ['whereby'], domains: ['whereby.com'] },
    { id: 'goto-meeting', name: 'GoTo Meeting', aliases: ['goto meeting', 'gotomeeting'], domains: ['goto.com'] },
    { id: 'livestorm', name: 'Livestorm', aliases: ['livestorm'], domains: ['livestorm.co'] },
    { id: 'jitsi', name: 'Jitsi Meet', aliases: ['jitsi', 'jitsi meet'], domains: ['jitsi.org'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best video conferencing tool for a small remote team?', intent: 'discovery' },
    { text: 'Which video meeting platform is best for running client calls?', intent: 'discovery' },
    { text: 'Best webinar platform for a company running monthly product demos', intent: 'discovery' },
    { text: 'Which video call tool works best for a school or training provider?', intent: 'discovery' },
    { text: 'Best open source video conferencing that can be self-hosted', intent: 'discovery' },
    { text: 'Which video conferencing tools have a free plan without a time limit?', intent: 'discovery' },
    { text: 'Best video meeting software for a team spread across the UK and India', intent: 'discovery' },
    { text: 'Which platform is best for interviews that need to be recorded and shared?', intent: 'discovery' },
    { text: 'Best video conferencing for a business that needs guests to join without an account', intent: 'discovery' },
    { text: 'Which video meeting tools work reliably on a slow connection?', intent: 'discovery' },
    // comparison
    { text: 'Zoom Meetings vs Microsoft Teams for a 50-person company', intent: 'comparison' },
    { text: 'Google Meet or Zoom Meetings for a small business already on Google Workspace', intent: 'comparison' },
    { text: 'Webex vs Microsoft Teams for an enterprise with strict security rules', intent: 'comparison' },
    { text: 'What are the best alternatives to Zoom Meetings for client-facing calls?', intent: 'comparison' },
    { text: 'Whereby vs Google Meet for quick calls with people outside the company', intent: 'comparison' },
    { text: 'Livestorm vs GoTo Meeting for running a regular webinar', intent: 'comparison' },
    { text: 'Is a dedicated webinar tool worth it, or is a normal meeting platform enough?', intent: 'comparison' },
    { text: 'Self-hosted versus cloud video conferencing for a privacy-sensitive organisation', intent: 'comparison' },
    // problem-led
    { text: 'Our video calls keep dropping for people on home broadband, what can we change?', intent: 'problem-led' },
    { text: 'How do we run a meeting where half the room is remote and half is in an office?', intent: 'problem-led' },
    { text: 'We need call recordings for compliance, how should we store and retain them?', intent: 'problem-led' },
    { text: 'Our meeting tool costs per host and we keep buying licences, what are the options?', intent: 'problem-led' },
    { text: 'How do we stop uninvited people joining our public webinars?', intent: 'problem-led' },
    { text: 'How do we run accessible video meetings with live captions?', intent: 'problem-led' },
    { text: 'Our clients refuse to install software for a call, what should we use?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Zoom Meetings still the best choice now that competitors have caught up?', intent: 'brand-verification' },
    { text: 'Is Microsoft Teams good enough to replace a dedicated meeting tool?', intent: 'brand-verification' },
    { text: 'Is Google Meet reliable for large all-hands meetings?', intent: 'brand-verification' },
    { text: 'Is Webex worth it for a mid-sized company outside the enterprise tier?', intent: 'brand-verification' },
    { text: 'Is Jitsi Meet realistic to self-host for a 30-person company?', intent: 'brand-verification' },
  ],
}
