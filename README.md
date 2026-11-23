# DTF GangSheet Studio (DTF 전사 배치 및 프리프레스 솔루션)

**DTF GangSheet Studio**는 DTF(Direct-to-Film) 디지털 전사 인쇄용 갱시트(Gang Sheet) 제작에 최적화된
전문 레이아웃 및 프리프레스(Prepress) 데스크톱 애플리케이션입니다.

본 프로그램은 전사업체로 전달할 최종 PSD 파일 생성을 목표로 하며, 인쇄 표준인 **CMYK 색상 공간**,
**350 DPI 고해상도**, **가로 5cm 단위(최대 1m)·세로 1m 단위 규격** 설정을 지원합니다.

> 문서 세트: README(본 파일) · [SKILL](./SKILL.md) · [CLAUDE](./CLAUDE.md) ·
> [DESIGN](./DESIGN.md) · [CLOUD](./CLOUD.md) · [PLAN](./PLAN.md) · [WORKFLOW](./WORKFLOW.md)

---

## 🔑 주요 기능 (Key Features)

### 1. 캔버스 및 문서 설정 (Canvas & Document Settings)
- **가변 가로 폭**: **1cm 단위 선택 5~100cm** (기본 50cm = DTF 인쇄 롤 표준, 6,890px @ 350 DPI).
  최대 1m(100cm) = 13,780px로 PSD 한계(변당 30,000px) 이내.
- **가변 세로 길이**: **1m 단위 선택 — 1m(13,780px) 또는 2m(27,559px)**.
  > ⚠️ **3m(41,339px) 이상은 PSD 표준 최대 치수(변당 30,000px)를 초과해 저장할 수 없다.**
  > 업체가 3m 이상을 요구하면 2m 문서로 분할 출력해야 한다.
- **인쇄 해상도**: **350 DPI** (인치당 도트 수) 고정 적용.
- **색상 프로파일**: **CMYK 모드** (FOGRA39 / Japan Color 2001 / US Web Coated SWOP 지정 가능).
- **자(Ruler)**: 문서 바깥 뷰포트 상단·좌측 cm 눈금 자 — 줌/팬 실시간 추적, 문서 범위 하이라이트.
- **그리드 표시**: 사용자 지정 간격(0.5~50cm)·색상(8프리셋+커스텀)·선 스타일(실선/대시/도트) 격자 오버레이.

### 2. 이미지 불러오기 및 레이아웃 편집 (Image Import & Layout)
- **지원 파일 포맷**: PNG(투명 배경 필수 지원), JPG, JPEG, WEBP, TIFF, BMP.
  PSD 불러오기는 읽기 전용으로 지원(레이어 편집 대상 아님).
- **자유 편집**: Drag & Drop 배치, 위치 이동, 회전(90도 단위 및 1도 단위 정밀 회전),
  고정 비율/자유 비율 크기 조절.
- **복사 및 복제 (Duplicate)**: 동일 디자인 대량 전사용 Quick Copy/Paste(Ctrl+C/V, Ctrl+D) 및 그리드 복제.
- **화면 채우기 (Fit & Fill)**: 선택 이미지를 캔버스 폭/높이 기준 즉시 확대·축소(cover/contain).
- **자동 정렬 및 스냅 (Snapping & Alignment)**: 간격 정렬, 여백 자동 계산, 그리드 라인 스냅.

### 3. 출판 및 저장 (Export & Prepress)
- **PSD 내보내기 (Photoshop Format)**:
  - CMYK(Color Mode 4)·350 DPI 헤더 및 해상도 메타데이터(ResolutionInfo) 포함.
  - 레이어 보존 저장 및 단일 인쇄 레이어 병합 내보내기 옵션.
- **PNG 뷰어/저장**: 투명도(Alpha Channel) 보존 인쇄 확인용 이미지 저장.

### 4. 로드맵 (Roadmap)
- **AI 배경 제거 (Background Removal)**: 데스크톱은 rembg(isnet-general-use) 사이드카, 웹은 브라우저 내
  ISNet(onnxruntime-web · WebGPU/WASM) + 단색 배경 모드 — v0.5.0에서 웹판 AI 도입.
- **밝은/어두운 테마 · 새 시작 화면 (v0.5.0)**: 기본 밝은 테마, 시작 화면·편집기 상단에서 전환.
  기획 문서(PRD·로직 명세·와이어프레임·스키마·UX·MVP/PoC)는 [`docs/`](docs/README.md).
- **학교-집 동시 작업 환경**: `CLOUD.md`의 Git Workflow · Dev Containers · Cloud Asset Sync.

---

## 🛠️ 기술 스택 (Tech Stack — 확정)

| 계층 | 기술 | 비고 |
|---|---|---|
| 에디터 UI | **Electron + React (TypeScript)** | 뷰포트는 프록시 렌더링(72~96DPI) |
| 캔버스 | **Konva.js** (대안: Fabric.js / Pixi.js) | 좌표 변환 매트릭스, 타일 렌더링 |
| PSD 내보내기 엔진 | **Python 3.12+ 사이드카** — `Pillow` + `ImageCms` + `psd-tools` | CMYK 레이어 PSD 생성 |
| 색 관리 | LittleCMS(lcms2) 기반 ICC 변환 | ImageCms가 lcms2 바인딩 |
| 대안 전체 스택 | PySide6 단일 파이썬 앱 | DESIGN §2.3 |

> ⚠️ **`ag-psd`(npm)는 공식적으로 "RGB 외 색상 모드 쓰기 미지원"** — CMYK PSD 저장에 사용 금지.
> PSD 읽기(불러오기)·구조 참고 용도로만 사용한다. 근거: ag-psd 공식 README 제한 사항.

---

## 🚀 시작하기 (Getting Started)

### 요구 사항 (Prerequisites)
- Node.js **v22 LTS** 이상 (에디터)
- Python **3.12+** (내보내기 사이드카)

### 설치 및 실행 (Installation)
```bash
git clone https://github.com/your-org/dtf-gangsheet-studio.git
cd dtf-gangsheet-studio

# 에디터(프론트엔드)
npm install
npm run dev

# 내보내기 사이드카(파이썬)
uv sync                  # 또는: pip install -e ./export-sidecar
```

---

## 📐 픽셀 환산표 (350 DPI)

`px = round(cm ÷ 2.54 × 350)`

| 실물 크기 | 픽셀 | PSD 저장 |
|---|---|---|
| 폭 5cm (최소) | 689 | ✅ |
| 폭 50cm (기본) | 6,890 | ✅ |
| 폭 100cm (1m, 최대) | 13,780 | ✅ (PSD 한계 30,000px 이내) |
| 높이 1m | 13,780 | ✅ |
| 높이 2m | 27,559 | ✅ (PSD 한계 30,000px 이내) |
| 높이 3m | 41,339 | ❌ PSD 한계 초과 — 2m씩 분할 |
| 높이 5m | 68,898 | ❌ |

---

## 📄 라이선스 (License)
본 프로젝트는 Proprietary / Commercial 라이선스 하에 관리됩니다.
