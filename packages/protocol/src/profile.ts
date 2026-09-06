/**
 * Player identity: name and colour.
 *
 * Shared by all three components so the picker on the phone, the validation on
 * the server, and the rendering on the big screen cannot drift apart.
 *
 * Design note: identity is chosen AFTER joining, never before. A player is
 * dropped into the game the instant they scan, with a colour auto-assigned,
 * and can change any of this while already playing. Scan-to-playing stays
 * under a couple of seconds; nobody is ever parked on a lobby screen.
 */

export interface PaletteColor {
  hex: string;
  /** Spoken name. Colour alone fails for colourblind players across a room. */
  name: string;
}

/**
 * Eight colours for four players, so there is a real choice rather than a
 * shuffle of the only options. Auto-assignment walks this list in order, so
 * the first four joiners still get red/blue/green/yellow.
 */
export const PALETTE: readonly PaletteColor[] = [
  { hex: '#ff4d4d', name: 'RED' },
  { hex: '#3d7dff', name: 'BLUE' },
  { hex: '#3ddc84', name: 'GREEN' },
  { hex: '#ffd23d', name: 'YELLOW' },
  { hex: '#b06dff', name: 'PURPLE' },
  { hex: '#ff8a3d', name: 'ORANGE' },
  { hex: '#35d6d6', name: 'CYAN' },
  { hex: '#ff6ec7', name: 'PINK' },
];

export const colorByHex = (hex: string): PaletteColor | undefined =>
  PALETTE.find((c) => c.hex.toLowerCase() === hex.toLowerCase());

export const isValidColor = (hex: string): boolean => colorByHex(hex) !== undefined;

/* --------------------------------- names --------------------------------- */

export const NAME_MAX_LENGTH = 12;

/** Words that should not end up six feet tall on a screen at a party. */
const NAME_BLOCKLIST = [
  'anus', 'arse', 'bitch', 'clit', 'cock', 'coon', 'cunt', 'dick', 'dyke',
  'fag', 'fuck', 'gook', 'kike', 'nigga', 'nigger', 'paki', 'penis', 'piss',
  'pussy', 'rape', 'retard', 'shit', 'slut', 'spic', 'tits', 'twat', 'wank',
  'whore',
];

const BLOCKED = new Set(NAME_BLOCKLIST);

/**
 * Is this name blocked?
 *
 * Matches whole words only, never substrings. Substring matching is the
 * Scunthorpe problem and it is not a hypothetical here: "Harshit", "Rishit"
 * and "Ashit" are ordinary Indian given names that contain "shit", and
 * Dickson, Hancock and Cunliffe are ordinary surnames. Refusing to let someone
 * type their own name is a worse failure than letting "xxsh1txx" through — and
 * anyone determined to get an obscenity on screen will succeed regardless.
 *
 * Two checks, both on whole tokens:
 *   1. any word of the name is a blocked word ("oh shit");
 *   2. the whole name, stripped to letters, is a blocked word — which catches
 *      the spaced-out and punctuated evasions ("F U C K", "s.h.i.t").
 */
function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();

  for (const word of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (word && BLOCKED.has(word)) return true;
  }

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  return BLOCKED.has(lettersOnly);
}

/**
 * Normalise a submitted name.
 *
 * Returns an empty string for anything unusable, in which case the caller
 * falls back to the slot label ("P1"). Runs on the server, which is the only
 * place that counts, and on the phone for a live preview.
 */
export function sanitizeName(raw: string): string {
  const cleaned = Array.from(
    // Whitespace first, so a newline separates words instead of welding them
    // together. NFC keeps composed characters in one piece.
    (raw ?? '').normalize('NFC').replace(/\s+/gu, ' '),
  )
    // Letters, marks, digits, space and a few harmless symbols.
    //
    // \p{M} is not optional: Devanagari matras and the virama are combining
    // marks, so dropping them turns "प्रिया" into "परय". The same applies to
    // Arabic, Thai, Tamil and Hebrew. ZWJ/ZWNJ are needed for correct Indic
    // conjuncts. Everything else goes, which removes control characters and
    // bidi overrides that would wreck the host layout.
    .filter((ch) => /[\p{L}\p{M}\p{N} _\-.!?'‌‍]/u.test(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_LENGTH);

  return isBlockedName(cleaned) ? '' : cleaned;
}

/** What the host shows when a player has not set a name. */
export const defaultName = (slot: number): string => `P${slot + 1}`;
