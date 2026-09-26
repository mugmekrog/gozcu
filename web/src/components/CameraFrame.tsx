/* The drone frame with recorded GPS fixes and detector boxes drawn together.
 *
 * The overlay is an SVG whose viewBox is the source image's pixel dimensions, so
 * every box is placed in the detector's own coordinates and nothing has to be
 * rescaled by hand. `preserveAspectRatio="xMidYMid meet"` matches the image's
 * `object-fit: contain` exactly, which is what keeps the boxes on the vehicles at
 * any container size -- and it has to, because the data has three resolutions
 * (960x540, 1360x765, 1920x1080) and a GSD range of 0.109-0.199 m/px.
 *
 * GPS coordinates and matching come from the deterministic pipeline. An in-frame
 * fix is marked at its projected pixel, with a line to its matched box centre.
 * Tracks outside the footprint are counted but not drawn on top of the photo.
 * Suppressed boxes are dashed grey and off by default: a raw frame carries
 * around 430 boxes and about 5 survive.
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
  /** Controls warning colours; recorded GPS fixes and kept boxes remain visible. */
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
  const positions = frame.track_positions ?? [];
  const visiblePositions = positions.filter((position) => position.in_frame);
  const matchesByTrack = new Map(frame.matches.map((match) => [match.track_id, match]));
  const detectionsById = new Map(kept.map((detection) => [detection.det_id, detection]));
  const selectedDetection = detectionsById.get(selectedDetId ?? '') ?? null;
  const selectedMatch = frame.matches.find((match) => match.det_id === selectedDetId);
  const selectedPosition = positions.find((position) => position.track_id === selectedMatch?.track_id);

  const viewBox = crop
    ? `${crop.x} ${crop.y} ${crop.w} ${crop.h}`
    : `0 0 ${frame.width_px} ${frame.height_px}`;

  return (
    <div className="camera">
      {imageUrl && !imageFailed ? (
        <img
          className="camera__image"
          src={imageUrl}
          alt={`${frame.image_id} İHA karesi, ${frame.capture_hhmm}`}
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
        aria-label={`${kept.length} tespit kutusu, ${visiblePositions.length} GPS konumu`}
      >
        {showSuppressed &&
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

        {visiblePositions.map((position) => {
          const match = matchesByTrack.get(position.track_id);
          const detection = match ? detectionsById.get(match.det_id) : null;
          if (!detection) return null;
          return (
            <line
              key={`link-${position.track_id}`}
              className="camera__gps-link"
              x1={position.pixel[0]}
              y1={position.pixel[1]}
              x2={detection.center_px[0]}
              y2={detection.center_px[1]}
              strokeWidth={Math.max(2, frame.width_px / 500)}
            />
          );
        })}

        {kept.map((det) => {
            const { alert: recordedAlert, trackId } = lookup(det.det_id);
            const alert = evaluated ? recordedAlert : null;
            const style = riskStyle(bandOf(alert?.level ?? null, alert?.breakdown.score ?? 0));
            const selected = det.det_id === selectedDetId;
            const [x1, y1, x2, y2] = det.bbox_px;
            const stroke = frame.width_px / (selected ? 180 : 320);
            const boxLabel = `${trackId ? `${trackId} · ` : ''}${classLabel(det.cls)} ${fmt.percent(det.score)}`;

            return (
              <g
                key={det.det_id}
                className="camera__box"
                role="button"
                tabIndex={0}
                aria-label={`${trackId ? `${trackId}, ` : ''}${classLabel(det.cls)}, güven ${fmt.percent(det.score)}${
                  alert ? `, ${T.band[bandOf(alert.level, alert.breakdown.score)]}` : ''
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
                      width={boxLabel.length * (frame.height_px / 61) + frame.width_px / 80}
                      height={frame.height_px / 26}
                      fill={style.color}
                    />
                    <text
                      x={x1 + frame.width_px / 200}
                      y={Math.max(0, y1 - frame.height_px / 26) + frame.height_px / 36}
                      fontSize={frame.height_px / 38}
                      fontWeight={700}
                      fill={alert?.level === 'WATCH' ? 'var(--risk-review-deep)' : '#ffffff'}
                    >
                      {boxLabel}
                    </text>
                  </>
                )}
              </g>
            );
          })}

        {visiblePositions.map((position) => {
          const match = matchesByTrack.get(position.track_id);
          const selected = match?.det_id === selectedDetId;
          const [x, y] = position.pixel;
          const radius = Math.max(5, frame.width_px / 180);
          const fontSize = Math.max(12, frame.height_px / 48);
          const label = `${position.track_id}${match ? '' : ' ?'}`;
          const labelWidth = label.length * fontSize * 0.64 + 10;
          const labelX = Math.min(x + radius + 4, frame.width_px - labelWidth);
          const labelY = Math.max(0, y - radius - fontSize - 5);
          const activate = () => {
            if (match) onSelectDetection(selected ? null : match.det_id);
          };
          return (
            <g
              key={`gps-${position.track_id}`}
              className="camera__gps"
              role={match ? 'button' : 'img'}
              tabIndex={match ? 0 : undefined}
              aria-label={`GPS ${position.track_id}, ${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}${
                match ? `, kutu eşleşmesi ${match.distance_m.toFixed(1)} metre` : ', eşleşen kutu yok'
              }`}
              onClick={(event) => { event.stopPropagation(); activate(); }}
              onKeyDown={(event) => {
                if (match && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  activate();
                }
              }}
            >
              <circle
                cx={x}
                cy={y}
                r={selected ? radius + 3 : radius}
                fill="#ffec3d"
                stroke={match ? '#00d8e6' : '#fc3030'}
                strokeWidth={Math.max(2, frame.width_px / 600)}
              />
              <line x1={x - radius - 3} y1={y} x2={x + radius + 3} y2={y} stroke="#111827" strokeWidth="1.5" />
              <line x1={x} y1={y - radius - 3} x2={x} y2={y + radius + 3} stroke="#111827" strokeWidth="1.5" />
              {!compact && (
                <>
                  <rect x={labelX} y={labelY} width={labelWidth} height={fontSize + 6} rx="2" fill={match ? '#103746' : '#702121'} />
                  <text x={labelX + 5} y={labelY + fontSize + 1} fontSize={fontSize} fontWeight="700" fill="#ffffff">
                    {label}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>

      <div className="camera__label">
        {frame.image_id} · İHA · {frame.capture_hhmm}
      </div>

      {!evaluated && !selectedDetection && (
        <div className="camera__hint">
          <span className="camera__hint-text">{T.modal.cameraBeforeEval}</span>
        </div>
      )}

      {selectedDetection && !compact && (
        <div className="camera__selection" role="status">
          <b>{selectedMatch?.track_id ?? 'İzsiz tespit'} · {classLabel(selectedDetection.cls)} {fmt.percent(selectedDetection.score)}</b>
          {selectedPosition && selectedMatch && (
            <span>GPS {selectedPosition.lat.toFixed(6)}, {selectedPosition.lon.toFixed(6)} · kutu farkı {selectedMatch.distance_m.toFixed(1)} m</span>
          )}
        </div>
      )}

      {!compact && (
        <div className="camera__legend">
          <span>GPS {visiblePositions.length} · eşleşen {visiblePositions.filter((p) => matchesByTrack.has(p.track_id)).length} · kutusuz {visiblePositions.filter((p) => !matchesByTrack.has(p.track_id)).length} · kare dışında {positions.length - visiblePositions.length}</span>
          {evaluated && <span>{T.modal.boxLegendSafe} · {T.modal.boxLegendSuspect} · {T.modal.boxLegendThreat}</span>}
          {evaluated && <Switch checked={showSuppressed} onChange={onShowSuppressed} label={`bastırılanları göster (${dropped.length})`} />}
        </div>
      )}
    </div>
  );
});
