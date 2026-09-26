/* The selected vehicle as the drone saw it.
 *
 * Clicking a symbol on the map puts its box from its own frame here, cropped
 * with some ground around it so the operator can check that the thing the rules
 * are reasoning about is really a vehicle. "Görseli büyüt" opens the same view
 * large, where the whole frame is one toggle away.
 *
 * The crop only appears once the vehicle's frame has been captured on the sim
 * clock -- the same rule the map uses for its level -- so scrubbing back never
 * shows a picture the drone has not taken yet.
 *
 * Image and box are drawn in one SVG whose viewBox is the crop window in source
 * pixels, so the box is placed in the detector's own coordinates and cannot
 * drift off the vehicle at any panel width.
 */

import { memo, useEffect, useState, type ReactNode } from 'react';
import { bandOf, riskStyle } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import { cropAround, type CropWindow } from '@/domain/crop';
import * as fmt from '@/domain/format';
import type { LiveVehicle } from '@/domain/live';
import type { Detection, FrameDetail, Match } from '@/domain/types';
import './target-crop.css';

export interface TargetCropProps {
  vehicle: LiveVehicle;
  loadFrame: (imageId: string) => Promise<FrameDetail>;
  imageUrl: (imageId: string) => string | null;
}

/** The panel crop is 16:9 so it fills its box without letterbox bars. */
const PANEL_ASPECT = 16 / 9;

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; frame: FrameDetail };

export const TargetCrop = memo(function TargetCrop({
  vehicle,
  loadFrame,
  imageUrl,
}: TargetCropProps) {
  const { trackId, imageId } = vehicle;
  const captured = vehicle.level !== null;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [enlarged, setEnlarged] = useState<'target' | 'full' | null>(null);

  useEffect(() => {
    if (!imageId || !captured) return;
    let live = true;
    setLoad({ state: 'loading' });
    loadFrame(imageId).then(
      (frame) => live && setLoad({ state: 'ready', frame }),
      (error: unknown) =>
        live &&
        setLoad({ state: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [imageId, captured, loadFrame]);

  // A different vehicle closes the large view rather than silently swapping it.
  useEffect(() => setEnlarged(null), [trackId]);

  const frame = load.state === 'ready' && load.frame.image_id === imageId ? load.frame : null;
  const match = frame?.matches.find((m) => m.track_id === trackId) ?? null;
  const det = match ? (frame?.detections.find((d) => d.det_id === match.det_id) ?? null) : null;
  const url = imageId ? imageUrl(imageId) : null;
  const colour = riskStyle(bandOf(vehicle.level, vehicle.score)).color;

  let body: ReactNode;
  if (!imageId) body = <Empty text={T.crop.noFrame} />;
  else if (!captured) body = <Empty text={T.crop.notCaptured} />;
  else if (load.state === 'error') body = <Empty text={load.message} />;
  else if (!frame) body = <Empty text={T.crop.loading} />;
  else if (!det || !match) body = <Empty text={T.crop.noMatch} />;
  else if (!url) body = <Empty text={T.modal.imageMissing} />;
  else {
    body = (
      <>
        <button
          type="button"
          className="target-crop__view"
          onClick={() => setEnlarged('target')}
          aria-label={`${trackId} kırpımını büyüt`}
        >
          <FrameImage
            frame={frame}
            url={url}
            det={det}
            colour={colour}
            window={cropAround(det.bbox_px, frame.width_px, frame.height_px, {
              scale: 4,
              minW: 220,
              aspect: PANEL_ASPECT,
            })}
          />
        </button>

        <div className="target-crop__foot">
          <Caption det={det} match={match} />
          <div className="spacer" />
          <button type="button" className="btn btn--small" onClick={() => setEnlarged('target')}>
            {T.crop.enlarge}
          </button>
        </div>
      </>
    );
  }

  return (
    <section className="panel target-crop">
      <h2 className="panel__head">
        {T.crop.title}
        <div className="spacer" />
        <span className="panel__head-note">
          {trackId}
          {imageId && ` · ${imageId}`}
        </span>
      </h2>
      <div className="panel__body target-crop__body">{body}</div>

      {enlarged && frame && det && match && url && (
        <Lightbox
          frame={frame}
          url={url}
          det={det}
          match={match}
          colour={colour}
          trackId={trackId}
          mode={enlarged}
          onMode={setEnlarged}
          onClose={() => setEnlarged(null)}
        />
      )}
    </section>
  );
});

function Empty({ text }: { text: string }) {
  return (
    <p className="target-crop__empty muted" role="status">
      {text}
    </p>
  );
}

function Caption({ det, match }: { det: Detection; match: Match }) {
  return (
    <span className="target-crop__caption">
      <b>{classLabel(det.cls)}</b> · güven {fmt.percent(det.score)} · {fmt.distance(match.distance_m)}{' '}
      eşleşme{match.confidence === 'low' && ` · ${T.crop.matchLow}`}
    </span>
  );
}

interface FrameImageProps {
  frame: FrameDetail;
  url: string;
  det: Detection;
  colour: string;
  window: CropWindow;
  /** The frame's other kept boxes, faint, for context in the full view. */
  others?: readonly Detection[];
}

function FrameImage({ frame, url, det, colour, window: win, others = [] }: FrameImageProps) {
  const [failed, setFailed] = useState(false);
  // Stroke in screen-ish units: thinner for a tight crop, thicker for the full frame.
  const stroke = Math.max(win.w / 260, 1);
  const [x1, y1, x2, y2] = det.bbox_px;

  if (failed) return <Empty text={T.modal.imageMissing} />;

  return (
    <svg
      className="target-crop__svg"
      viewBox={`${win.x} ${win.y} ${win.w} ${win.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${frame.image_id}, ${classLabel(det.cls)} tespiti`}
    >
      <image
        href={url}
        width={frame.width_px}
        height={frame.height_px}
        preserveAspectRatio="none"
        onError={() => setFailed(true)}
      />
      {others.map((o) => (
        <rect
          key={o.det_id}
          x={o.bbox_px[0]}
          y={o.bbox_px[1]}
          width={o.bbox_px[2] - o.bbox_px[0]}
          height={o.bbox_px[3] - o.bbox_px[1]}
          fill="none"
          stroke="var(--ink-inverse)"
          strokeOpacity={0.7}
          strokeWidth={stroke * 0.6}
        />
      ))}
      <rect
        x={x1}
        y={y1}
        width={x2 - x1}
        height={y2 - y1}
        fill="none"
        stroke={colour}
        strokeWidth={stroke}
      />
    </svg>
  );
}

interface LightboxProps {
  frame: FrameDetail;
  url: string;
  det: Detection;
  match: Match;
  colour: string;
  trackId: string;
  mode: 'target' | 'full';
  onMode: (mode: 'target' | 'full') => void;
  onClose: () => void;
}

function Lightbox({ frame, url, det, match, colour, trackId, mode, onMode, onClose }: LightboxProps) {
  // Escape closes this view only; the app-level Escape would also drop the
  // vehicle selection, which is not what the operator asked for.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const full: CropWindow = { x: 0, y: 0, w: frame.width_px, h: frame.height_px };
  const others = frame.detections.filter((d) => d.kept && d.det_id !== det.det_id);

  return (
    <div className="target-crop__backdrop" onClick={onClose}>
      <div
        className="target-crop__lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={`${trackId} · ${frame.image_id}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="target-crop__lightbox-head">
          <b>{trackId}</b>
          <span className="muted">
            {frame.image_id} · {frame.capture_hhmm} · {frame.width_px}×{frame.height_px}
          </span>
          <div className="spacer" />
          <div className="target-crop__toggle" role="group" aria-label="Görünüm">
            <button
              type="button"
              className="btn btn--small"
              aria-pressed={mode === 'target'}
              onClick={() => onMode('target')}
            >
              {T.crop.target}
            </button>
            <button
              type="button"
              className="btn btn--small"
              aria-pressed={mode === 'full'}
              onClick={() => onMode('full')}
            >
              {T.crop.fullFrame}
            </button>
          </div>
          <button type="button" className="btn btn--small" onClick={onClose} autoFocus>
            {T.crop.close}
          </button>
        </div>

        <div className="target-crop__lightbox-body">
          <FrameImage
            frame={frame}
            url={url}
            det={det}
            colour={colour}
            window={
              mode === 'full'
                ? full
                : cropAround(det.bbox_px, frame.width_px, frame.height_px, {
                    scale: 6,
                    minW: 360,
                    aspect: frame.width_px / frame.height_px,
                  })
            }
            others={mode === 'full' ? others : []}
          />
        </div>

        <div className="target-crop__lightbox-foot">
          <Caption det={det} match={match} />
        </div>
      </div>
    </div>
  );
}
