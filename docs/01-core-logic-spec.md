# 핵심 로직·계산 규칙 명세서

- **문서 목적**: 갱시트 편집기의 단위 변환·배치·내보내기·배경 제거 규칙을 코드와 1:1로 고정해, 구현·테스트·QA가 같은 숫자와 판정 기준을 쓰게 한다. (v0.5.0)
- **대상 독자**: 구현 엔지니어, QA, 로직 리뷰어
- **최종 수정일**: 2026-11-23 (v0.5.0)

> 출처 표기: `경로` = v0.5.0 코드에서 확인한 규칙. "미구현"·"향후"는 코드에 없는 항목, "미검증"은 측정하지 않은 항목이다. 배경 제거 파라미터는 `web/src/api/bgRemoval/matting.ts`의 상수 그대로이며 PoC에서 확정된 값이다.

---

## 1. 단위 변환 (350 DPI)

원칙(`.agent/CLAUDE.md` §1-1): 내부 데이터는 항상 **350 DPI 절대 px**. 줌은 뷰 변환(`ViewTransform`)에서만 처리하고 데이터에 반영하지 않는다.

| 함수 | 식 | 반올림 | 출처 |
|---|---|---|---|
| `cmToPx(cm, dpi=350)` | `(cm / 2.54) * dpi` | `Math.round` | `src/core/math/index.ts` |
| `pxToCm(px, dpi=350)` | `(px / dpi) * 2.54` | 없음 (표시 전용) | 동일 |
| `mmToPx(mm, dpi=350)` | `(mm / 25.4) * dpi` | **없음** — 키보드 누적 이동 드리프트 방지 | 동일 |
| `pxToMm(px, dpi=350)` | `(px / dpi) * 25.4` | 없음 (표시 전용) | 동일 |
| 매니페스트 `pxToCm` | `(px * 2.54) / dpi` | 없음 | `src/workers/exportManifest.ts` |

기준값 (모두 `cmToPx` 결과):

| cm | px |
|---|---|
| 5 | 689 |
| 21 (A4 폭) | 2,894 |
| 29.7 (A4 높이 / A3 폭) | 4,093 |
| 42 (A3 높이) | 5,787 |
| 50 (기본 롤 폭, `CANVAS_WIDTH_PX`) | 6,890 |
| 100 (1m) | 13,780 |
| 200 (2m) | 27,559 |
| 300 (3m, 금지) | 41,339 |

규칙 요약:
- 표시(cm)는 px→cm를 소수로 표기, **저장·계산은 px**. cm 입력은 입력 시점에 1회 `cmToPx` 반올림.
- 내보내기 직전 px→cm(float64) 왕복은 ±0.5px 미만 무손실이며, 워커가 `cmToPx`로 다시 px화(`exportWorker.ts`). 따라서 항목 좌표/치수는 내보내기에서 **px 단위로 반올림**된다.
- 항목 치수(`widthPx`, `heightPx`)는 리사이즈·비율 연산 결과가 소수(예 1206.99…)일 수 있으며 정상이다(`src/core/project.ts` `requirePositive`).

---

## 2. 문서 규격 프리셋과 한계

| 항목 | 규칙 | 출처 |
|---|---|---|
| 롤 가로 폭 | 5~100cm, **1cm 스텝**, 기본 50cm (`MIN_WIDTH_CM=5`, `MAX_WIDTH_CM=100`, `WIDTH_STEP_CM=1`, 프리셋 96개) | `core/math` |
| 롤 세로 길이 | **1m, 2m만** (`HEIGHT_PRESETS_M=[1,2]`): 13,780px / 27,559px | `core/math` |
| 고정 시트 | A4 21×29.7cm(2,894×4,093px), A3 29.7×42cm(4,093×5,787px) | `FIXED_SHEET_PRESETS` |
| PSD 최대 치수 | **변당 30,000px** (`PSD_MAX_PX`) | `core/math` |
| 한계 초과 | `getCanvasHeightPx`/`getCanvasWidthPx`가 `CanvasSizeLimitError` throw ("2m 단위로 분할할 것") | `core/math` |
| 프로젝트 로드 검증 | `document.widthPx/heightPx`는 양의 **정수**, 각 ≤ 30,000 | `core/project.ts` |
| 평면 PSD 인코더 | width 또는 height > 30,000 → 오류 | `web/src/api/psdFlat.ts` |
| 금지 | 3m(41,339px) 이상 옵션·계산 경로·UI 항목 생성 금지. 요청 시 "2m 분할" 안내 | `.agent/CLAUDE.md` §1-3 |

웹 캔버스 면적 한계(브라우저 제약): Chrome 캔버스 면적 상한 2^28 = 268,435,456px(`exportWorker.ts` 주석). 문서 면적 계산:

| 문서 | 면적(px) | 상한 대비 |
|---|---|---|
| 50cm × 1m (6,890×13,780) | 94,944,200 | 여유 |
| 50cm × 2m (6,890×27,559) | 189,881,510 | 통과 예상 |
| 100cm × 1m (13,780×13,780) | 189,888,400 | 통과 예상 |
| 100cm × 2m (13,780×27,559) | 379,763,020 | **초과 — 내보내기 실패 가능** |

(통과 여부는 브라우저·메모리에 따라 다르다. 면적별 내보내기 실측은 하지 않았다 — `05` §3.5 미검증.) 할당 실패 시 워커가 "문서 캔버스를 할당하지 못했습니다 … 문서 크기를 줄여 주세요" 오류를 던진다. **문서 생성·내보내기 전 면적 사전 경고는 구현하지 않았다**(향후). 편집은 가능하고 내보내기 실패 시에만 위 오류로 안내한다.

---

## 3. 이미지 가져오기

### 3.1 DPI 메타 판독 (`src/core/imageMeta.ts`)

| 형식 | 위치 | 변환 | 유효 범위 |
|---|---|---|---|
| PNG | `pHYs` 청크(IHDR 이후, `IDAT`/`IEND` 전), `unit=1`(미터)일 때만 | `dpi = round(ppm × 0.0254)` | 1 ≤ dpi ≤ 100,000 |
| JPEG | 첫 마커가 APP0(JFIF) | `units=1` → x밀도 그대로, `units=2`(dcm) → `round(x × 2.54)`, `units=0` → null | 동일 |
| 그 외(WebP·PSD 등)·메타 없음·unit 0 | — | `null` | — |

웹은 파일 앞 65,536바이트만 읽어 판독한다(`readDpiMeta`, `imageOps.ts`).

### 3.2 물리 크기 보존 환산 (`physicalDocPixels`)

`docPx = px / dpi × 350`. `dpi`가 없거나 ≤ 0이면 **원본 픽셀 그대로**. 예: 500dpi 1,000px 원본 → 700px(= 5.08cm 유지). 고DPI 원본을 픽셀 그대로 배치하면 물리 크기가 커지는 결함 방지.

### 3.3 치수 판독 (`extractImageSize`)

PNG(IHDR), JPEG(SOF, C4/C8/CC 제외), WebP(VP8X/VP8/VP8L) 헤더에서 읽는다. 그 외 null. PSD는 웹에서 `ag-psd` composite 읽기(`decodeBlob`).

### 3.4 프리뷰

캔버스 표시용 프리뷰는 긴 변 ≤ **2,048px**(`PREVIEW_MAX_PX`) PNG. `scale = min(1, 2048 / max(w,h))`, 반올림 후 최소 1px. 내보내기는 항상 원본으로 렌더하므로 프리뷰 해상도는 인쇄 품질과 무관.

### 3.5 Auto-Trim (여백 자동 제거)

| 규칙 | 값 / 판정 | 출처 |
|---|---|---|
| 보이는 픽셀 | `alpha > 10` (`AUTO_TRIM_ALPHA_THRESHOLD = 10`, `autotrim.py`와 동기) | `src/core/autoTrim.ts` |
| no-op | 알파가 모두 255(알파 없음) / 보이는 픽셀 없음(완전 투명) / 이미 경계가 꽉 참 | `imageOps.ts autoTrimBlob` |
| 결과 | 보이는 픽셀의 바운딩 박스 크롭 PNG, `trimmed=true` | 동일 |
| 기본값 | ON. 저장 키 `localStorage['dtf:auto-trim']` = `'on'`/`'off'` (`!== 'off'`이면 ON) | `ProxyCanvas.tsx` |
| 적용 시점 | 이미지 가져오기, 배경 제거 직후 | `ProxyCanvas.tsx` |

---

## 4. 배치·이동·스냅

### 4.1 가져오기 배치 (`placement.ts`)

- 기준점: 뷰포트 중심의 문서 좌표 `viewCenterDoc` → `screenToDoc: doc = (screen − view.offset) / view.scale`.
- 다중 임포트 캐스케이드: i번째 이미지는 중심 기준 좌상단에서 `i × duplicateOffset(scale)` 만큼 대각선 이동.
- `duplicateOffset(scale) = 24 / scale` (문서 px) — 화면 24px 규칙(`CASCADE_SCREEN_PX`)을 줌 배율로 보정. Ctrl+D 복제·붙여넣기도 동일 오프셋.

### 4.2 회전·변형

- `normalizeRotation(deg)`: 항상 **(−180, 180]**. 270° → −90°, −180° → 180°.
- 변형 확정 `commitTransform`: `widthPx = width × scaleX`, `heightPx = height × scaleY`, 회전 정규화. 트랜스포머 임시 scale은 절대 px로 환산해 저장.
- 최소 치수 `MIN_TRANSFORM_PX = 5` 미만으로 줄이는 리사이즈는 거부(이전 박스 유지).
- Shift 회전: **15° 배수** 스냅(`ROTATION_SNAP_STEP_DEG`). `R` 키: +90° 후 정규화(잠금 항목 제외).
- 좌표 규약: **Konva 원점 피벗** — 회전은 노드 원점(x,y) 기준. 내보내기 워커도 `translate → rotate → drawImage`로 동일 수학(WYSIWYG).

### 4.3 이동

- 방향키: 기본 **5mm**(`NUDGE_DEFAULT_MM`), 범위 1~50mm, Shift+방향키 **1mm**(`NUDGE_FINE_MM`). px 환산은 `mmToPx`(반올림 없음). 연속 입력은 900ms(`NUDGE_COALESCE_MS`) 내 하나의 undo 단계로 병합.
- 축 고정: Shift 드래그 → `constrainAxis` (|dx| ≥ |dy|이면 수평, 동점·정지는 수평).
- Ctrl+드래그: 복제 이동. 빈 곳 드래그: 마키 선택(1px이라도 회전 바운딩 박스와 교차하면 선택, 3px 미만 이동은 클릭으로 간주해 선택 해제 `MARQUEE_CLICK_PX`).
- 줌: 휠 `exp(−deltaY × 0.0015)` 곱산, 클램프 0.02~8, 화면 맞춤 여백 24px. Space 또는 휠 클릭 드래그 = 팬.
- Undo 상한 100단계(`UNDO_LIMIT`).

### 4.4 스냅 (`snap.ts`, 드래그 중)

- 이동군 전체 union bbox의 세 기준선(시작·중심·끝)을 대상(인접 항목·문서 가장자리/중앙선)의 세 기준선과 비교, **임계값 이내 최근접 쌍**을 축마다 하나 선택.
- 임계값: 화면 **6px**(`SNAP_THRESHOLD_SCREEN_PX`) ÷ `view.scale` → 문서 px. 임계값 ≤ 0이면 스냅 없음.
- 가이드 색 `#22d3ee`, 간격 라벨은 보정 반영 후 최종 위치의 순수 분리 거리(px, 양수만).

### 4.5 화면 채우기 / 안에 맞춤 (`fitToCanvas`)

- 회전 바운딩 박스 `bboxW = w|cosθ| + h|sinθ|`, `bboxH = w|sinθ| + h|cosθ|`.
- `cover`: `k = max(docW/bboxW, docH/bboxH)`, `contain`: `k = min(...)`. 새 치수 `w·k × h·k`, 회전 보존, 항목 중심을 문서 중심에 정렬(`x = docW/2 − (cos·w' − sin·h')/2`, `y = docH/2 − (sin·w' + cos·h')/2`).
- 결과는 float 그대로(반올림 없음).

### 4.6 그리드 복제 (`calculateGridPositions`, `GridDialog.tsx`)

- 셀 (0,0) = 원본 자리. 스텝 `stepX = w + gap`, `stepY = h + gap` (gap은 `cmToPx(gapCm)`). row-major. 회전은 사본이 상속.
- 한도: 행/열 1~50(`MAX_GRID`), 간격 0~50cm(`GAP_CM_MAX`), 기본 2×2·간격 1cm. "가로 채우기" 개수 = `clamp(floor((total + gap) / (size + gap)), 1, 50)`.
- 경고: `cols·w + (cols−1)·gap > 문서 폭`이면 롤 초과 경고.

### 4.7 보기 옵션 (씬 상태 아님, undo 대상 아님)

- 그리드(`gridOverlay.ts`): 간격 0.5~50cm 클램프(기본 5cm, NaN은 기본값), 선 위치 `i × cmToPx(간격)` (i ≥ 1, 문서 끝 미만), 선 스타일 실선/대시(`[6/s, 4/s]`)/도트(`[1/s, 4/s]`). 기본 색 `#71717a`, 기본 비표시.
- 체커 배경: 표시 전용(흰 배경 이미지 경계 식별). 내보내기에 영향 없음.
- 자(`ruler.ts`): 라벨 후보 간격 [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]cm 중 **화면 간격 ≥ 48px**인 가장 촘촘한 값, 보조 눈금 = 라벨/5, 라벨 정수 스텝은 정수·소수 스텝은 소수 1자리.

---

## 5. 정렬·분배·그룹·레이어

### 5.1 회전 바운딩 박스 (`alignment.ts rotatedBBox`)

피벗 (x,y)에 로컬 4모서리 `(0,0)(w,0)(0,h)(w,h)`의 회전 오프셋 min/max를 더한다. θ=0이면 `x, y, x+w, y+h`로 퇴화.

### 5.2 정렬·분배 (`alignItems`)

| 연산 | 최소 유닛 | 규칙 |
|---|---|---|
| left/right/centerH/top/bottom/centerV | 2 | 선택 union bbox의 모서리/중심축에 각 유닛 bbox를 평행이동 |
| distH/distV | **3** | 양 끝 유닛 고정, `gap = (span − Σ크기) / (n−1)`, 시작 좌표순(동률은 끝 좌표순) 정렬 후 커서 누적 |
| 문서 기준 `alignToDocument` | **1**(빈 선택만 null) | union bbox를 문서 모서리/중앙에 맞춤 (docLeft/docCenterH/docRight/docTop/docCenterV/docBottom) |

- 같은 `groupId` 항목은 **하나의 원자 유닛**(union bbox)으로 취급 → 그룹 내부 상대 위치 불변. "최소 유닛 수"는 그룹을 1로 센다.
- 결과는 순수 평행이동(치수·회전 불변). 잠금 항목은 편집 보호.

### 5.3 그룹 (`grouping.ts`)

- 선택 확장: 선택에 그룹원이 하나라도 있으면 그룹 전체로 확장(클릭·마키·Ctrl 추가 동일).
- 그룹화: 선택 전체를 새 `groupId`로(기존 그룹 소속은 병합). 이미 동일한 단일 완전 그룹이면 no-op(빈 undo 방지).
- 해제: 선택이 닿는 그룹 전체의 `groupId` 제거.
- 복제: 사본끼리 새 `groupId` 하나로 재매핑, 새 id, 델타 이동.

### 5.4 레이어 순서

배열 순서 = z순서(뒤 index가 위). `front/forward/backward/back`, 다중 선택은 선택 블록의 상대 순서 유지(`reorderItems`). 경계 no-op은 원본과 동일한 새 배열 반환.

---

## 6. 자동 배치 (MaxRects, `autoNesting.ts`)

| 항목 | 규칙 |
|---|---|
| 알고리즘 | MaxRects, 후보 평가 **BAF(Best Area Fit)** 1순위 → 동점 시 **BSF(Best Short Side Fit)** |
| 정렬 | 면적 내림차순 → 최장변 내림차순 → id 오름차순(결정론) |
| 간격 | 기본 `gapCm = 2.0`, 패킹 박스 = 회전 후 치수 + `gapPx`(둘레 gap/2 패딩). 입력 UI 범위 0~50cm(`NestingDialog`), NaN → 기본 2.0 |
| 회전 | 옵션 `allowRotation`(UI 기본 **켜짐**, API 기본 false). +90° 후보 박스 치수가 다를 때만 후보 추가. 임의 각도 항목은 회전 bbox 기준 패킹, 각도 유지 |
| 캔버스 | `canvasWidthPx × canvasHeightPx` 단일 free rect에서 시작, 못 들어가면 미배치 |
| 좌표 | 시각 셀 = free rect 원점 + `gap/2`, 노드 원점은 `originToCoverCell`로 환산(Konva 원점 피벗) |
| 결과 | `packedItems`(입력 순서), `usedHeightPx`(가장 아래 시각 하단), `efficiency`, `unpackedIds`(입력 순서) |
| 효율(%) | `Σ(원본 widthPx×heightPx) / (캔버스 폭 × usedHeightPx) × 100` — 배치된 항목만 합산, 사용 높이 0이면 0 |
| 분할 | free rect 교차 분할(최대 4개) + 포함 사각형 제거(동일 사각형은 선두만) |

**효율 정의 주의**: 분자는 항목의 *원본 박스 면적*(회전 바운딩 아님, 투명 여백 포함). Auto-Trim ON이면 박스가 피사체에 가까워 효율이 실제 잉크 점유율에 가깝다.

---

## 7. 내보내기 규칙

### 7.1 매니페스트 (`exportManifest.ts`)

`ExportManifest = { output_path, canvas{width_cm, height_m, dpi}, items[{src,x_cm,y_cm,width_cm,height_cm,rotation}], format?, flatten? }`. 기본값(`psd`, `flatten=false`)은 직렬화에서 생략. 사이드카 stdio에는 **바이너리/Base64를 보내지 않는다**(경로+cm만).

### 7.2 포맷별

| 포맷 | 데스크톱 | 웹 | 공통 |
|---|---|---|---|
| **PNG** | Python Pillow `dpi=350` | `OffscreenCanvas.convertToBlob` 후 `injectPngDpi` — IHDR 직후 **pHYs 청크**(unit=미터, x/y 밀도 px/m) 삽입, 기존 pHYs 제거 | 알파 보존, 350 DPI |
| **PSD** | **CMYK**(Color Mode 4, psd-tools+lcms), ResolutionInfo(ID 1005 / 0x03ED) 350 DPI. 평면/레이어 | **RGB 8bit**(mode 3). `flatten=true` → 자체 인코더 `encodeFlattenedPsd`(RLE, 스트립 읽기) / `false` → `ag-psd` 레이어 + `patchPsdResolution`으로 350 DPI 보정 | 변당 ≤ 30,000px. 에디터는 항상 RGB, 변환은 내보내기 시 1회 |
| **PDF** | 검수용 인쇄 문서 | 단일 페이지: 투명→흰 배경 합성 → JPEG(**quality 0.92**) → `/DCTDecode` 임베드. 페이지 크기 = `px × 72 / dpi` pt | 검수용(인쇄 원본 아님) |

- ag-psd는 **RGB 쓰기 전용** → CMYK PSD 쓰기에 사용 금지(`.agent/CLAUDE.md` §1-4).
- PSD 색상 모드 표기: `window.api.exportColorMode ?? 'CMYK'` — 웹은 `'RGB'`로 명시(다이얼로그 "RGB · 350 DPI").
- 웹 오류: 캔버스 할당 실패 시 문서 크기 축소 안내 문구(§2). 원본 누락 항목(`bitmaps` 없음)은 건너뜀.
- 진행률: 항목 렌더 `stage:'items'`(current/total), 저장 `stage:'write'`.
- 취소: 웹은 `내보내기가 취소되었습니다` 오류로 종료(`webApi.ts` `EXPORT_CANCELLED`).

---

## 8. 배경 제거 규칙

### 8.1 모드 선택

| 환경 | 모드 | 동작 |
|---|---|---|
| 데스크톱 | (단일) | 기존 rembg(isnet-general-use) 사이드카 유지. `bgRemovalModes` 미정의 → 모드 선택 UI 없음 |
| 웹 | **AI 자동**(기본) | ISNet general-use(DIS) ONNX, onnxruntime-web 1.31.1, Web Worker (`bgRemoval/bgWorker.ts`) |
| 웹 | **단색 배경** | 테두리 연결 플러드필 + 경계 부분 알파(아래, `matting.ts`) |

선택은 `localStorage['dtf:bg-mode']`(`'ai'` \| `'solid'`, 기본 `'ai'`)에 저장. `webApi.removeBackground(path, { mode })`가 `mode === 'solid'`이면 단색, 그 외는 AI. 진행 단계는 `onRemoveBgProgress`로 전달(`download`(ratio 0..1)·`init`·`infer`·`refine`·`encode`)되며 단색 모드는 진행 이벤트가 없다.

공통: 결과는 32-bit RGBA PNG, **입력 치수 유지**, 새 원본으로 치환(VFS에 `registerBlob`, 이름 `<원본>_nobg.png`), 이후 Auto-Trim 옵션 적용. 다중 선택은 차례로 처리하고 실패 건은 마지막에 `alert`로 모아 알린다.

### 8.2 AI 자동 파이프라인

| # | 단계 | 규칙 (`matting.ts` 상수) |
|---|---|---|
| 1 | 디코드 | `decodeBlob`로 `ImageBitmap`(PSD는 composite) → 워커로 transfer |
| 2 | 리사이즈 | `OffscreenCanvas` 1024×1024(`MODEL_SIZE`)에 고품질 스무딩으로 그려 축소(종횡비와 무관하게 정사각으로 맞춤) |
| 3 | 정규화 | 투명 픽셀은 흰 바탕에 합성한 뒤 `v/255 − 0.5`, NCHW float32. WebGPU(fp16 모델)면 float16으로 변환해 입력 |
| 4 | 추론 | onnxruntime-web, **WebGPU 우선**(어댑터에 `shader-f16` 필요), 불가·세션 생성 실패 시 WASM. 추론 중 WebGPU가 실패하면 WASM으로 **한 번** 재시도 |
| 5 | 마스크 정규화 | 출력 마스크를 **min-max 정규화**(0~1, 값이 전부 같으면 0). 크기·유한값 검사 |
| 6 | guided filter | 1024² 휘도를 가이드로 박스 반경 `GUIDED_RADIUS = 6`, `GUIDED_EPS = 2e-3`의 선형 계수(a, b)를 구해 원본 좌표로 이중선형 보간, 원본 휘도에 `q = a·I + b` 적용 |
| 7 | 알파 레벨 | 보간 마스크 ≤ 0.01은 알파 0, ≥ 0.99는 그대로 두고, 그 사이는 `0.7·guided + 0.3·마스크`를 `[0.1, 0.9]`(`ALPHA_LEVEL_LOW/HIGH`)에서 0..1로 펼침(낮은 알파 잘라냄, 높은 알파 불투명화) |
| 8 | 디프린지 | 알파 < 1인 경계 픽셀은 blur-fusion: 레벨 보정 마스크로 가중한 전경/배경 평균색(박스 반경 10)으로 `C = F̂ + α(P − αF̂ − (1−α)B̂)`로 배경색 번짐 제거 |
| 9 | 합성·검사 | 최종 알파 = `round(α × 원본 알파)`(원본에서 이미 투명한 픽셀은 0 유지). 불투명 픽셀이 0개면 오류 "피사체를 찾지 못했습니다. "단색 배경" 방식을 사용해 보세요." |
| 10 | 인코드 | `convertToBlob('image/png')`, 치수 = 입력 |

모델·캐시: Hugging Face `imgly/isnet-general-onnx`(MIT) **리비전 고정 URL**(`…/resolve/440dea96…/onnx/`)의 `model_fp16.onnx`(약 84MB, WebGPU)·`model.onnx`(약 168MB, WASM). 최초 사용 시 `fetch`로 받아 Cache Storage `dtf-bg-models-v1`에 보관(이후 `cache.match` 적중 시 네트워크 0). 가중치는 번들에 없다. 이미지 바이트는 워커 밖으로 나가지 않는다. 문제 해결용 스위치: `localStorage['dtf:bg-backend'] = 'wasm'`(새로고침 후 WebGPU를 건너뜀).

폴백·오류 규칙:
- WebGPU 어댑터/세션 생성 실패 → WASM으로 전환(콘솔 경고). 추론 실패 → WASM 재시도 1회. WASM도 실패하면 오류가 `alert`로 표시된다(전용 복구 버튼 없음, `04` §4).
- 다운로드 중단 → 완전히 받은 응답만 `cache.put`(부분 캐시 없음). 다운로드 응답이 `ok`가 아니면 "모델 다운로드 실패 (HTTP n)". 응답 길이와 예상 크기의 일치 검증은 하지 않는다.
- WASM 스레드: `crossOriginIsolated`이면 `min(4, hardwareConcurrency)`, 아니면 1. 이를 위해 COOP `same-origin` + COEP `credentialless`를 vite dev/preview와 `vercel.json`에서 보낸다.
- 실측(2026-11-23, 개발 PC, Chromium 계열, 1104×1428 JPG): WebGPU 첫 실행 8.6초(다운로드 포함)·이후 1.6~1.7초/장, WASM 첫 실행 12.2초(다운로드 포함). 상세 `05` §3.1.

### 8.3 단색 배경 (`removeSolidBackgroundPixels`)

| 항목 | 값 |
|---|---|
| 배경색 추정 | 테두리 샘플(변마다 최대 약 256점, `step = max(1, floor(변/256))`)에서 알파 ≥ 128인 픽셀의 **채널별 중앙값** |
| 테두리 알파 전부 < 128 | 배경 없음으로 간주 → 원본 그대로 반환 |
| 매칭 | 알파 < 16 이거나 RGB 유클리드 거리 ≤ `SOLID_TOLERANCE = 30` |
| 제거 | 테두리 4변에서 시작, 4-이웃 연결 영역만 알파 0 (스택 기반 플러드필) |
| 변경 없음 | 제거 픽셀 0개면 원본 반환 |
| 경계 보정 | 제거 영역과 8방향으로 닿은 비제거 픽셀(ring 1)과 그에 닿은 픽셀(ring 2)이 대상. 각 픽셀의 5×5 이웃(제거·경계 제외) 중 배경과 가장 먼 색 거리 dMax를 전경으로 보고 `α = d / dMax`. dMax < 24(`SOLID_MIN_CONTRAST`)이거나 α ≥ 0.92이면 건드리지 않음 |
| 배경색 역혼합 | α < 0.92인 경계 픽셀: `C = B + (P − B) / max(α, 0.04)`로 RGB 복원(0~255 클램프), 알파 × α → 흰 헤일로 제거 |

배경과 연결되지 않은 내부의 같은 색(예: 글자 속 흰색)은 보존한다(연결성 기반). 이 모드는 **설계상 로고·글자용**이다. 그라데이션·그림자·사진 배경에는 부적합하며(제보된 밝은 회색 배경 + 흰 옷 인물 사진이 이 사례), UI 문구가 "로고 · 글자"로 안내하고 사진은 AI 자동을 쓰게 한다.

### 8.4 외부 사이트 목록

Canva(배경 제거 도구) → Adobe Express → Erase.bg → Photoroom → Clipdrop. Remove.bg 삭제. Canva·Adobe Express·Erase.bg에 "DTF 추천" 배지.

---

## 9. 업스케일 Plan 체인 규칙 (`src/core/upscaler/plan.ts`)

데스크톱은 AI(RealESRGAN/AnimeVideo), 웹은 같은 Plan 체인으로 **고품질 리샘플**(`window.api.aiUpscale = false`). 순수 함수이며 "표시된 예상 = 실행 계획"을 보장한다.

| 규칙 | 값 |
|---|---|
| 입력 단위 | cm(0.5~200cm, 범위 밖 → `PlanInputError`), px, 배율 |
| cm→px | `cmToPx(cm, input.dpi)` |
| 가드레일 | 목표 최대 변 > `DEFAULT_MAX_TARGET_PX = 8000` → 비율 유지 축소 + `WARN_TARGET_CLAMPED` |
| 비율 불일치 | 배율 차이 / min배율 > 3% → `WARN_RATIO_MISMATCH` |
| FitMode | KEEP_RATIO(기본, min 배율로 목표 재조정) / COVER(목표 비율로 센터 크롭 후 균등) / CONTAIN·STRETCH(목표 캔버스 유지, 체인은 min 배율) |
| 총배율 | `round2(scale)` |
| 경고 | S < 1 `WARN_DOWNSCALE`; 1 ≤ S ≤ 1.5이고 전략 ≠ DIRECT `WARN_DIRECT_RECOMMENDED`; DPI < 72 `WARN_LOW_DPI`; 메모리 추정 > 2,048MB `WARN_MEMORY_TILING`; S > 12 `WARN_OVERSIZED_TILING` |
| AUTO 해석 | S ≤ 1.5 → DIRECT, 그 외 → STEP_2X (타일링은 S > 12) |
| 체인 | 전략 K ∈ {2,3,5}: `remaining > K` 동안 K 스텝 추가 → 마지막 잔여 `round2` 추가 → 마지막 < `ABSORB_THRESHOLD`(1.5)이고 흡수 결과 ≤ `K × ABSORB_CAP_FACTOR`(1.25)×1.001이면 이전 스텝에 흡수. DIRECT 또는 S ≤ 1 → `[round2(S)]` |
| 진행률 | 단계 가중치 = 누적배율² 정규화(합 1) |
| 메모리 추정 | `w × h × 4 × 2.5 / 1024²` MB |
| `aiUsed` | S > 1.5 (데스크톱 기준 표시) |

체인 예: S=4 → STEP_2X → `[2, 2]`; S=3.6 → 2, 1.8 → 마지막 1.8 ≥ 1.5 → `[2, 1.8]`; S=2.6 → 2, 1.3 → 1.3 < 1.5, 흡수 2×1.3=2.6 > cap 2.5 → 흡수 취소 `[2, 1.3]`.

PNG 출력에 `embedDpiMetadata`가 켜지면 `injectPngDpi(…, options.dpi)`로 pHYs 기록(웹).

---

## 10. 판정 기준 통합표

| 영역 | 판정 | 기준값 |
|---|---|---|
| 변환 | cm→px 반올림 | `Math.round`, 350 DPI |
| 문서 | 허용 폭 | 5~100cm (1cm) |
| 문서 | 허용 길이 | 1m, 2m |
| 문서 | 최대 치수 | 30,000px/변 |
| 문서 | 웹 내보내기 면적 상한(참고) | > 268,435,456px면 실패 가능 — 사전 경고 미구현(향후) |
| DPI 메타 | 유효 | 1~100,000 |
| 물리 크기 환산 | dpi 없음/≤0 | 원본 px 그대로 |
| 프리뷰 | 긴 변 | ≤ 2,048px |
| Auto-Trim | 보이는 픽셀 | alpha > 10 |
| 스냅 | 임계값 | 6 screen px |
| 복제 오프셋 | 화면 | 24px / scale |
| 회전 | 범위 / 스냅 | (−180,180] / 15° |
| 방향키 | 기본/범위/미세 | 5mm / 1~50mm / 1mm |
| 줌 | 범위 | 0.02~8 |
| Undo | 상한 | 100 |
| 그리드 | 간격/개수 | 0.5~50cm / 1~50 |
| 자동 배치 | 기본 간격 | 2.0cm |
| 정렬 | 최소 유닛 | 정렬 2 / 분배 3 / 문서 기준 1 |
| 자동저장 | 디바운스 | 1,500ms |
| 단색 배경 | 허용 오차 | RGB 거리 ≤ 30, 알파 < 16 투명 취급, 경계 대비 < 24면 보정 생략 |
| AI 배경 제거 | 모델 입력·정규화 | 1024×1024, `v/255 − 0.5` |
| AI 배경 제거 | 후처리 | guided filter 반경 6·ε 2e-3, 알파 레벨 [0.1, 0.9], 디프린지 반경 10 |
| PDF | JPEG 품질 | 0.92 |
| 업스케일 | 목표 최대 변 | 8,000px |

---

## 11. 엣지 케이스

| # | 상황 | 기대 동작 |
|---|---|---|
| E-1 | 이미지 0개 문서에서 자동 배치/내보내기 | 두 버튼 모두 비활성(`disabled={images.length === 0}`) |
| E-2 | 자동저장: 이미지 0개 씬 | **기록하지 않음**(직전 자동저장 보호) |
| E-3 | 자동 배치 후 `unpackedIds` 존재 | 해당 이미지는 원위치 유지, 다이얼로그에 미배치 개수 표기 |
| E-4 | 문서보다 큰 이미지 가져오기 | 그대로 배치(편집 허용). "안에 맞춤"으로 축소 가능 |
| E-5 | 투명 PNG가 완전 투명 | Auto-Trim no-op |
| E-6 | JPEG는 알파 없음 | Auto-Trim no-op, 배경 제거로 알파 생성 |
| E-7 | 회전 + 정렬/분배 | 회전 바운딩 박스 기준(화면 경계와 일치) |
| E-8 | 그룹 + 정렬 | 그룹은 1유닛, 그룹 내부 간격 불변 |
| E-9 | 잠금 항목 + 이동/삭제/회전 | 무시(선택은 가능) |
| E-10 | .dtf의 `filePath`에 해당하는 원본 없음(웹) | `원본을 찾을 수 없습니다: <이름>` — 열기 실패 안내 |
| E-11 | 배경 제거: 모든 테두리 투명 | 단색 모드는 원본 반환(변경 없음) |
| E-12 | 배경 제거: 초대형 이미지(예 > 8,000px) | AI 모드는 1024 추론 + 원본 해상도 전체 버퍼 후처리 — 메모리 한계 **미측정**, 한계 초과 안내 문구 없음(실패 시 `alert` 오류) |
| E-13 | 모델 다운로드 도중 탭 닫기 | 부분 응답은 캐시하지 않음, 다음 사용 시 처음부터 |
| E-14 | 100cm×2m 내보내기 | 캔버스 할당 실패 가능 — 문서 크기 축소 안내 |
| E-15 | PSD 입력 가져오기 | 웹은 composite만(레이어 무시) |
| E-16 | 세로 3m 요청 | 생성 경로 없음, "2m 단위로 분할" 안내 |
| E-17 | `localStorage` 차단 | 테마 light, Auto-Trim ON, 배경 제거 모드 `ai`(모두 기본값)로 동작, 오류 없음(선택 저장만 이번 세션에 한정) |

---

## 부록. 단축키 목록 (`ProxyCanvas.tsx` keydown, v0.5.0 단축키 도움말 다이얼로그의 원본)

모달(그리드·그리드 설정·배경 사이트·내보내기·자동 배치·업스케일) 열림 중, 텍스트 입력 포커스 중, 드래그 중에는 전부 무시.

| 범주 | 키 | 동작 |
|---|---|---|
| 파일 | Ctrl/Cmd+S | .dtf 저장 |
| 편집 | Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | 실행취소 / 다시실행 (키 홀드 반복 무시) |
| 편집 | Ctrl+C / X / V | 내부 클립보드 복사·잘라내기·붙여넣기 |
| 편집 | Ctrl+D | 복제(화면 24px 오프셋) |
| 편집 | Del / Backspace | 삭제 (선택 필요) |
| 편집 | R | 90° 회전 |
| 편집 | Ctrl+L | 잠금 토글 |
| 편집 | Ctrl+G / Ctrl+Shift+G | 그룹 / 그룹 해제 |
| 이동 | 방향키 / Shift+방향키 | 이동 스텝(기본 5mm) / 1mm |
| 포인터 | Shift+드래그 | 축 고정 |
| 포인터 | Ctrl+드래그 | 복제 이동 |
| 포인터 | 빈 곳 드래그 | 영역 선택(마키) |
| 포인터 | Shift+회전 핸들 | 15° 스냅 |
| 포인터 | Ctrl+클릭 | 선택 추가/토글 |
| 보기 | 휠 | 줌 |
| 보기 | Space 드래그 / 휠 클릭 드래그 | 팬 |
| 보기 | 우클릭 | 메뉴(정렬·문서 정렬·레이어·잠금) |
| 일반 | Esc | 다이얼로그/메뉴 닫기 |
| (향후) | ? | 단축키 도움말 열기 — **미구현**. 도움말은 상단 바 [단축키] 버튼으로만 연다 |
