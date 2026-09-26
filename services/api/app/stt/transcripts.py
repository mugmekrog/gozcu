"""The transcript manager and the domain normaliser (stt.md phases 5 and 9).

Two jobs that stt.md separates and that really are separate.

**Phase 5, the boundary.** The router must not consume raw STT events. This module
cleans whitespace, normalises the punctuation Whisper sprinkles on short commands,
refuses what should not travel, and attaches the metadata. A refusal is a
`TranscriptRejected` value, never a quiet `None`: stt.md is explicit that empty or
invalid text must not reach the agent, and the operator is owed the difference
between "I heard nothing" and "speech recognition is down".

**Phase 9, the vocabulary.** stt.md's example list is GitHub, Docker, CUDA. Ours
is not that. The words this system fails on are its own identifiers -
``T0132``, ``img_000860``, ``Z03``, ``R137`` - and no acoustic model returns them
in that form. An operator says *"te sifir yuz otuz iki"* and Whisper writes
"te sıfır yüz otuz iki", or "T 0132", or "t0132". All three mean the same track,
and the display can only select a vehicle if they arrive as `T0132`.

So the normaliser converts spoken Turkish number words to digits, then folds the
known id shapes into their canonical spelling. It is deliberately conservative:
it only rewrites a span it can name a real identifier for, and every rewrite is
recorded in `Transcript.normalised` so the operator can see that "te sıfır yüz
otuz iki" was read as `T0132` rather than wondering why a different vehicle
lit up. The raw text is always kept.

What this module will not do is decide meaning. Turning `T0132` plus a verb into
an action is `app.voice`'s job, and keeping that out of here is what lets the
normaliser be tested with strings alone.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Optional

from goru_core.config import SttConfig, VoiceConfig

from app.stt.schemas import (
    SttErrorCode,
    SttMetrics,
    Transcript,
    TranscriptRejected,
    Utterance,
)

__all__ = [
    "TranscriptManager",
    "normalise_domain_terms",
    "spoken_numbers_to_digits",
    "clean_text",
    "DOMAIN_TERMS",
]


# --- the vocabulary ------------------------------------------------------- #

# Turkish number words, as Whisper writes them. `sifir` is included unaccented
# too because the model is inconsistent about the dotless i in short utterances.
_UNITS = {
    "sıfır": 0,
    "sifir": 0,
    "bir": 1,
    "iki": 2,
    "üç": 3,
    "uc": 3,
    "dört": 4,
    "dort": 4,
    "beş": 5,
    "bes": 5,
    "altı": 6,
    "alti": 6,
    "yedi": 7,
    "sekiz": 8,
    "dokuz": 9,
}
_TENS = {
    "on": 10,
    "yirmi": 20,
    "otuz": 30,
    "kırk": 40,
    "kirk": 40,
    "elli": 50,
    "altmış": 60,
    "altmis": 60,
    "yetmiş": 70,
    "yetmis": 70,
    "seksen": 80,
    "doksan": 90,
}
_SCALES = {"yüz": 100, "yuz": 100, "bin": 1000}

_NUMBER_WORDS = set(_UNITS) | set(_TENS) | set(_SCALES)

# The letters an operator says when reading one of our ids aloud. Whisper renders
# the spoken letter T as "te" or "t", Z as "ze" or "zet", R as "re" or "er".
_ID_LETTERS = {
    "t": "T",
    "te": "T",
    "z": "Z",
    "ze": "Z",
    "zet": "Z",
    "r": "R",
    "re": "R",
    "er": "R",
}

# Words that introduce a drone frame. "kare" is the display's own word for it, so
# an operator who has read the UI will say it.
_FRAME_WORDS = ("kare", "görüntü", "goruntu", "fotoğraf", "fotograf", "resim")

# Terms the model mangles and the display spells one specific way. Left side is
# matched case-insensitively as a whole word; right side is what we forward.
DOMAIN_TERMS: dict[str, str] = {
    "gözcü": "Gözcü",
    "sentinel": "Sentinel",
    "yolo": "YOLO",
    "eta": "ETA",
    "vi ai": "VAD",
    "vad": "VAD",
    "el el em": "LLM",
    "lem": "LLM",
    "llm": "LLM",
    "gpt": "GPT",
    "glm": "GLM",
    "ay di": "ID",
    "kopilot": "kopilot",
    "ko-pilot": "kopilot",
    "brif": "brief",
    "brief": "brief",
    "zon": "zone",
    "track": "iz",
    "harita": "harita",
    "hareket": "hareket",
    "kayıtlar": "kayıtlar",
    "kayitlar": "kayıtlar",
}

# Zone names as zones.json spells them - ASCII-folded, exactly as W3 in the
# frontend log insists, because report text is matched against these strings.
ZONE_NAMES: tuple[str, ...] = (
    "Kuzeydogu Kavsagi",
    "Guneydogu Yerlesimi",
    "Guneybati Yolu",
    "Kuzeybati Yolu",
    "Dogu Yolu",
    "Bati Yolu",
    "Kuzey Yolu",
    "Guney Yolu",
)


# --- cleaning ------------------------------------------------------------- #

_WS_RE = re.compile(r"\s+")
_LEADING_JUNK_RE = re.compile(r"^[\s.,;:!?\-–—]+")
_TRAILING_DOTS_RE = re.compile(r"[.\s]+$")
_REPEATED_PUNCT_RE = re.compile(r"([.,!?])\1+")
_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([.,!?;:])")

# Whisper's habit on a short clip with no speech: a lone hallucinated stock
# phrase. These are the ones the Turkish fine-tunes produce, and treating them as
# speech would hand the router a command the operator never gave.
_HALLUCINATIONS = frozenset(
    {
        "altyazı m.k.",
        "altyazı m k",
        "altyazi m.k.",
        "abone olmayı unutmayın",
        "altyazılar için teşekkürler",
        "izlediğiniz için teşekkürler",
        "teşekkürler",
        "müzik",
        "alt yazı",
        "sessizlik",
        "devam edecek",
    }
)


def clean_text(text: str) -> str:
    """Whitespace and punctuation, as stt.md phase 5 asks.

    Whisper punctuates a five-word command as if it were prose: a trailing full
    stop on everything, occasional doubled commas, a space before punctuation.
    None of that changes meaning, all of it makes an exact-match comparison in a
    test or a log fail for no reason, so it is normalised away here once.
    """
    if not text:
        return ""
    collapsed = _WS_RE.sub(" ", text.replace(" ", " ")).strip()
    collapsed = _LEADING_JUNK_RE.sub("", collapsed)
    collapsed = _REPEATED_PUNCT_RE.sub(r"\1", collapsed)
    collapsed = _SPACE_BEFORE_PUNCT_RE.sub(r"\1", collapsed)
    collapsed = _TRAILING_DOTS_RE.sub("", collapsed)
    return collapsed.strip()


def _fold(text: str) -> str:
    """Casefold and strip diacritics, for matching only - never for output.

    Turkish has the dotted/dotless i problem and Whisper is not consistent about
    it on short input, so matching has to be accent-blind. The folded form is
    never forwarded: the operator sees their own words back.
    """
    lowered = text.casefold().replace("ı", "i").replace("İ", "i")
    decomposed = unicodedata.normalize("NFKD", lowered)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def looks_like_hallucination(text: str) -> bool:
    """True for Whisper's stock phrases on silence."""
    folded = _fold(clean_text(text)).strip(" .,!?")
    if not folded:
        return False
    return any(_fold(phrase).strip(" .,!?") == folded for phrase in _HALLUCINATIONS)


# --- spoken numbers ------------------------------------------------------- #


# Turkish is agglutinative and an operator speaks in full sentences, so the number
# words arrive inflected: *elliye*, *yuze*, *on uce*, *T0132'yi*. Matching only the
# bare stem would miss almost every real utterance. Longest suffix first, so *den*
# is tried before *e*.
_NUMBER_SUFFIXES = (
    "inci",
    "ıncı",
    "uncu",
    "üncü",
    "ncı",
    "nci",
    "ncu",
    "ncü",
    "den",
    "dan",
    "ten",
    "tan",
    "nin",
    "nın",
    "nun",
    "nün",
    "ler",
    "lar",
    "de",
    "da",
    "te",
    "ta",
    "ye",
    "ya",
    "yi",
    "yı",
    "yu",
    "yü",
    "in",
    "ın",
    "un",
    "ün",
    "e",
    "a",
    "i",
    "ı",
    "u",
    "ü",
)


def _split_number_word(token: str) -> tuple[Optional[str], str]:
    """Match one token against the number vocabulary, suffix and all.

    Returns the folded stem and whatever suffix was removed to find it, or
    ``(None, "")`` when the token is not a number word. The bare form is always
    tried first, so *bes* is five rather than *be* plus an *s*.
    """
    folded = _fold(token).strip(".,!?:;'’\"")
    if not folded:
        return None, ""
    if folded in _NUMBER_WORDS:
        return folded, ""
    for suffix in _NUMBER_SUFFIXES:
        if len(folded) > len(suffix) and folded.endswith(suffix):
            stem = folded[: -len(suffix)]
            if stem in _NUMBER_WORDS:
                return stem, suffix
    return None, ""


def _clock_from_run(stems: list[str]) -> Optional[str]:
    """Read a run of number words as a wall clock: *on uc elli* -> ``13:50``.

    Greedy on the hour: the longest prefix that parses to 0-23 is the hour and the
    remainder is the minute. That is the rule an operator's phrasing follows, and
    it resolves the genuine ambiguity in *on uc elli* - 63 as a quantity, 13:50
    after the word *saat*.
    """
    for split in range(len(stems) - 1, 0, -1):
        hour = _parse_number_run(stems[:split])
        minute = _parse_number_run(stems[split:])
        if hour is None or minute is None:
            continue
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"
    only = _parse_number_run(stems)
    if only is not None and 0 <= only <= 23:
        return f"{only:02d}:00"
    return None


def _parse_number_run(words: list[str]) -> Optional[int]:
    """Turn a run of Turkish number words into one integer.

    Handles the additive-multiplicative mix Turkish uses: *iki yüz otuz* is
    2*100+30, *bin dokuz yüz* is 1000+9*100. Returns None when the run does not
    parse, so the caller leaves the words alone rather than guessing.
    """
    total = 0
    current = 0
    seen = False

    for word in words:
        if word in _UNITS:
            current += _UNITS[word]
            seen = True
        elif word in _TENS:
            current += _TENS[word]
            seen = True
        elif word in _SCALES:
            scale = _SCALES[word]
            if scale == 1000:
                total += (current or 1) * 1000
                current = 0
            else:
                current = (current or 1) * 100
            seen = True
        else:
            return None

    if not seen:
        return None
    return total + current


def _digit_string(words: list[str]) -> Optional[str]:
    """Read a run as separate digits: *sifir sifir bes* -> "005"."""
    out: list[str] = []
    for word in words:
        if word not in _UNITS:
            return None
        out.append(str(_UNITS[word]))
    return "".join(out) if out else None


_CLOCK_CUE = ("saat", "saati", "saate", "saatte", "saatini", "zamani", "zamanı")


def _is_clock_cue(token: str) -> bool:
    return _fold(token).strip(".,!?:;'’\"") in {_fold(c) for c in _CLOCK_CUE}


def spoken_numbers_to_digits(text: str) -> tuple[str, list[str]]:
    """Rewrite runs of Turkish number words as digits.

    Returns the rewritten text and the list of rewrites made, so the display can
    show what was reinterpreted rather than leaving the operator to wonder why a
    different vehicle lit up.

    Three readings, chosen by context:

    * after *saat*, a run is a wall clock - *on uc elli* is ``13:50``;
    * a run of two or more bare digit words is someone reading an id aloud -
      *sifir sifir bes* is ``005``;
    * anything else is a quantity - *uc yuz* is ``300``.

    The grammatical suffix on the last word is carried onto the digits, Turkish
    style, so *on uc elliye* becomes ``13:50'ye`` and still reads as a sentence.
    """
    tokens = text.split(" ")
    split = [_split_number_word(token) for token in tokens]
    changes: list[str] = []
    out: list[str] = []
    index = 0

    while index < len(tokens):
        if split[index][0] is None:
            out.append(tokens[index])
            index += 1
            continue

        end = index
        while end < len(tokens) and split[end][0] is not None:
            end += 1

        stems = [split[position][0] for position in range(index, end)]
        stems = [stem for stem in stems if stem is not None]
        spoken = " ".join(tokens[index:end])
        trailing_suffix = split[end - 1][1]
        clock_context = index > 0 and _is_clock_cue(tokens[index - 1])

        replacement: Optional[str] = None
        if clock_context:
            replacement = _clock_from_run(stems)
        if replacement is None:
            digits = _digit_string(stems)
            if digits is not None and len(stems) > 1:
                replacement = digits
            else:
                value = _parse_number_run(stems)
                replacement = None if value is None else str(value)

        if replacement is None:
            out.extend(tokens[index:end])
        else:
            punctuation = re.search(r"([.,!?:;]*)$", tokens[end - 1])
            tail = punctuation.group(1) if punctuation else ""
            rendered = replacement + (f"'{trailing_suffix}" if trailing_suffix else "") + tail
            out.append(rendered)
            changes.append(f"{spoken} -> {rendered}")

        index = end

    return " ".join(out), changes


# --- the id shapes -------------------------------------------------------- #

_TRACK_RE = re.compile(r"\b([TtZzRr])\s*[-'’]?\s*(\d{1,4})\b")
_SPOKEN_ID_RE = re.compile(
    r"\b(te|ze|zet|re|er|t|z|r)\s*[-'’]?\s*(\d{1,4})\b", re.IGNORECASE
)
_FRAME_ID_RE = re.compile(r"\b(?:img|imig|imic|imac|image)\s*[-_ ]?\s*(\d{1,6})\b", re.IGNORECASE)
_FRAME_ALT = "|".join(_FRAME_WORDS)
# "860 numarali kare" names a frame whatever the digit count, because "numarali"
# removes the ambiguity. Without that word a bare number needs three digits or
# more before we will read it as a frame id, so "3 kare ileri" is left alone.
_NUMBERED_FRAME_RE = re.compile(
    r"\b(\d{1,6})\s+numaral[ıi]\w*\s+(?:" + _FRAME_ALT + r")\w*", re.IGNORECASE
)
_BARE_FRAME_RE = re.compile(r"\b(\d{3,6})\s+(?:" + _FRAME_ALT + r")\w*", re.IGNORECASE)
_FRAME_THEN_NUM_RE = re.compile(
    r"\b(?:" + _FRAME_ALT + r")\w*\s+(\d{3,6})\b", re.IGNORECASE
)
_CLOCK_RE = re.compile(r"\b([01]?\d|2[0-3])[:.\s]([0-5]\d)\b")

_ID_WIDTH = {"T": 4, "Z": 2, "R": 3}


def _canonical_id(letter: str, digits: str) -> str:
    """`T` + `132` -> `T0132`, zero-padded to the width the contracts use."""
    upper = _ID_LETTERS.get(letter.casefold(), letter.upper())
    width = _ID_WIDTH.get(upper, 4)
    return f"{upper}{int(digits):0{width}d}"


def normalise_domain_terms(text: str) -> tuple[str, list[str]]:
    """Fold the spoken forms of our identifiers into their canonical spelling.

    Conservative by design. A span is only rewritten when it resolves to one of
    the four id shapes the contracts define - track, zone, report, frame - or to a
    term in `DOMAIN_TERMS`. Anything else is left exactly as the model wrote it,
    because a normaliser that guesses is worse than one that abstains: stt.md's
    closing rule for this phase is that correction must never change what the
    operator meant.
    """
    changes: list[str] = []
    working = text

    def note(before: str, after: str) -> None:
        if before != after:
            changes.append(f"{before} -> {after}")

    # img_000860, however it was heard
    def frame_sub(match: re.Match[str]) -> str:
        canonical = f"img_{int(match.group(1)):06d}"
        note(match.group(0), canonical)
        return canonical

    working = _FRAME_ID_RE.sub(frame_sub, working)
    working = _NUMBERED_FRAME_RE.sub(lambda m: frame_sub(m) + " karesi", working)
    working = _FRAME_THEN_NUM_RE.sub(frame_sub, working)
    working = _BARE_FRAME_RE.sub(lambda m: frame_sub(m) + " karesi", working)

    # T0132 / Z03 / R137, spoken or written
    def spoken_id_sub(match: re.Match[str]) -> str:
        canonical = _canonical_id(match.group(1), match.group(2))
        note(match.group(0), canonical)
        return canonical

    working = _SPOKEN_ID_RE.sub(spoken_id_sub, working)
    working = _TRACK_RE.sub(spoken_id_sub, working)

    # 13:50, however it was punctuated
    def clock_sub(match: re.Match[str]) -> str:
        canonical = f"{int(match.group(1)):02d}:{match.group(2)}"
        note(match.group(0), canonical)
        return canonical

    working = _CLOCK_RE.sub(clock_sub, working)

    # the flat vocabulary, longest phrase first so "ko-pilot" beats "pilot"
    for spoken in sorted(DOMAIN_TERMS, key=len, reverse=True):
        canonical = DOMAIN_TERMS[spoken]
        pattern = re.compile(r"\b" + re.escape(spoken) + r"\b", re.IGNORECASE)

        def term_sub(match: re.Match[str], canonical: str = canonical) -> str:
            if match.group(0) == canonical:
                return match.group(0)
            note(match.group(0), canonical)
            return canonical

        working = pattern.sub(term_sub, working)

    # zone names, matched accent-blind against the spelling zones.json uses
    folded_working = _fold(working)
    for name in ZONE_NAMES:
        folded_name = _fold(name)
        start = folded_working.find(folded_name)
        if start >= 0 and working[start : start + len(name)] != name:
            working = working[:start] + name + working[start + len(name) :]
            changes.append(f"{text[start : start + len(name)]} -> {name}")
            folded_working = _fold(working)

    return working, changes


# --- the manager ---------------------------------------------------------- #


@dataclass
class TranscriptManager:
    """The Phase 5 boundary between the model and the router.

    Stateful in exactly one respect: it numbers the transcripts it passes, so a
    log line, a metrics row and a screen row can all refer to `speech_00142` and
    mean the same utterance. Everything else is a pure function of one input.
    """

    stt: SttConfig
    voice: VoiceConfig
    _counter: int = field(default=0, repr=False)

    def finalise(
        self,
        *,
        raw_text: str,
        utterance: Utterance,
        language: str,
        no_speech_prob: Optional[float] = None,
        confidence: Optional[float] = None,
        metrics: Optional[SttMetrics] = None,
    ) -> Transcript | TranscriptRejected:
        """Clean, normalise and either forward or refuse one model output."""
        cleaned = clean_text(raw_text)

        if not cleaned:
            return TranscriptRejected(
                code=SttErrorCode.EMPTY_TRANSCRIPT,
                detail="the model returned no words for this audio",
                duration=utterance.duration_s,
            )

        if looks_like_hallucination(cleaned):
            return TranscriptRejected(
                code=SttErrorCode.NO_SPEECH,
                detail="only background noise was heard",
                heard=cleaned,
                duration=utterance.duration_s,
            )

        digits, number_changes = spoken_numbers_to_digits(cleaned)
        normalised, term_changes = normalise_domain_terms(digits)
        normalised = clean_text(normalised)

        if not normalised:
            return TranscriptRejected(
                code=SttErrorCode.EMPTY_TRANSCRIPT,
                detail="nothing was left after normalisation",
                heard=cleaned,
                duration=utterance.duration_s,
            )

        if len(normalised) > self.voice.max_transcript_chars:
            normalised = normalised[: self.voice.max_transcript_chars].rstrip()

        self._counter += 1
        return Transcript(
            id=f"speech_{self._counter:05d}",
            text=normalised,
            raw_text=raw_text,
            language=language,
            duration=round(utterance.duration_s, 3),
            final=True,
            confidence=confidence,
            no_speech_prob=no_speech_prob,
            normalised=[*number_changes, *term_changes],
            metrics=metrics,
            timestamp=datetime.now(timezone.utc),
        )
