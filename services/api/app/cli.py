"""Goru command line: run the pipeline and the agents over the real dataset.

    python -m app.cli data-report              # reproduce every measured number
    python -m app.cli detections img_000860    # the detection funnel for one image
    python -m app.cli bundle img_000860        # the agent's input, as JSON
    python -m app.cli assess img_000860        # the agent's verdict for one image
    python -m app.cli assess-all --limit 5     # warm the cache, log cost and latency
    python -m app.cli parse-reports            # LLM pass over unclassified reports
    python -m app.cli ask "why is T0187 red?"  # reviewer copilot
    python -m app.cli budget                   # spend against the $15 cap
    python -m app.cli smoke                    # gateway reachability and key info

Nothing here needs a network except `assess`, `parse-reports`, `ask` and `smoke`,
and those degrade to the deterministic baseline when the gateway is unavailable.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Sequence

# Allow `python services/api/app/cli.py` as well as `python -m app.cli`.
_ROOT = Path(__file__).resolve().parents[3]
for _path in (str(_ROOT / "libs"), str(_ROOT / "services" / "api")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from goru_core.config import Config, load_config  # noqa: E402
from goru_core.schemas import Level  # noqa: E402

from app.agents.assessor import ImageAssessorPolicy, apply_assessment_to_alerts  # noqa: E402
from app.agents.copilot import ReviewerCopilot  # noqa: E402
from app.agents.factory import build_agent_stack  # noqa: E402
from app.agents.report_parser import (  # noqa: E402
    ReportParsePayload,
    ReportParserPolicy,
    merge_parse,
    needs_llm_parse,
)
from app.agents.tools import ReadOnlyTools  # noqa: E402
from app.evidence.bundle import bundle_hash  # noqa: E402
from app.ingest.loaders import Dataset, load_dataset  # noqa: E402
from app.llm.port import ChatRequest  # noqa: E402
from app.pipeline import Pipeline  # noqa: E402


def _load(args: argparse.Namespace) -> tuple[Config, Dataset, Pipeline]:
    cfg = load_config(args.config)
    dataset = load_dataset(cfg)
    errors = [i for i in dataset.issues if i.severity == "error"]
    if errors and not args.allow_errors:
        print(f"{len(errors)} validation error(s); refusing to run. First few:", file=sys.stderr)
        for issue in errors[:10]:
            print(f"  {issue.file} {issue.pointer} [{issue.rule}] {issue.message}", file=sys.stderr)
        print("Re-run with --allow-errors to proceed anyway.", file=sys.stderr)
        raise SystemExit(2)
    return cfg, dataset, Pipeline(dataset, cfg)


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #


def cmd_data_report(args: argparse.Namespace) -> int:
    """Recompute every figure PLAN 2 claims, from the shipped files."""
    cfg, dataset, pipeline = _load(args)
    started = time.perf_counter()
    analyses = pipeline.analyse_all()
    elapsed = time.perf_counter() - started

    census = dataset.census()
    funnel = {
        "raw": sum(a.postprocess.raw for a in analyses),
        "after_score": sum(a.postprocess.after_score for a in analyses),
        "after_nms": sum(a.postprocess.after_nms for a in analyses),
        "kept": sum(a.postprocess.kept for a in analyses),
        "dropped_area": sum(a.postprocess.dropped_area for a in analyses),
    }
    class_mix: dict[str, int] = {}
    for analysis in analyses:
        for cls, count in analysis.postprocess.class_mix.items():
            class_mix[cls] = class_mix.get(cls, 0) + count

    zone_ring = [
        {
            "zone_id": zone.zone_id,
            "name": zone.name,
            "range_m": round((zone.center_enu.e_m**2 + zone.center_enu.n_m**2) ** 0.5, 1),
            "bearing_deg": round(
                (__import__("math").degrees(__import__("math").atan2(zone.center_enu.e_m, zone.center_enu.n_m)) + 360)
                % 360,
                1,
            ),
            "radius_m": zone.radius_m,
            "buffer_m": zone.buffer_m,
        }
        for zone in dataset.zones
    ]

    golden_image = dataset.footprints.get("img_000860")
    golden = None
    if golden_image is not None:
        lat, lon = golden_image.pixel_to_latlon(480, 270)
        golden = {
            "image": "img_000860",
            "pixel": [480, 270],
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "gsd_x_m": round(golden_image.gsd_x_m, 4),
            "gsd_y_m": round(golden_image.gsd_y_m, 4),
        }

    report_forms = {
        "coordinates": sum(1 for r in dataset.reports if r.parsed.geo is not None),
        "zone_name_only": sum(
            1 for r in dataset.reports if r.parsed.geo is None and r.parsed.zone_ref is not None
        ),
        "no_location": sum(
            1 for r in dataset.reports if r.parsed.geo is None and r.parsed.zone_ref is None
        ),
        "needs_llm_parse": sum(1 for r in dataset.reports if needs_llm_parse(r)),
    }
    report_kinds: dict[str, int] = {}
    for report in dataset.reports:
        report_kinds[report.parsed.kind] = report_kinds.get(report.parsed.kind, 0) + 1

    alerts_by_level: dict[str, int] = {}
    for analysis in analyses:
        for alert in analysis.alerts:
            alerts_by_level[alert.level.value] = alerts_by_level.get(alert.level.value, 0) + 1

    contradictions = [
        {
            "image_id": analysis.image.image_id,
            "report_id": report.report_id,
            "kind": report.parsed.kind,
            "note": report.consistency_note,
            "text": report.text,
        }
        for analysis in analyses
        for report in analysis.reports
        if report.consistency == "contradicts"
    ]
    unique_contradictions = {c["report_id"]: c for c in contradictions}

    payload = {
        "config": {
            "thresholds_version": cfg.thresholds_version,
            "rules_version": cfg.rules_version,
            "score_threshold": cfg.detection.score_threshold,
            "nms_iou": cfg.detection.nms_iou,
            "min_area_m2": cfg.detection.min_area_m2,
            "gate_m": cfg.matching.gate_m,
            "zone_radius_m": cfg.zones.default_radius_m,
            "zone_buffer_m": cfg.zones.default_buffer_m,
        },
        "census": census,
        "validation": {
            "errors": len([i for i in dataset.issues if i.severity == "error"]),
            "warnings": len([i for i in dataset.issues if i.severity == "warning"]),
            "warning_rules": sorted({i.rule for i in dataset.issues if i.severity == "warning"}),
        },
        "detection_funnel": funnel,
        "detection_class_mix": dict(sorted(class_mix.items())),
        "golden_pixel": golden,
        "zone_ring": zone_ring,
        "track_capture_alignment": {
            "capture_times": len({m.capture_ts for m in dataset.images.values()}),
            "track_end_times": len({pts[-1].ts for pts in dataset.tracks.values() if pts}),
            "aligned": {m.capture_ts for m in dataset.images.values()}
            == {pts[-1].ts for pts in dataset.tracks.values() if pts},
            "group_sizes": sorted(
                {len(dataset.tracks_ending_at(m.capture_ts)) for m in dataset.images.values()}
            ),
        },
        "matching": pipeline.match_quality(analyses).as_dict(),
        "reports": {"location_forms": report_forms, "kinds": dict(sorted(report_kinds.items()))},
        "baseline_alerts": alerts_by_level,
        "report_contradictions": list(unique_contradictions.values()),
        "timing": {
            "images": len(analyses),
            "total_s": round(elapsed, 3),
            "ms_per_image": round(1000 * elapsed / max(1, len(analyses)), 1),
        },
    }
    print(json.dumps(payload, indent=2, default=str))
    return 0


def cmd_detections(args: argparse.Namespace) -> int:
    _cfg, _dataset, pipeline = _load(args)
    analysis = pipeline.analyse_image(args.image_id)
    post = analysis.postprocess
    print(f"{args.image_id}: {json.dumps(post.as_dict(), indent=2)}")
    print("\nkept detections:")
    for detection in analysis.kept_detections:
        track = analysis.match.track_by_det.get(detection.det_id) if analysis.match else None
        print(
            f"  {detection.det_id}  {detection.cls:<5} score {detection.score:.3f}  "
            f"area {detection.area_m2:6.2f} m2  "
            f"geo {detection.center_geo.lat:.6f},{detection.center_geo.lon:.6f}  "
            f"-> {track or 'unmatched'}"
        )
    if analysis.untracked:
        print("\nunmatched detections:")
        for untracked in analysis.untracked:
            label = (
                f"probable duplicate of {untracked.likely_duplicate_of}"
                if untracked.likely_duplicate_of
                else "untracked object"
            )
            print(
                f"  {untracked.det_id}  {untracked.cls:<5} nearest track "
                f"{untracked.nearest_track_id} at {untracked.nearest_track_dist_m} m  [{label}]"
            )
    if analysis.match and analysis.match.expected_not_seen:
        print("\nexpected but not seen:")
        for track_id, reason, distance in analysis.match.expected_not_seen:
            print(f"  {track_id}  {reason}  {distance:.0f} m from the footprint")
    return 0


def cmd_bundle(args: argparse.Namespace) -> int:
    _cfg, _dataset, pipeline = _load(args)
    bundle = pipeline.bundle_for(args.image_id)
    text = bundle.model_dump_json(indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(text)} chars, hash {bundle_hash(bundle)[:16]})")
    else:
        print(text)
    return 0


def cmd_assess(args: argparse.Namespace) -> int:
    cfg, dataset, pipeline = _load(args)
    stack = build_agent_stack(cfg, interactive=True)
    print(stack.describe(), file=sys.stderr)

    analysis = pipeline.analyse_image(args.image_id)
    bundle = pipeline.bundle_of(analysis)
    policy = ImageAssessorPolicy(cfg=cfg)

    started = time.perf_counter()
    outcome = stack.runner.run(policy, bundle, interactive=True)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    alerts = apply_assessment_to_alerts(
        analysis.alerts,
        outcome.value,
        bundle=bundle,
        run_id=outcome.run.run_id,
        dissents=outcome.extra.get("dissents"),
        fallback_used=outcome.run.fallback_used,
        ts=analysis.as_of,
        rules_version=cfg.rules_version,
    )

    print(f"\n=== {args.image_id} at {bundle.image.capture_hhmm} ===")
    print(
        f"run {outcome.run.run_id}  model {outcome.run.model}  "
        f"{'FALLBACK (template)' if outcome.run.fallback_used else 'model answer'}  "
        f"tokens {outcome.run.prompt_tokens}/{outcome.run.completion_tokens}  "
        f"cost ${outcome.run.cost_usd:.5f}  {elapsed_ms} ms"
        f"{'  [cached]' if outcome.run.from_cache else ''}"
    )
    if outcome.run.problems:
        print("problems:")
        for problem in outcome.run.problems:
            print(f"  - {problem}")

    print(f"\nsummary: {outcome.value.image_summary}")
    print("\nassessments:")
    for item in sorted(outcome.value.assessments, key=lambda a: (-a.level.rank, a.track_id)):
        baseline = bundle.baseline_for(item.track_id)
        flag = "" if item.level is baseline else f"  (baseline {baseline.value})"
        print(f"  {item.track_id}  {item.level.value:<5} attention={item.needs_attention}{flag}")
        for line in item.rationale:
            print(f"      - {line}")
        if item.cited_ids:
            print(f"      cites: {', '.join(item.cited_ids)}")
        for conflict in item.report_conflicts:
            print(f"      conflict {conflict.report_id}: {conflict.why}")

    print("\nalerts on screen:")
    for alert in alerts:
        print(
            f"  {alert.level.value:<5} {alert.track_id}  priority {alert.priority:.2f}  "
            f"source {alert.source}  baseline {alert.baseline_level.value}"
            f"  agent {alert.agent_level.value if alert.agent_level else '-'}"
        )
        if alert.agent_dissent:
            print(f"      dissent: {alert.agent_dissent}")
    return 0


def cmd_assess_all(args: argparse.Namespace) -> int:
    cfg, dataset, pipeline = _load(args)
    stack = build_agent_stack(cfg, interactive=False)
    print(stack.describe(), file=sys.stderr)

    policy = ImageAssessorPolicy(cfg=cfg)
    analyses = pipeline.analyse_all()
    if args.limit:
        analyses = analyses[: args.limit]

    rows = []
    for analysis in analyses:
        bundle = pipeline.bundle_of(analysis)
        started = time.perf_counter()
        outcome = stack.runner.run(policy, bundle)
        rows.append(
            {
                "image_id": analysis.image.image_id,
                "vehicles": len(bundle.vehicles),
                "valid": outcome.run.valid,
                "fallback": outcome.run.fallback_used,
                "cached": outcome.run.from_cache,
                "attempts": outcome.run.attempts,
                "prompt_tokens": outcome.run.prompt_tokens,
                "completion_tokens": outcome.run.completion_tokens,
                "cost_usd": outcome.run.cost_usd,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "needs_attention": sum(1 for a in outcome.value.assessments if a.needs_attention),
                "problems": outcome.run.problems[:3],
            }
        )
        print(
            f"{analysis.image.image_id}  vehicles {len(bundle.vehicles):2d}  "
            f"{'FALLBACK' if outcome.run.fallback_used else 'ok      '}  "
            f"${outcome.run.cost_usd:.5f}  {rows[-1]['latency_ms']:5d} ms"
            f"{'  cached' if outcome.run.from_cache else ''}",
            file=sys.stderr,
        )

    valid = sum(1 for r in rows if r["valid"])
    summary = {
        "images": len(rows),
        "model_answers": valid,
        "fallbacks": sum(1 for r in rows if r["fallback"]),
        "cache_hits": sum(1 for r in rows if r["cached"]),
        "schema_valid_rate": round(valid / len(rows), 4) if rows else 0.0,
        "total_cost_usd": round(sum(r["cost_usd"] for r in rows), 6),
        "cost_per_image_usd": round(sum(r["cost_usd"] for r in rows) / len(rows), 6) if rows else 0.0,
        "median_latency_ms": sorted(r["latency_ms"] for r in rows)[len(rows) // 2] if rows else 0,
        "budget": stack.budget.snapshot().as_dict(),
        "rows": rows,
    }
    print(json.dumps(summary, indent=2))
    return 0


def cmd_parse_reports(args: argparse.Namespace) -> int:
    cfg, dataset, _pipeline = _load(args)
    stack = build_agent_stack(cfg, interactive=False)
    print(stack.describe(), file=sys.stderr)

    policy = ReportParserPolicy(cfg=cfg)
    candidates = [r for r in dataset.reports if needs_llm_parse(r)]
    if args.limit:
        candidates = candidates[: args.limit]
    print(f"{len(candidates)} report(s) the rules could not classify", file=sys.stderr)

    changed = 0
    for report in candidates:
        payload = ReportParsePayload(report=report, zones=tuple(dataset.zones))
        outcome = stack.runner.run(policy, payload)
        merged = merge_parse(
            report, outcome.value, dataset.zones, from_model=not outcome.run.fallback_used
        )
        if merged.parsed.kind != report.parsed.kind or merged.parsed.zone_ref != report.parsed.zone_ref:
            changed += 1
        print(
            f"  {report.report_id}  {report.parsed.kind:>18} -> {merged.parsed.kind:<18} "
            f"conf {merged.parse_conf:.2f}  "
            f"{'FALLBACK' if outcome.run.fallback_used else ''}  {report.text[:70]}"
        )
    print(f"\n{changed} of {len(candidates)} reclassified", file=sys.stderr)
    print(json.dumps(stack.budget.snapshot().as_dict(), indent=2))
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    cfg, dataset, pipeline = _load(args)
    stack = build_agent_stack(cfg, interactive=True)
    print(stack.describe(), file=sys.stderr)

    analyses = pipeline.analyse_all()
    tools = ReadOnlyTools(
        analyses=analyses,
        zone_names={z.zone_id: z.name for z in dataset.zones},
        cfg=cfg,
    )
    copilot = ReviewerCopilot(stack.runner, cfg, tools)
    answer = copilot.ask(args.question)

    print(f"\n{answer.text}\n")
    if answer.tool_calls:
        print("tools used:", ", ".join(name for name, _ in answer.tool_calls), file=sys.stderr)
    if answer.citations:
        print("citations:", ", ".join(answer.citations), file=sys.stderr)
    if answer.unverified_citations:
        print("UNVERIFIED citations:", ", ".join(answer.unverified_citations), file=sys.stderr)
    if answer.run:
        print(
            f"cost ${answer.run.cost_usd:.5f}  {answer.run.latency_ms} ms  "
            f"{answer.run.attempts} model call(s)",
            file=sys.stderr,
        )
    return 0


def cmd_budget(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    stack = build_agent_stack(cfg)
    snapshot = stack.budget.snapshot()
    info = stack.gateway.key_info() if stack.live else None
    if info is not None:
        stack.budget.reconcile(info.spend_usd)
        snapshot = stack.budget.snapshot()
    print(
        json.dumps(
            {
                "mode": stack.mode,
                "reason": stack.reason,
                "model": stack.gateway.model,
                "cached_responses": len(stack.cache),
                "ledger": snapshot.as_dict(),
                "gateway_key_info": None
                if info is None
                else {
                    "spend_usd": info.spend_usd,
                    "max_budget_usd": info.max_budget_usd,
                    "remaining_usd": info.remaining_usd,
                    "models": list(info.models),
                    "key_alias": info.key_alias,
                },
            },
            indent=2,
        )
    )
    return 0


def cmd_smoke(args: argparse.Namespace) -> int:
    """PLAN task M0.3: prove the key works and record the starting spend."""
    cfg = load_config(args.config)
    stack = build_agent_stack(cfg, interactive=True)
    print(stack.describe())
    if not stack.live:
        print(f"\nCannot smoke-test: {stack.reason}")
        print("Put the key in .env as GLM_API_KEY=... and run again.")
        return 1

    info = stack.gateway.key_info()
    if info is None:
        print("\nGET /key/info did not answer; the gateway may be unreachable.")
    else:
        stack.budget.reconcile(info.spend_usd)
        print(
            f"\nkey/info: spend ${info.spend_usd} of ${info.max_budget_usd} "
            f"(remaining ${info.remaining_usd}), models {list(info.models)}"
        )

    print(f"\nsending one tiny completion to {cfg.agents.model} ...")
    request = ChatRequest(
        messages=[
            {"role": "system", "content": "Reply with exactly one word."},
            {"role": "user", "content": "Say READY."},
        ],
        max_tokens=1500,  # must cover thinking (PLAN 6.11)
        reasoning_effort="low",
        purpose="assess",
    )
    started = time.perf_counter()
    result = stack.runner.complete(request, interactive=True)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    print(f"answer: {result.text!r}")
    print(f"thinking returned separately: {len(result.reasoning)} chars")
    print(
        f"finish_reason {result.finish_reason}  tokens {result.prompt_tokens}/"
        f"{result.completion_tokens}  {elapsed_ms} ms  schema_mode {result.schema_mode}"
    )
    print(json.dumps(stack.budget.snapshot().as_dict(), indent=2))
    return 0


# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="goru", description=__doc__.split("\n")[0])
    parser.add_argument("--config", default=str(_ROOT / "goru.yaml"), help="path to goru.yaml")
    parser.add_argument(
        "--allow-errors",
        action="store_true",
        help="run even when intake validation reported errors",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("data-report", help="recompute every measured number").set_defaults(
        func=cmd_data_report
    )

    p = sub.add_parser("detections", help="the detection funnel for one image")
    p.add_argument("image_id")
    p.set_defaults(func=cmd_detections)

    p = sub.add_parser("bundle", help="the agent's evidence bundle for one image")
    p.add_argument("image_id")
    p.add_argument("--out", help="write to this file instead of stdout")
    p.set_defaults(func=cmd_bundle)

    p = sub.add_parser("assess", help="run the assessment agent on one image")
    p.add_argument("image_id")
    p.set_defaults(func=cmd_assess)

    p = sub.add_parser("assess-all", help="assess every image; warms the cache")
    p.add_argument("--limit", type=int, default=0, help="only the first N images")
    p.set_defaults(func=cmd_assess_all)

    p = sub.add_parser("parse-reports", help="LLM pass over reports the rules could not classify")
    p.add_argument("--limit", type=int, default=0)
    p.set_defaults(func=cmd_parse_reports)

    p = sub.add_parser("ask", help="ask the reviewer copilot a question")
    p.add_argument("question")
    p.set_defaults(func=cmd_ask)

    sub.add_parser("budget", help="spend against the cap").set_defaults(func=cmd_budget)
    sub.add_parser("smoke", help="gateway reachability and key info").set_defaults(func=cmd_smoke)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
