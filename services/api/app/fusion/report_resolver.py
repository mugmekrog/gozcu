"""Field reports checked against our own data (PLAN.md 6.8; team decision 2026-09-27).

The brief: some reports are right, some wrong or irrelevant, and none is marked;
compare them with your own findings and trust your detection where they differ.
The team's rule on top: no source is trusted - an `official` label grants nothing a
`third_party` one does not. A report counts for what our own data confirms, and it
never changes a level: the level comes from the data, a confirmed report adds
confidence to it, and a contradicted or unverifiable one goes to the human.

How the shipped reports are written, measured over the 72 located ones: their
coordinates are where the vehicle stands in the image it belongs to - 33 lie within
2 m of a track's position at that image's capture, against 1 within 2 m of any
track at the report's own time - and each is filed up to two hours before that
capture, inside the window the image's tracks cover. The brief's own worked
example compares the report with the detection the same way. So, per image:

1. relevance - filed in the two hours before capture, and located in the image's
   footprint (plus the gate), naming the image's own observation sector, or
   un-located context. Every located report lands in exactly one image.
2. linkage   - the track nearest the coordinates at capture is the vehicle the
   report describes; the detections within the claim radius are the ones it counts.
3. checks    - type and count against those detections; stopped / moving / heading
   for the base / leaving against the described vehicle's own track around the
   report's time; density against what stands around the point; a sector claim
   against what this image saw of that sector.
4. verdict   - a failed check: contradicted. Otherwise a passed one: verified.
   Otherwise unverifiable. Weather, drills, rumours, radio outages: context.
5. scenario  - a contradicted or unverifiable claim becomes a hypothesis for the
   human, with what would settle it. The identity in a friendly claim can never be
   checked from the air, so it always goes to the human.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Mapping, Sequence

from goru_core.config import Config
from goru_core.geo import Footprint, Frame
from goru_core.schemas import ClaimCheck, Detection, FieldReport, Level, ParsedReport, TrackPoint

from app.fusion.matching import footprint_distance_m

__all__ = ["Scene", "resolve_reports", "report_cap"]

HEAVY = frozenset({"truck", "bus"})
CONTEXT_KINDS = frozenset({"irrelevant", "area_wide", "unverified", "degraded_coverage"})
# A motion claim is read over the fixes either side of the report's time.
MOTION_WINDOW = timedelta(minutes=10)
FIX_TOLERANCE = timedelta(minutes=5)
LABELS = {
    "car": "otomobil",
    "van": "minibüs/panelvan",
    "truck": "kamyon",
    "bus": "otobüs",
    "heavy": "ağır araç",
    "vehicle": "araç",
}


@dataclass(frozen=True)
class Scene:
    """What one image knows at its capture time - all a report is tested against."""

    as_of: datetime
    footprint: Footprint
    frame: Frame
    sector_id: str
    histories: Mapping[str, Sequence[TrackPoint]]  # this image's tracks, fixes up to capture
    detections: Sequence[Detection]  # kept detections in this image
    alarming: frozenset[str] = frozenset()  # tracks the data puts at ALERT


def report_cap(report: FieldReport) -> Level:
    """How far a report alone may raise a vehicle: not at all (team decision, 2026-09-27).

    A verified report agrees with data that already set the level, so it adds
    confidence rather than level; a contradicted or unverifiable one goes to the
    human as a scenario. Returning ``Level.WATCH`` when ``report.verdict ==
    "verified"`` would let a confirmed report put its vehicle on the watch list -
    this is the one line to change if that is ever wanted.
    """
    return Level.CLEAR


def resolve_reports(reports: Sequence[FieldReport], scene: Scene, cfg: Config) -> list[FieldReport]:
    """The reports that concern this image, each with its checks, verdict and scenario."""
    lookback = timedelta(minutes=cfg.matching.report_lookback_min)
    resolved: list[FieldReport] = []
    for report in reports:
        if not scene.as_of - lookback <= report.ts <= scene.as_of:
            continue
        result = _resolve(report, scene, cfg)
        if result is not None:
            resolved.append(result)
    return resolved


def _resolve(report: FieldReport, scene: Scene, cfg: Config) -> FieldReport | None:
    parsed = report.parsed
    if parsed.geo is not None:
        east, north = scene.frame.to_enu(parsed.geo.lat, parsed.geo.lon)
        if footprint_distance_m(scene.footprint, scene.frame, east, north) > cfg.matching.report_gate_m:
            return None
        if parsed.kind in CONTEXT_KINDS:
            return _context(report)
        return _located(report, east, north, scene, cfg)
    if parsed.zone_ref is not None:
        if parsed.zone_ref != scene.sector_id:
            return None
        if parsed.kind in CONTEXT_KINDS:
            return _context(report)
        return _sector(report, scene)
    if parsed.kind == "irrelevant":
        return None  # weather and the like: nothing to test and nothing to show
    return _context(report)


# --------------------------------------------------------------------------- #
# Located reports
# --------------------------------------------------------------------------- #


def _located(report: FieldReport, east: float, north: float, scene: Scene, cfg: Config) -> FieldReport:
    parsed = report.parsed
    radius = cfg.matching.report_claim_radius_m

    def distance(e: float, n: float) -> float:
        return math.hypot(e - east, n - north)

    near_tracks = sorted(
        (distance(points[-1].e_m, points[-1].n_m), track_id)
        for track_id, points in scene.histories.items()
        if points
    )
    near_tracks = [(d, t) for d, t in near_tracks if d <= cfg.matching.report_gate_m]
    around = [d for d in scene.detections if distance(d.center_enu.e_m, d.center_enu.n_m) <= radius]

    checks: list[ClaimCheck] = []
    if parsed.kind == "density":
        area = [
            d for d in scene.detections
            if distance(d.center_enu.e_m, d.center_enu.n_m) <= cfg.matching.report_gate_m
        ]
        usual = parsed.usual_count or 0
        checks.append(
            _check("density", len(area) > usual,
                   f"olağan {usual} araç denildi; {cfg.matching.report_gate_m:.0f} m içinde {len(area)} tespit var")
        )
    else:
        if not near_tracks and not around:
            checks.append(ClaimCheck(claim="presence", result="fail", note="çekimde konumda hiç araç yok"))
        checks.extend(_type_and_count(parsed, around, radius))
        if near_tracks and parsed.motion:
            described = near_tracks[0][1]
            checks.append(
                _motion(parsed, scene.histories[described], report.ts, cfg.kinematics.stationary_disp_m)
            )
        if parsed.friendly:
            checks.append(
                ClaimCheck(claim="identity", result="untestable",
                           note="kimlik havadan doğrulanamaz; insan teyidi gerekli")
            )
    return _finish(report, checks, [track_id for _, track_id in near_tracks][:3])


def _type_and_count(parsed: ParsedReport, around: Sequence[Detection], radius: float) -> list[ClaimCheck]:
    claimed = parsed.vehicle_type
    checks: list[ClaimCheck] = []
    if claimed in (None, "vehicle"):
        matching = list(around)
    elif not around:
        return [ClaimCheck(claim="type", result="untestable", note=f"{radius:.0f} m içinde tespit yok")]
    else:
        wanted = HEAVY if claimed == "heavy" else {claimed}
        matching = [d for d in around if d.cls in wanted]
        seen = ", ".join(sorted({LABELS[d.cls] for d in around}))
        checks.append(
            _check("type", bool(matching),
                   f"{LABELS.get(claimed, claimed)} bildirildi; {radius:.0f} m içinde görülen: {seen}")
        )
    if parsed.count and parsed.count > 1:
        checks.append(
            _check("count", len(matching) >= parsed.count,
                   f"{parsed.count} {LABELS.get(claimed or 'vehicle', claimed)} bildirildi; {len(matching)} görüldü")
        )
    return checks


def _motion(parsed: ParsedReport, history: Sequence[TrackPoint], ts: datetime, stationary_m: float) -> ClaimCheck:
    at = _fix_near(history, ts)
    if at is None:
        return ClaimCheck(claim="motion", result="untestable", note="rapor saatinde bu aracın kaydı yok")
    before = _fix_near(history, ts - MOTION_WINDOW) or at
    after = _fix_near(history, ts + MOTION_WINDOW) or at
    moved = math.hypot(after.e_m - before.e_m, after.n_m - before.n_m)
    closed = math.hypot(before.e_m, before.n_m) - math.hypot(after.e_m, after.n_m)

    if parsed.motion == "stopped":
        if parsed.still_for_min:
            still = _still_minutes(history, at, stationary_m)
            return _check("motion", still >= parsed.still_for_min,
                          f"en az {parsed.still_for_min} dk durduğu bildirildi; rapor saatinde {still:.0f} dk'dır duruyordu")
        return _check("motion", moved <= stationary_m,
                      f"durduğu bildirildi; rapor saati çevresinde {moved:.0f} m hareket etti")
    if parsed.motion == "moving":
        return _check("motion", moved > stationary_m,
                      f"hareket halinde bildirildi; rapor saati çevresinde {moved:.0f} m hareket etti")
    if parsed.motion == "toward_base":
        return _check("motion", closed > stationary_m,
                      f"üsse doğru ilerlediği bildirildi; rapor saati çevresinde üsse {closed:.0f} m yaklaştı")
    return _check("motion", -closed > stationary_m,  # receding
                  f"uzaklaştığı bildirildi; rapor saati çevresinde üsten {-closed:.0f} m uzaklaştı")


def _fix_near(history: Sequence[TrackPoint], target: datetime) -> TrackPoint | None:
    best = min(history, key=lambda p: abs(p.ts - target), default=None)
    return best if best is not None and abs(best.ts - target) <= FIX_TOLERANCE else None


def _still_minutes(history: Sequence[TrackPoint], at: TrackPoint, stationary_m: float) -> float:
    """How long the vehicle had stood within the stationary distance of where it was at `at`."""
    earliest = at
    for point in sorted((p for p in history if p.ts <= at.ts), key=lambda p: p.ts, reverse=True):
        if math.hypot(point.e_m - at.e_m, point.n_m - at.n_m) > stationary_m:
            break
        earliest = point
    return (at.ts - earliest.ts).total_seconds() / 60.0


# --------------------------------------------------------------------------- #
# Sector reports and context
# --------------------------------------------------------------------------- #


def _sector(report: FieldReport, scene: Scene) -> FieldReport:
    """A claim about a whole observation sector, tested on the part this image saw."""
    kind = report.parsed.kind
    seen = scene.detections
    checks: list[ClaimCheck] = []
    if kind == "negative_claim":
        if not seen:
            checks.append(ClaimCheck(claim="heavy_absent", result="untestable", note="bu karede araç yok"))
        else:
            heavy = sorted({LABELS[d.cls] for d in seen if d.cls in HEAVY})
            checks.append(
                _check("heavy_absent", not heavy,
                       "bu karenin gördüğü kısımda ağır araç yok" if not heavy
                       else f"ağır araç yok denildi; bu karede {', '.join(heavy)} var")
            )
    elif kind == "zone_status":
        if scene.alarming:
            ids = ", ".join(sorted(scene.alarming))
            checks.append(ClaimCheck(claim="calm", result="fail",
                                     note=f"sektör olağan denildi; bu karede yüksek ihtimalli tehdit var ({ids})"))
        elif seen:
            checks.append(ClaimCheck(claim="calm", result="pass",
                                     note="bu karenin gördüğü kısımda olağandışı bir şey yok"))
        else:
            checks.append(ClaimCheck(claim="calm", result="untestable", note="bu karede araç yok"))
    else:
        checks.append(ClaimCheck(claim="location", result="untestable",
                                 note="konum yalnızca sektör adı; araç düzeyinde test edilemez"))
    return _finish(report, checks, [])


def _context(report: FieldReport) -> FieldReport:
    return report.model_copy(
        update={"verdict": "context", "checks": [], "consistency": None, "consistency_note": None,
                "scenario": None, "matched_track_ids": [], "needs_identity_check": False}
    )


# --------------------------------------------------------------------------- #
# Verdict and scenario
# --------------------------------------------------------------------------- #


def _check(claim: str, passed: bool, note: str) -> ClaimCheck:
    return ClaimCheck(claim=claim, result="pass" if passed else "fail", note=note)


def _finish(report: FieldReport, checks: list[ClaimCheck], linked: list[str]) -> FieldReport:
    results = {check.result for check in checks}
    verdict = "contradicted" if "fail" in results else "verified" if "pass" in results else "unverifiable"
    failed = [c.note for c in checks if c.result == "fail"]
    passed = [c.note for c in checks if c.result == "pass"]
    note = "; ".join(failed or passed or [c.note for c in checks]) or None
    return report.model_copy(
        update={
            "verdict": verdict,
            "checks": checks,
            "matched_track_ids": linked,
            "consistency": {"verified": "agrees", "contradicted": "contradicts"}.get(verdict, "unrelated"),
            "consistency_note": note,
            "scenario": _scenario(report, verdict, failed, checks),
            "needs_identity_check": report.parsed.friendly,
        }
    )


def _scenario(report: FieldReport, verdict: str, failed: list[str], checks: list[ClaimCheck]) -> str | None:
    if report.parsed.friendly:
        if verdict == "contradicted":
            return (f"Dost iddiası verimizle çelişiyor ({'; '.join(failed)}). Araç iddia edilen araç "
                    "olmayabilir; kimliği insan teyit etmeli, iddia hiçbir seviyeyi düşürmez.")
        return "Dost iddiası: kimlik havadan doğrulanamaz; insan teyit etmeli. İddia hiçbir seviyeyi düşürmez."
    if verdict == "contradicted":
        return (f"Rapor verimizle çelişiyor: {'; '.join(failed)}. Rapor hatalı olabilir ya da başka "
                "araçları anlatıyor; tespit esas alınır.")
    if verdict == "unverifiable":
        reasons = "; ".join(c.note for c in checks) or "test edilebilir bir iddia yok"
        return f"Doğrulanamadı: {reasons}. Konum bir sonraki gözlemde kontrol edilmeli."
    return None
