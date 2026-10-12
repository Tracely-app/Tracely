/* Tracer's voices, as the desktop app shows them.
 *
 * Seven original personas, each built on one of OpenAI gpt-live-1's built-in
 * voices with its own personality, pacing and coaching style. The server owns
 * the base voice and the persona instructions (server/lib/voices.js); this file
 * owns what the student sees. server/test/voices.test.js pins the ids here to
 * the server's, so a persona can't exist on one side only.
 *
 * Names deliberately avoid ChatGPT's own voice names.
 */
export type VoiceId = 'linden' | 'atlas' | 'wren' | 'rory' | 'kip' | 'hollis' | 'sterling'

export interface VoicePersona {
  id: VoiceId
  name: string
  tagline: string
  accent: string
  description: string
}

export const VOICES: readonly VoicePersona[] = [
  { id: 'linden', name: 'Linden', tagline: 'Warm and encouraging', accent: 'American', description: "Celebrates what's working, then helps with the one thing that matters most." },
  { id: 'atlas', name: 'Atlas', tagline: 'Calm, precise editor', accent: 'American', description: 'Quiet, exact questions that help you find the problem yourself.' },
  { id: 'wren', name: 'Wren', tagline: 'Sharp British tutor', accent: 'British', description: 'Brisk and witty; tests whether your evidence really supports your claim.' },
  { id: 'rory', name: 'Rory', tagline: 'Irish storyteller', accent: 'Irish', description: 'Playful brainstorming with vivid examples; great for openings and angles.' },
  { id: 'kip', name: 'Kip', tagline: 'Upbeat study buddy', accent: 'Australian', description: 'Keeps your momentum up with tiny next steps.' },
  { id: 'hollis', name: 'Hollis', tagline: 'Patient and unhurried', accent: 'Southern US', description: "Slow and reassuring when you're stuck or stressed." },
  { id: 'sterling', name: 'Sterling', tagline: 'Debate coach', accent: 'American', description: 'Argues the other side so your claims hold up.' },
] as const

export const DEFAULT_VOICE_ID: VoiceId = 'linden'

export function voiceById(id: string | null | undefined): VoicePersona {
  return VOICES.find((v) => v.id === id) ?? VOICES[0]
}
