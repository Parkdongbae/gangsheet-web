"""레이어별 풀해상도 렌더링(바운딩 박스 단위) — S6 세션 1·2.

IPC 절약 철칙 (STDIO_GUIDE): stdio로 이미지 바이너리·Base64를 절대
전달하지 않는다. 입력은 파일 경로 + cm 좌표만 담은 Light JSON Manifest이며,
원본 파일은 이 모듈이 디스크에서 직접 로드한다.

파이프라인 (항목당):

1. 원본 로드 → RGBA 강제 (JPG 등 알파 없는 포맷은 불투명 알파 부여)
2. LANCZOS 리사이즈 → 항목 배치 치수(절대 px)
3. 회전 — Konva는 양의 각이 시계 방향(화면 y축 아래), PIL ``rotate``는
   반시계 방향이므로 ``-rotation``을 돌리고 ``expand=True``로 회전
   바운딩 박스만큼 캔버스를 키운다(빈 모서리는 투명).
4. 알파 분리 → RGB만 ``color.rgb_to_cmyk``로 변환(PIL CMYK는 알파
   불가 — CLAUDE.md §1-2: RGB→CMYK 변환은 내보내기 시 1회)
5. 완전 불투명이면 마스크 생략, 아니면 알파를 ``LayerSpec.alpha``로
   전달(psd_writer가 USER_LAYER_MASK로 저장 — 백색 잉크 영역)

출력 경로 (S6 세션 2 — 매니페스트 ``format``·``flatten``):

- ``format="psd"``(기본) ``flatten=False``: 항목별 레이어 보존(위 파이프라인)
- ``format="psd"`` ``flatten=True``: 전체를 RGBA로 합성한 뒤 CMYK 변환 1회로
  단일 인쇄 레이어 저장 (F8 병합 옵션 — 합성은 RGB에서, 변환은 최종 1회)
- ``format="png"``: 합성 결과를 RGB+알파 그대로 저장 (F9 검수용 — 알파 =
  백색 잉크 영역, DPI는 pHYs 청크로 기록)
- ``format="pdf"``: 흰 종이 합성 RGB를 1페이지 PDF로 저장 (인쇄 검수용)

진행 보고: ``on_progress(stage, current, total)`` 콜백을 받아 항목 렌더
직후마다 ``("items", i+1, total)``, 저장 직전에 ``("write", total, total)``을
전달한다 — server가 NDJSON progress 알림으로 변환한다.

메모리 전략: 50cm×2m(6,890×27,559) 전체를 단일 CMYK 래스터로 만들지
않고 항목별 회전 바운딩 박스만 렌더해 레이어로 합성한다(PLAN.md S6-1).
PNG·병합 경로는 성격상 캔버스 크기 RGBA 1장(2m 기준 ≈760MB)이 필요하다.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np
from PIL import Image

import color
import psd_writer
from psd_writer import LayerSpec

CM_PER_INCH: Final[float] = 2.54
PSD_MAX_PX: Final[int] = psd_writer.PSD_MAX_PX
DEFAULT_DPI: Final[int] = 350
DPI_MAX: Final[int] = 4800
LAYER_NAME_STEM_MAX: Final[int] = 180
FORMAT_PSD: Final[str] = "psd"
FORMAT_PNG: Final[str] = "png"
FORMAT_PDF: Final[str] = "pdf"
STAGE_ITEMS: Final[str] = "items"
STAGE_WRITE: Final[str] = "write"
MERGED_LAYER_NAME: Final[str] = "Merged 1"

# 진행 콜백 인자: (단계, 완료 수, 전체 수) — 단계는 "items" | "write"
ProgressCallback = Callable[[str, int, int], None]


class ManifestError(ValueError):
    """매니페스트 검증 오류 — 스키마 위반·파일 없음·치수 한계 초과 등 입력 문제."""


@dataclass(frozen=True, slots=True)
class ManifestItem:
    """배치 항목 — 좌표·치수는 cm, 회전은 도(Konva 단위 그대로)."""

    src: Path
    x_cm: float
    y_cm: float
    width_cm: float
    height_cm: float
    rotation: float


@dataclass(frozen=True, slots=True)
class ManifestCanvas:
    width_cm: float
    height_m: float
    dpi: int


@dataclass(frozen=True, slots=True)
class Manifest:
    output_path: Path
    canvas: ManifestCanvas
    items: tuple[ManifestItem, ...]
    fmt: str = FORMAT_PSD
    flatten: bool = False


@dataclass(frozen=True, slots=True)
class RenderResult:
    """렌더 결과 — 응답은 경로·메타데이터만 담는다(바이너리 반환 금지)."""

    output_path: Path
    width_px: int
    height_px: int
    layer_count: int
    duration_ms: int


def cm_to_px(cm: float, dpi: int) -> int:
    """cm → px, 절반 올림 — TS ``Math.round``와 같은 규칙(은행가 반올림 아님)."""
    return math.floor(cm / CM_PER_INCH * dpi + 0.5)


def parse_manifest(data: Mapping[str, object]) -> Manifest:
    """딕셔너리 → Manifest — 스키마·범위를 엄격히 검증, 오류 메시지에 필드 경로 포함.

    :raises ManifestError: 스키마 위반·치수 한계(30,000px) 초과
    """
    canvas_raw = _require_mapping(data, "canvas")
    output_raw = _require_str(data, "output_path")
    items_raw = _require_array(data, "items")
    if not output_raw:
        raise ManifestError("output_path must be a non-empty string")

    fmt_raw = data.get("format", FORMAT_PSD)
    if not isinstance(fmt_raw, str) or fmt_raw not in (FORMAT_PSD, FORMAT_PNG, FORMAT_PDF):
        raise ManifestError(f"format must be 'psd', 'png' or 'pdf', got {fmt_raw!r}")
    flatten_raw = data.get("flatten", False)
    if not isinstance(flatten_raw, bool):
        raise ManifestError(f"flatten must be a boolean, got {flatten_raw!r}")

    width_cm = _num(canvas_raw.get("width_cm"), "canvas.width_cm", positive=True)
    height_m = _num(canvas_raw.get("height_m"), "canvas.height_m", positive=True)
    dpi_raw = canvas_raw.get("dpi", DEFAULT_DPI)
    if isinstance(dpi_raw, bool) or not isinstance(dpi_raw, int) or not (1 <= dpi_raw <= DPI_MAX):
        raise ManifestError(f"canvas.dpi must be an int in 1..{DPI_MAX}, got {dpi_raw!r}")
    if cm_to_px(width_cm, dpi_raw) > PSD_MAX_PX or cm_to_px(height_m * 100, dpi_raw) > PSD_MAX_PX:
        raise ManifestError(
            f"canvas {width_cm}cm x {height_m}m exceeds PSD {PSD_MAX_PX}px limit"
            " — split to 2m rolls (CLAUDE.md §1-3)"
        )

    items: list[ManifestItem] = []
    for index, raw in enumerate(items_raw):
        label = f"items[{index}]"
        if not isinstance(raw, Mapping):
            raise ManifestError(f"{label} must be an object, got {type(raw).__name__}")
        src_raw = _require_str(raw, "src")
        if not src_raw:
            raise ManifestError(f"{label}.src must be a non-empty string")
        items.append(
            ManifestItem(
                src=Path(src_raw),
                x_cm=_num(raw.get("x_cm"), f"{label}.x_cm"),
                y_cm=_num(raw.get("y_cm"), f"{label}.y_cm"),
                width_cm=_num(raw.get("width_cm"), f"{label}.width_cm", positive=True),
                height_cm=_num(raw.get("height_cm"), f"{label}.height_cm", positive=True),
                rotation=_num(raw.get("rotation"), f"{label}.rotation"),
            )
        )

    return Manifest(
        output_path=Path(output_raw),
        canvas=ManifestCanvas(width_cm=width_cm, height_m=height_m, dpi=dpi_raw),
        items=tuple(items),
        fmt=fmt_raw,
        flatten=flatten_raw,
    )


def render_manifest(
    manifest: Manifest, on_progress: ProgressCallback | None = None
) -> RenderResult:
    """매니페스트 전체를 렌더·저장 — format·flatten에 따라 세 경로로 분기.

    항목 순서 = 레이어 순서(아래→위)·합성 순서(뒤 항목이 위). 진행 보고는
    항목 렌더 직후마다, 저장 직전에 1회.

    :raises ManifestError: 항목 소스 파일 오류 등 렌더 중 입력 문제
    :raises psd_writer.PsdWriterError: PSD 쓰기 실패
    """
    started = time.perf_counter()
    dpi = manifest.canvas.dpi
    width_px = cm_to_px(manifest.canvas.width_cm, dpi)
    height_px = cm_to_px(manifest.canvas.height_m * 100, dpi)
    total = len(manifest.items)

    def report(stage: str, current: int) -> None:
        if on_progress is not None:
            on_progress(stage, current, total)

    prepared: list[_PreparedItem] = []
    for index, item in enumerate(manifest.items):
        prepared.append(_prepare_item(item, dpi, index))
        report(STAGE_ITEMS, index + 1)

    manifest.output_path.parent.mkdir(parents=True, exist_ok=True)
    size = (width_px, height_px)
    if manifest.fmt == FORMAT_PNG:
        report(STAGE_WRITE, total)
        canvas = _compose_rgba(prepared, width_px, height_px)
        canvas.save(manifest.output_path, format=FORMAT_PNG, dpi=(dpi, dpi))
        layer_count = 1
    elif manifest.fmt == FORMAT_PDF:
        report(STAGE_WRITE, total)
        canvas = _compose_rgba(prepared, width_px, height_px)
        # 검수용 PDF — 투명 픽셀은 흰 종이에 합성(알파 폐기), JPEG 인코딩
        background = Image.new("RGB", canvas.size, (255, 255, 255))
        background.paste(canvas, mask=canvas.getchannel("A"))
        del canvas
        background.save(
            manifest.output_path, format="PDF", resolution=float(dpi), quality=92
        )
        layer_count = 1
    else:
        report(STAGE_WRITE, total)
        if manifest.flatten:
            # 병합: 프리뷰 = 단일 레이어 픽셀과 동일 — 추가 합성 비용 0
            canvas = _compose_rgba(prepared, width_px, height_px)
            merged = _merged_layer(canvas)
            del canvas  # 프리뷰 인코딩 전 해제(메모리 피크 절감)
            layers: list[LayerSpec] = [merged]
            preview: Image.Image | None = merged.image
        else:
            layers = [_layer_from_prepared(p) for p in prepared]
            preview = _preview_composite(layers, size)
        psd_writer.write_psd(manifest.output_path, size, layers, preview=preview)
        layer_count = len(layers)

    return RenderResult(
        output_path=manifest.output_path,
        width_px=width_px,
        height_px=height_px,
        layer_count=layer_count,
        duration_ms=round((time.perf_counter() - started) * 1000),
    )


@dataclass(frozen=True, slots=True)
class _PreparedItem:
    """회전까지 마친 RGBA 배치 결과 — 레이어(PSD)·합성(PNG·병합) 양쪽의 원료."""

    image: Image.Image
    name: str
    top: int
    left: int


def _prepare_item(item: ManifestItem, dpi: int, index: int) -> _PreparedItem:
    """항목 1개를 디스크 로드→리사이즈→회전까지 처리 — 알파 분리·CMYK는 소비 측에서."""
    if not item.src.is_file():
        raise ManifestError(f"items[{index}].src not found: {item.src}")
    try:
        with Image.open(item.src) as loaded:
            source = loaded.convert("RGBA")
    except OSError as exc:
        raise ManifestError(f"items[{index}].src is not a readable image: {item.src}") from exc

    width_px = cm_to_px(item.width_cm, dpi)
    height_px = cm_to_px(item.height_cm, dpi)
    placed = source.resize((width_px, height_px), Image.Resampling.LANCZOS)
    if item.rotation % 360 != 0:
        placed = placed.rotate(-item.rotation, resample=Image.Resampling.BICUBIC, expand=True)

    # Konva 원점 피벗 규약(placement.ts fitToCanvas·autoNesting.ts originToCoverCell과
    # 동일 수학): x,y는 회전 전 좌상단이자 회전 피벗(offset 없음). 로컬 4모서리
    # (0,0)(w,0)(0,h)(w,h)의 회전 오프셋 최솟값을 피벗에 더하면 회전 바운딩 박스의
    # 좌상단이 된다. 중심 고정 수식을 쓰면 회전 항목이 편집기 화면과 어긋난다.
    rad = math.radians(item.rotation)
    cos = math.cos(rad)
    sin = math.sin(rad)
    x_px = cm_to_px(item.x_cm, dpi)
    y_px = cm_to_px(item.y_cm, dpi)
    left = math.floor(
        x_px + min(0.0, width_px * cos, -height_px * sin, width_px * cos - height_px * sin) + 0.5
    )
    top = math.floor(
        y_px + min(0.0, width_px * sin, height_px * cos, width_px * sin + height_px * cos) + 0.5
    )

    return _PreparedItem(image=placed, name=_layer_name(item.src, index), top=top, left=left)


def _layer_from_prepared(prepared: _PreparedItem) -> LayerSpec:
    """준비된 항목을 CMYK 레이어로 변환 — 알파는 완전 불투명이 아니면 마스크로."""
    alpha = prepared.image.getchannel("A")
    cmyk = color.rgb_to_cmyk(prepared.image.convert("RGB"))
    # getextrema()의 다중밴드 유니언 타입을 우회해 단밴드 min을 단정 — 완전 불투명(255)이면 마스크 생략
    min_alpha = int(np.asarray(alpha).min())
    return LayerSpec(
        image=cmyk,
        name=prepared.name,
        top=prepared.top,
        left=prepared.left,
        alpha=None if min_alpha >= 255 else alpha,
    )


def _compose_rgba(
    prepared: Sequence[_PreparedItem], width_px: int, height_px: int
) -> Image.Image:
    """항목들을 캔버스 크기 투명 RGBA 1장으로 합성 — paste는 캔버스 밖 좌표를 자동 클리핑."""
    canvas = Image.new("RGBA", (width_px, height_px), (0, 0, 0, 0))
    for item in prepared:
        canvas.paste(item.image, (item.left, item.top), item.image)
    return canvas


def _preview_composite(
    layers: Sequence[LayerSpec], size: tuple[int, int]
) -> Image.Image | None:
    """레이어 보존 PSD의 실합성 프리뷰 — 임계치 초과(2m)면 None(단색 프리뷰).

    항목 CMYK(레이어 인코딩에 이미 변환됨)를 흰 CMYK 캔버스에 paste로
    조립한다 — 풀캔버스 재변환(ImageCms, 1m 기준 ~32초)을 피한다.
    반투명 겹침의 가장자리는 RGB 합성과 미세히 다를 수 있으나 프리뷰
    전용(Photoshop은 레이어로 재합성)이라 허용한다.
    """
    if size[0] * size[1] > psd_writer.PREVIEW_COMPOSITE_MAX_PX:
        return None
    preview = Image.new("CMYK", size, (0, 0, 0, 0))  # 백색 = 무잉크
    for spec in layers:
        preview.paste(spec.image, (spec.left, spec.top), spec.alpha)
    return preview


def _merged_layer(canvas: Image.Image) -> LayerSpec:
    """합성 캔버스를 단일 CMYK 인쇄 레이어로 — 알파(백색 잉크)는 전체 크기 마스크로."""
    alpha = canvas.getchannel("A")
    min_alpha = int(np.asarray(alpha).min())
    return LayerSpec(
        image=color.rgb_to_cmyk(canvas.convert("RGB")),
        name=MERGED_LAYER_NAME,
        top=0,
        left=0,
        alpha=None if min_alpha >= 255 else alpha,
    )


def _layer_name(src: Path, index: int) -> str:
    """레이어명 = 파일 스템 + 일련번호 — 동일 파일 다중 배치 시 충돌 없는 결정적 이름."""
    stem = src.stem or "layer"
    return f"{stem[:LAYER_NAME_STEM_MAX]} {index + 1}"


def _require_mapping(container: Mapping[str, object], key: str) -> Mapping[str, object]:
    if key not in container:
        raise ManifestError(f"missing required field: {key}")
    value = container[key]
    if not isinstance(value, Mapping):
        raise ManifestError(f"{key} must be an object, got {type(value).__name__}")
    return value


def _require_str(container: Mapping[str, object], key: str) -> str:
    if key not in container:
        raise ManifestError(f"missing required field: {key}")
    value = container[key]
    if not isinstance(value, str):
        raise ManifestError(f"{key} must be a string, got {type(value).__name__}")
    return value


def _require_array(container: Mapping[str, object], key: str) -> Sequence[object]:
    if key not in container:
        raise ManifestError(f"missing required field: {key}")
    value = container[key]
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ManifestError(f"{key} must be an array, got {type(value).__name__}")
    return value


def _num(value: object, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestError(f"{label} must be a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ManifestError(f"{label} must be finite, got {value!r}")
    if positive and number <= 0:
        raise ManifestError(f"{label} must be > 0, got {value!r}")
    return number
