// Inlined SWA brand artwork for the namecard SVG renderer.
//
// The card SVG (/c/:slug/card.svg) must be self-contained — every visual
// asset inlined — so the client-side canvas PNG export is not tainted by a
// cross-origin load (docs/NAMECARD.md §8.2). The logo bytes are baked into
// ./swalogo-generated.ts at build time from public/swa-logo.webp (the SAME
// asset the admin nav and the PayNow QR overlay use).
//
// To update the logo, replace public/swa-logo.webp and re-run
// `npm run gen:swalogo` (the predev/prebuild hooks do this automatically).

import { SWA_LOGO_DATA_URI } from './swalogo-generated';

export { SWA_LOGO_DATA_URI };

/**
 * The card background and ink colours from §1.3 of the implementation plan,
 * kept here as a single source of truth so the SVG renderer and the client
 * CSS stay in sync. These are the design-spec colours, NOT the SWA palette
 * used by the surrounding admin UI.
 */
export const NAMECARD_DESIGN_COLOURS = {
  bgPurple: '#7A0381',
  textWhite: '#FFFFFF',
  divider: 'rgba(255, 255, 255, 0.8)',
  logoBg: '#FFFFFF',
  logoInk: '#6B196E',
} as const;
