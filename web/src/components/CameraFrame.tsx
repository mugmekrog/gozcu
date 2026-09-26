/* The drone frame with its detections drawn on it.
 *
 * The overlay is an SVG whose viewBox is the source image's pixel dimensions, so
 * every box is placed in the detector's own coordinates and nothing has to be
 * rescaled by hand. `preserveAspectRatio="xMidYMid meet"` matches the image's
 * `object-fit: contain` exactly, which is what keeps the boxes on the vehicles at
 * any container size -- and it has to, because the data has three resolutions
 * (960x540, 1360x765, 1920x1080) and a GSD range of 0.109-0.199 m/px.
 *
 * Kept boxes are stroked in their matched track's risk colour. Suppressed boxes
 * are dashed grey and off by default: a raw frame carries around 430 boxes and
 * about 5 survive, so drawing them all would hide the answer inside the working.
 */

import { memo, useMemo, useState } from 'react';
import { bandOf, riskStyle } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { Switch } from './Switch';
import type { Alert, FrameDetail, Match } from '@/domain/types';
import './camera-frame.css';

export interface CameraFrameProps {
  frame: FrameDetail;
  imageUrl: string | null;
  /** Null before an evaluation has run: the image shows with no boxes. */
  evaluated: boolean;
  selectedDetId: string | null;
  showSuppressed: boolean;
  onShowSuppressed: (show: boolean) => void;
  onSelectDetection: (detId: string | null) => void;
  /** A crop window in source pixels, for the target inspector. */
  crop?: { x: number; y: number; w: number; h: number } | null;
  compact?: boolean;
}

/** Detection id -> the alert level of the track it matched. */
function levelIndex(matches: readonly Match[], alerts: readonly Alert[]) {
  const trackOf = new Map(matches.map((m) => [m.det_id, m.track_id]));
  const alertOf = new Map(alerts.map((a) => [a.track_id, a]));
  return (detId: string) => {
    const trackId = trackOf.get(detId);
    // A box with no match still gets drawn; it has no level, not level CLEAR.
    if (!trackId) return { alert: alertOf.get(detId) ?? null, trackId: null };
    return { alert: alertOf.get(trackId) ?? null, trackId };
  };
}

export const CameraFrame = memo(function CameraFrame({
  frame,
  imageUrl,
  evaluated,
  selectedDetId,
  showSuppressed,
  onShowSuppressed,
  onSelectDetection,
  crop = null,
  compact = false,
}: CameraFrameProps) {
  const [imageFailed, setImageFailed] = useState(false);

  const kept = useMemo(() => frame.detections.filter((d) => d.kept), [frame.detections]);
  const dropped = useMemo(() => frame.detections.filter((d) => !d.kept), [frame.detections]);
  const lookup = useMemo(() => levelIndex(frame.matches, frame.alerts), [frame.matches, frame.alerts]);

  const viewBox = crop
    ? `${crop.x} ${crop.y} ${crop.w} ${crop.h}`
    : `0 0 ${frame.width_px} ${frame.height_px}`;

  return (
    <div className="camera">
      {imageUrl && !imageFailed ? (
        <img
          className="camera__image"
          src={imageUrl}
          alt={`${frame.image_id} drone karesi, ${frame.capture_hhmm}`}
          width={frame.width_px}
          height={frame.height_px}
          decoding="async"
          onError={() => setImageFailed(true)}
          style={
            crop
              ? {
                  // Zoom to the crop window by scaling the image and shifting it,
                  // which keeps the SVG overlay and the pixels in step.
                  transform: `scale(${frame.width_px / crop.w})`,
                  transformOrigin: `${(crop.x + crop.w / 2) / frame.width_px * 100}% ${
                    (crop.y + crop.h / 2) / frame.height_px * 100
                  }%`,
                }
              : undefined
          }
        />
      ) : (
        <div className="camera__missing" role="status">
          <b>{T.modal.imageMissing}</b>
          <span className="muted">{T.modal.imageMissingHint}</span>
        </div>
      )}

      <svg
        className="camera__overlay"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`${kept.length} tespit kutusu`}
      >
        {evaluated && showSuppressed &&
          dropped.map((det) => (
            <rect
              key={det.det_id}
              x={det.bbox_px[0]}
              y={det.bbox_px[1]}
              width={det.bbox_px[2] - det.bbox_px[0]}
              height={det.bbox_px[3] - det.bbox_px[1]}
              fill="none"
              stroke="var(--ink-faint)"
              strokeWidth={frame.width_px / 600}
              strokeDasharray={`${frame.width_px / 200} ${frame.width_px / 300}`}
            />
          ))}

        {evaluated &&
          kept.map((det) => {
            const { alert } = lookup(det.det_id);
            const style = riskStyle(bandOf(alert?.level ?? null, alert?.breakdown.score ?? 0));
            const selected = det.det_id === selectedDetId;
            const [x1, y1, x2, y2] = det.bbox_px;
            const stroke = frame.width_px / (selected ? 180 : 320);

            return (
              <g
                key={det.det_id}
                className="camera__box"
                role="button"
                tabIndex={0}
                aria-label={`${classLabel(det.cls)}, güven ${fmt.percent(det.score)}${
                  alert ? `, ${alert.level}` : ''
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectDetection(selected ? null : det.det_id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectDetection(selected ? null : det.det_id);
                  }
                }}
              >
                <rect
                  x={x1}
                  y={y1}
                  width={x2 - x1}
                  height={y2 - y1}
                  fill="none"
                  stroke={style.color}
                  strokeWidth={stroke}
                />
                {(selected || alert?.level === 'ALERT') && !compact && (
                  <>
                    <rect
                      x={x1}
                      y={Math.max(0, y1 - frame.height_px / 26)}
                      width={(classLabel(det.cls).length + 6) * (frame.width_px / 90)}
                      height={frame.height_px / 26}
                      fill={style.color}
                    />
                    <text
                      x={x1 + frame.width_px / 200}
                      y={Math.max(0, y1 - frame.height_px / 26) + frame.height_px / 36}
                      fontSize={frame.height_px / 38}
                      fontWeight={700}
                      fill="#ffffff"
                    >
                      {classLabel(det.cls)} {fmt.percent(det.score)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
      </svg>

      <div className="camera__label">
        {frame.image_id} · DRONE · {frame.capture_hhmm}
      </div>

      {!evaluated && (
        <div className="camera__hint">
          <span className="camera__hint-text">{T.modal.cameraBeforeEval}</span>
        </div>
      )}

      {evaluated && !compact && (
        <div className="camera__legend">
          <span>
            {T.modal.boxLegendSafe} · {T.modal.boxLegendThreat}
          </span>
          <Switch
            checked={showSuppressed}
            onChange={onShowSuppressed}
            label={`bastırılanları göster (${dropped.length})`}
          />
        </div>
      )}
    </div>
  );
});
