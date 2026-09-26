import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FrameDetail } from '@/domain/types';
import { CameraFrame } from './CameraFrame';

const frame = {
  image_id: 'img_test',
  capture_hhmm: '14:10',
  width_px: 960,
  height_px: 540,
  gsd_x_m: 0.12,
  gsd_y_m: 0.12,
  footprint_enu: [],
  funnel: null,
  detections: [
    {
      det_id: 'img_test#001',
      cls: 'car',
      score: 0.92,
      bbox_px: [90, 80, 130, 110],
      center_px: [110, 95],
      area_m2: 10,
      enu: { e_m: 0, n_m: 0 },
      kept: true,
      drop_reason: null,
      suppressed_by: null,
    },
  ],
  matches: [{ track_id: 'T0001', det_id: 'img_test#001', distance_m: 0.6, confidence: 'high' }],
  track_positions: [
    { track_id: 'T0001', lat: 39.925, lon: 32.871, pixel: [108, 94], in_frame: true },
    { track_id: 'T0002', lat: 39.924, lon: 32.872, pixel: [400, 220], in_frame: true },
    { track_id: 'T0003', lat: 39.923, lon: 32.873, pixel: [1000, 550], in_frame: false },
  ],
  track_states: [],
  zone_assessments: {},
  untracked: [],
  expected_not_seen: [],
  alerts: [],
  reports: [],
  brief: { source: 'rules', image_summary: '', assessments: [] },
  bundle: null,
} satisfies FrameDetail;

describe('CameraFrame tracking overlay', () => {
  it('shows GPS IDs and kept boxes before assessment while excluding out-of-frame fixes', () => {
    const onSelectDetection = vi.fn();
    const { container } = render(
      <CameraFrame
        frame={frame}
        imageUrl={null}
        evaluated={false}
        selectedDetId={null}
        showSuppressed={false}
        onShowSuppressed={() => {}}
        onSelectDetection={onSelectDetection}
      />,
    );

    expect(screen.getByRole('group', { name: '1 tespit kutusu, 2 GPS konumu' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /GPS T0001/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /GPS T0002/ })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /GPS T0003/ })).toBeNull();
    expect(container.querySelectorAll('.camera__box')).toHaveLength(1);
    expect(container.querySelectorAll('.camera__gps-link')).toHaveLength(1);
    expect(document.body.textContent).toContain('kare dışında 1');

    fireEvent.click(screen.getByRole('button', { name: /GPS T0001/ }));
    expect(onSelectDetection).toHaveBeenCalledWith('img_test#001');
  });
});
