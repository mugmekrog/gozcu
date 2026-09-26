/* Crop windows around a detection box, in source-image pixels. */

export interface CropWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropOptions {
  /** How many box-widths of context to show around the box. */
  scale?: number;
  /** Floor on the window's width, so a 20 px car is not blown up to mush. */
  minW?: number;
  /** Width / height to widen the window to, so it fills its box without bars. */
  aspect?: number;
}

/** A window centred on the box, padded by `scale` and clamped to the image. */
export function cropAround(
  bbox: readonly [number, number, number, number],
  imageW: number,
  imageH: number,
  { scale = 3, minW = 0, aspect }: CropOptions = {},
): CropWindow {
  const [x1, y1, x2, y2] = bbox;
  let w = Math.max((x2 - x1) * scale, minW);
  let h = (y2 - y1) * scale;
  if (aspect) {
    // Grow whichever side is short; never shrink below the padded box.
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
  }
  w = Math.min(w, imageW);
  h = Math.min(h, imageH);

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return {
    x: Math.max(0, Math.min(cx - w / 2, imageW - w)),
    y: Math.max(0, Math.min(cy - h / 2, imageH - h)),
    w,
    h,
  };
}
