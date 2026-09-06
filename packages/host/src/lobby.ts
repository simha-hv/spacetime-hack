import qrcode from 'qrcode-generator';

/**
 * The join panel: room code in very large text, plus a QR encoding the full
 * absolute join URL so a scan goes straight into the game with no typing.
 */
export class LobbyPanel {
  private readonly codeEl: HTMLElement;
  private readonly qrEl: HTMLElement;
  private readonly urlEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.codeEl = root.querySelector('#code')!;
    this.qrEl = root.querySelector('#qr')!;
    this.urlEl = root.querySelector('#url')!;
    this.statusEl = root.querySelector('#status')!;
  }

  setRoom(code: string, joinUrl: string): void {
    this.codeEl.textContent = code;
    this.urlEl.textContent = joinUrl.replace(/^https?:\/\//, '');

    // Type 0 = auto-size, 'M' = ~15% error correction. Enough redundancy for
    // a phone camera at an angle across a room, without inflating the module
    // count so much that the QR stops scanning at this panel size.
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    this.qrEl.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 1, scalable: true });

    const svg = this.qrEl.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.display = 'block';
    }
  }

  setStatus(text: string, tone: 'ok' | 'warn' | 'bad'): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.tone = tone;
  }
}
