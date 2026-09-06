import assert from 'node:assert/strict';
import test from 'node:test';

import {
  colorByHex,
  defaultName,
  isValidColor,
  NAME_MAX_LENGTH,
  PALETTE,
  sanitizeName,
} from '../../../dist/test/index.js';

test('the palette is larger than the player cap so there is a real choice', () => {
  assert.ok(PALETTE.length > 4, 'more colours than players');
  const hexes = PALETTE.map((c) => c.hex.toLowerCase());
  assert.equal(new Set(hexes).size, hexes.length, 'no duplicate colours');
  const names = PALETTE.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
});

test('every palette colour carries a spoken name', () => {
  // Colour alone fails for colourblind players reading a screen across a room.
  for (const color of PALETTE) {
    assert.match(color.hex, /^#[0-9a-f]{6}$/i);
    assert.ok(color.name.length > 0);
  }
});

test('colour lookup is case-insensitive and rejects anything off-palette', () => {
  assert.equal(colorByHex('#FF4D4D')?.name, 'RED');
  assert.equal(isValidColor('#ff4d4d'), true);
  assert.equal(isValidColor('#123456'), false, 'off-palette colour refused');
  assert.equal(isValidColor('red'), false);
  assert.equal(isValidColor(''), false);
});

/* --------------------------------- names --------------------------------- */

test('ordinary names pass through unchanged', () => {
  assert.equal(sanitizeName('Priya'), 'Priya');
  assert.equal(sanitizeName("O'Neil"), "O'Neil");
  assert.equal(sanitizeName('player-2'), 'player-2');
  assert.equal(sanitizeName('Ravi K.'), 'Ravi K.');
});

test('names are trimmed, collapsed and length-capped', () => {
  assert.equal(sanitizeName('   Sam   '), 'Sam');
  assert.equal(sanitizeName('a      b'), 'a b', 'runs of whitespace collapse');
  assert.equal(sanitizeName('x'.repeat(50)).length, NAME_MAX_LENGTH);
});

test('non-latin names survive intact', () => {
  // Combining marks must be kept: dropping them turns प्रिया into परय.
  assert.equal(sanitizeName('प्रिया'), 'प्रिया');
  assert.equal(sanitizeName('さくら'), 'さくら');
  assert.equal(sanitizeName('محمد'), 'محمد');
  assert.equal(sanitizeName('ஆனந்த்'), 'ஆனந்த்');
});

test('layout-wrecking characters are stripped', () => {
  assert.equal(sanitizeName('bad\nname'), 'bad name', 'a newline separates, not welds');
  assert.equal(sanitizeName('ab'), 'ab', 'control characters removed');
  assert.equal(sanitizeName('a‮b'), 'ab', 'RTL override removed');
  assert.equal(sanitizeName('<script>'), 'script', 'angle brackets are not in the allowlist');
});

test('an empty or whitespace-only name clears rather than errors', () => {
  assert.equal(sanitizeName(''), '');
  assert.equal(sanitizeName('    '), '');
  assert.equal(sanitizeName(undefined), '');
});

test('obscene names are rejected as whole words', () => {
  assert.equal(sanitizeName('fuck'), '');
  assert.equal(sanitizeName('FUCK'), '');
  assert.equal(sanitizeName('oh shit'), '', 'blocked as one word among others');
  assert.equal(sanitizeName('F U C K'), '', 'spacing does not evade the filter');
  assert.equal(sanitizeName('s.h.i.t'), '', 'punctuation does not evade the filter');
});

test('real names that merely contain a blocked substring are allowed', () => {
  // The Scunthorpe problem, and it is not hypothetical for this deployment:
  // Harshit, Rishit and Ashit are common Indian given names. Refusing to let
  // someone type their own name is the worse failure.
  assert.equal(sanitizeName('Harshit'), 'Harshit');
  assert.equal(sanitizeName('Rishit'), 'Rishit');
  assert.equal(sanitizeName('Scunthorpe'), 'Scunthorpe');
  assert.equal(sanitizeName('Dickson'), 'Dickson');
  assert.equal(sanitizeName('Hancock'), 'Hancock');
});

test('the fallback label is the slot number', () => {
  assert.equal(defaultName(0), 'P1');
  assert.equal(defaultName(3), 'P4');
});
