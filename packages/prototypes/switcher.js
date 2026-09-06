/** The bar that lets you flip between looks without leaving the big screen. */
export const VARIANTS = [
  { id: 'models', label: 'Models' },
  { id: 'canvas2d', label: 'Canvas 2D' },
  { id: 'roster', label: 'Roster' },
  { id: 'three-clay', label: 'Clay' },
  { id: 'three-toon', label: 'Toon' },
  { id: 'three-noir', label: 'Noir' },
  { id: 'three-pixel', label: 'Pixel' },
  { id: 'pixi-arcade', label: 'Arcade' },
  { id: 'sketch', label: 'Sketch' },
  { id: 'canvas-iso', label: 'Iso' },
  { id: 'canvas-neon', label: 'Neon' },
];

export function mountSwitcher(active) {
  const nav = document.createElement('nav');
  nav.className = 'switcher';
  nav.innerHTML = VARIANTS.map(
    (v) => `<a href="./${v.id}.html"${v.id === active ? ' class="active"' : ''}>${v.label}</a>`,
  ).join('');
  document.body.append(nav);

  // Left/right arrows cycle, so you can flip through them from a clicker.
  addEventListener('keydown', (e) => {
    const i = VARIANTS.findIndex((v) => v.id === active);
    if (e.key === 'ArrowRight') location.href = `./${VARIANTS[(i + 1) % VARIANTS.length].id}.html`;
    if (e.key === 'ArrowLeft')
      location.href = `./${VARIANTS[(i - 1 + VARIANTS.length) % VARIANTS.length].id}.html`;
  });
}
