/** The two inkCaret drawings from December's HyperFrames film,
 * compositions/frames/04b-close.html. Kept as tiny SVGs: no video runtime.
 * The tip is (0,0), anchored inside the current week's actual bar. */
export function weekCaret() {
  return `<svg class="yr-week-caret" viewBox="-12 -14 24 16" aria-hidden="true" focusable="false">
    <g class="caret-a"><path pathLength="1" d="M-6.4 -7.4 Q-3.2 -3.7 0 0 Q3.4 -3.9 6.6 -7.8"/></g>
    <g class="caret-b"><path pathLength="1" d="M-6.9 -6.9 Q-3.4 -4.0 0.2 0.2 Q3.1 -3.5 6.1 -7.3"/></g>
  </svg>`
}
