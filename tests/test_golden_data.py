"""Golden tests over the shipped data (PLAN.md 10.1).

Each assertion here is a number PLAN 2 measured. If one fails, either the data
changed or PLAN is wrong about it - both are worth stopping for.

Where a figure below differs from PLAN, the deviation is stated in the test's own
comment together with what was measured, so the disagreement is documented rather
than quietly accommodated.
"""

from __future__ import annotations

import math

from goru_core.geo import m_per_deg
from goru_core.predstring import parse_prediction_string


def test_dataset_census(dataset):
    census = dataset.census()
    assert census["images"] == 40
    assert census["raw_boxes"] == 17_394
    assert census["tracks"] == 226
    assert census["track_point_counts"] == [25]
    assert census["reports"] == 137
    assert census["reports_official"] == 98
    assert census["reports_third_party"] == 39
    assert census["zones"] == 8


def test_no_validation_errors(dataset):
    errors = [i for i in dataset.issues if i.severity == "error"]
    assert errors == [], f"unexpected validation errors: {errors[:3]}"


def test_resolution_census(dataset):
    census = dataset.census()
    assert census["resolutions"] == {"1360x765": 19, "1920x1080": 5, "960x540": 16}


def test_gsd_span(dataset):
    census = dataset.census()
    assert math.isclose(census["gsd_x_min"], 0.1084, abs_tol=5e-4)
    assert math.isclose(census["gsd_x_max"], 0.1987, abs_tol=5e-4)


def test_metres_per_degree_at_base():
    """PLAN 2.2 publishes this pair; it must be computed, not hardcoded."""
    m_lat, m_lon = m_per_deg(39.92184)
    assert math.isclose(m_lat, 111_033.1, abs_tol=0.5)
    assert math.isclose(m_lon, 85_491.2, abs_tol=0.5)


def test_golden_pixel_to_geo(dataset):
    footprint = dataset.footprints["img_000860"]
    lat, lon = footprint.pixel_to_latlon(480, 270)
    assert math.isclose(lat, 39.925348, abs_tol=1e-6)
    assert math.isclose(lon, 32.871430, abs_tol=1e-6)


def test_golden_image_gsd(dataset):
    footprint = dataset.footprints["img_000860"]
    assert math.isclose(footprint.gsd_x_m, 0.1248, abs_tol=5e-4)
    assert math.isclose(footprint.gsd_y_m, 0.1246, abs_tol=5e-4)
    assert abs(footprint.gsd_x_m - footprint.gsd_y_m) / footprint.gsd_y_m < 0.05


def test_worst_gsd_disagreement_under_one_percent(dataset):
    """A swapped [lat, lon] pair would disagree by orders of magnitude (A5)."""
    worst = max(
        abs(fp.gsd_x_m - fp.gsd_y_m) / fp.gsd_y_m for fp in dataset.footprints.values()
    )
    assert worst < 0.01


def test_prediction_string_parses_clean(dataset):
    total = 0
    for image_id, boxes in dataset.raw_boxes.items():
        total += len(boxes)
        assert boxes, f"{image_id} has no boxes"
    assert total == 17_394


def test_box_format_is_xywh(dataset):
    """Read as x,y,w,h there are no out-of-bounds boxes; as x1,y1,x2,y2 there are 17179."""
    as_xywh = 0
    as_xyxy = 0
    for image_id, boxes in dataset.raw_boxes.items():
        meta = dataset.images[image_id]
        for box in boxes:
            if box.x + box.w > meta.width_px + 1 or box.y + box.h > meta.height_px + 1:
                as_xywh += 1
            if box.w <= box.x or box.h <= box.y or box.w > meta.width_px + 1 or box.h > meta.height_px + 1:
                as_xyxy += 1
    assert as_xywh == 0
    assert as_xyxy == 17_179


def test_prediction_string_rejects_trailing_tokens():
    import pytest

    from goru_core.predstring import PredictionStringError

    with pytest.raises(PredictionStringError) as excinfo:
        parse_prediction_string("car 0.9 1 2 3 4 truck 0.8 5")
    assert excinfo.value.rule == "predictionstring.token_count"
    assert excinfo.value.index == 1


def test_score_distribution(dataset):
    scores = sorted(box.score for boxes in dataset.raw_boxes.values() for box in boxes)
    assert math.isclose(scores[0], 0.00050, abs_tol=1e-5)
    assert math.isclose(scores[len(scores) // 2], 0.00645, abs_tol=1e-4)
    assert math.isclose(scores[-1], 0.93365, abs_tol=1e-5)
    assert sum(1 for s in scores if s >= 0.5) == 187


def test_class_mix_of_all_boxes(dataset):
    mix: dict[str, int] = {}
    for boxes in dataset.raw_boxes.values():
        for box in boxes:
            mix[box.cls] = mix.get(box.cls, 0) + 1
    assert mix == {"car": 9_964, "van": 2_992, "truck": 2_919, "bus": 1_519}


def test_zone_ring(dataset):
    """All 8 zones on a ~3.2 km ring at 45 degree steps (A9)."""
    bearings = []
    for zone in dataset.zones:
        east, north = zone.center_enu.e_m, zone.center_enu.n_m
        distance = math.hypot(east, north)
        assert 3_190.0 <= distance <= 3_206.0, f"{zone.name} at {distance:.0f} m"
        bearings.append((math.degrees(math.atan2(east, north)) + 360) % 360)
    for bearing in sorted(bearings):
        nearest = round(bearing / 45.0) * 45.0
        assert abs(bearing - nearest) < 0.2, f"bearing {bearing} is not a 45 degree step"


def test_named_zones_are_ascii_folded(dataset):
    names = {z.name for z in dataset.zones}
    assert "Kuzeydogu Kavsagi" in names
    assert "Guney Kapisi Yaklasimi" in names
    assert dataset.base_name == "Merkez Us"


def test_track_end_times_equal_capture_times(dataset):
    """A11: each image's vehicles are the tracks whose window ends at its capture."""
    capture_times = {meta.capture_ts for meta in dataset.images.values()}
    end_times = {points[-1].ts for points in dataset.tracks.values() if points}
    assert end_times == capture_times
    assert len(capture_times) == 40

    group_sizes = [len(dataset.tracks_ending_at(ts)) for ts in capture_times]
    assert min(group_sizes) == 3
    assert max(group_sizes) == 10
    assert sum(group_sizes) == 226


def test_track_windows_are_two_hours(dataset):
    for track_id, points in dataset.tracks.items():
        assert len(points) == 25, track_id
        span_min = (points[-1].ts - points[0].ts).total_seconds() / 60.0
        assert span_min == 120.0, track_id


def test_report_location_forms(dataset):
    coords = sum(1 for r in dataset.reports if r.parsed.geo is not None)
    zone_only = sum(
        1 for r in dataset.reports if r.parsed.geo is None and r.parsed.zone_ref is not None
    )
    nowhere = sum(1 for r in dataset.reports if r.parsed.geo is None and r.parsed.zone_ref is None)
    assert (coords, zone_only, nowhere) == (72, 43, 22)
