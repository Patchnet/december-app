// Original p5.brush a09 border adaptation, co-designed with Opus 5.
// Fixed material scale and padded overlay preserve the stray pencil marks.
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function pick(images, index) {
  if (!images || !images.length) return null;
  return images[clamp(Math.round(index), 0, images.length - 1)];
}

function begin(ctx) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

const CARD = {
  effect: 'a09-card-form',
  x0: 90, y0: 70, x1: 1110, y1: 690,   // BOX [90,70,1020,620]
  OUT: 26,      // source px captured outside the drawn line
  IN: 22,       // source px captured inside it (includes a little white face)
  CORNER: 74,   // OUT + corner radius (26) + IN — covers the whole arc + grain
  SCALE: 0.36,  // native material scale; the grain is authored for roughly this
};

/**
 * Paint the a09 border ring into a w x h box, with the drawn line falling on
 * the box edges. Corners are fixed native-scale crops; edges are tiled from
 * disjoint source runs.
 *
 * Nothing inside the ring is painted — the caller's real content shows through.
 */
export function paintCard(ctx, images, index, w, h) {
  const img = pick(images, index);
  if (!img || w <= 0 || h <= 0) return;

  const { x0, y0, x1, y1, OUT, IN, CORNER } = CARD;

  // If the target is too small to seat four native corners, drop the uniform
  // scale until they fit rather than distorting them. Still uniform, still
  // unstretched; just a smaller card drawn with the same nib.
  const need = 2 * CORNER;
  const s = Math.min(CARD.SCALE, w / need, h / need);
  const c = CORNER * s;          // corner block, destination px
  const out = OUT * s;           // how far the block reaches outside the line
  const thick = (OUT + IN) * s;  // edge strip thickness, destination px

  // Source anchors. Corner blocks sit flush to the outside of the ring; edge
  // runs occupy whatever is left between them.
  const cx0 = x0 - OUT, cy0 = y0 - OUT;              // top-left block origin
  const cx1 = x1 + OUT - CORNER, cy1 = y1 + OUT - CORNER; // bottom-right origin
  const hRun = [cx0 + CORNER, cx1];                  // usable horizontal source span
  const vRun = [cy0 + CORNER, cy1];                  // usable vertical source span

  begin(ctx);

  // --- four fixed corners, never repeated, never rescaled relative to each other
  ctx.drawImage(img, cx0, cy0, CORNER, CORNER, -out, -out, c, c);
  ctx.drawImage(img, cx1, cy0, CORNER, CORNER, w - c + out, -out, c, c);
  ctx.drawImage(img, cx0, cy1, CORNER, CORNER, -out, h - c + out, c, c);
  ctx.drawImage(img, cx1, cy1, CORNER, CORNER, w - c + out, h - c + out, c, c);

  // --- four edges
  tile(ctx, img, s, false, hRun, y0 - OUT, OUT + IN, c - out, w - c + out, -out, thick);
  tile(ctx, img, s, false, hRun, y1 - IN,  OUT + IN, c - out, w - c + out, h - thick + out, thick);
  tile(ctx, img, s, true,  vRun, x0 - OUT, OUT + IN, c - out, h - c + out, -out, thick);
  tile(ctx, img, s, true,  vRun, x1 - IN,  OUT + IN, c - out, h - c + out, w - thick + out, thick);

  ctx.restore();
}

/**
 * Fill one destination edge span from disjoint runs of one source edge.
 *
 * `vertical` swaps the roles of the axes. `run` is the [start,end] source
 * extent available along the edge, `cross`/`crossLen` the strip across it,
 * `d0`/`d1` the destination span along the edge and `dCross`/`dThick` across.
 *
 * Tiles abut exactly and never overlap, so alpha is never compounded. When
 * more than one tile is needed the source start is walked by an irrational-ish
 * stride so consecutive tiles do not draw the same centimetre of pencil twice
 * in a row; the repeat is still there at wide sizes, just displaced.
 */
function tile(ctx, img, s, vertical, run, cross, crossLen, d0, d1, dCross, dThick) {
  const avail = run[1] - run[0];
  const span = d1 - d0;
  if (avail <= 1 || span <= 0.25) return;

  const perTile = avail * s;                  // destination px one full run covers
  const n = Math.max(1, Math.ceil(span / perTile));
  let at = d0;

  for (let k = 0; k < n && at < d1 - 0.25; k++) {
    const dLen = Math.min(perTile, d1 - at);
    const sLen = dLen / s;
    // deterministic, non-repeating-looking start offset inside the usable run
    const slack = Math.max(0, avail - sLen);
    const sStart = run[0] + (slack ? ((k * 0.6180339887) % 1) * slack : 0);

    if (vertical) {
      ctx.drawImage(img, cross, sStart, crossLen, sLen, dCross, at, dThick, dLen);
    } else {
      ctx.drawImage(img, sStart, cross, sLen, crossLen, at, dCross, dLen, dThick);
    }
    at += dLen;
  }
}

// ---------------------------------------------------------------------------
