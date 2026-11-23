# CLAUDE.md — AI 코딩 어시스턴트 개발 지침서

이 문서는 **DTF GangSheet Studio** 프로젝트에서 AI 어시스턴트(Claude, Cursor 등)가 코드 작성,
리팩토링 및 아키텍처 설계를 수행할 때 따라야 하는 철칙과 개발 가이드라인입니다.

---

## 1. 프로젝트 핵심 개발 규칙 (Core Rules)

1. **해상도 및 정밀도 보존**:
   - 모든 캔버스 좌표 계산은 항상 **실물 단위(cm)** 또는 **350 DPI 절대 픽셀** 기준으로 내부 수치화.
   - UI 화면 표현용 스케일(Zoom Level)은 뷰 변환에서만 처리하고 내부 데이터에 반영 금지.

2. **CMYK 및 알파 채널 파이프라인**:
   - DTF 전사는 **Alpha Channel(투명도) = 백색 잉크 영역**이 핵심. JPG 변환 등으로 알파 채널 유실 금지.
   - PSD 저장 시 색상 모드는 반드시 **Color Mode `4`(CMYK)** — *주: `3`은 RGB, 혼동 금지* —
     및 **350 DPI 메타데이터**(ResolutionInfo, Image Resource ID 1005 / `0x03ED`)를 기록해야 함.
   - 에디터 캔버스는 항상 RGB로 렌더링. RGB→CMYK 변환은 내보내기 시 1회만 수행.

3. **PSD 치수 한계 (절대 규칙)**:
   - PSD 표준 최대 치수는 **변당 30,000px**. 세로 길이 프리셋은 **1m(13,780px)과 2m(27,559px)만 허용**.
   - 3m(41,339px) 이상의 옵션·계산 경로·UI 항목 생성 금지. 요청 시 "2m 분할"로 안내.

4. **PSD 쓰기 엔진 (절대 규칙)**:
   - `ag-psd`(npm)는 **RGB 쓰기 전용**(공식 제한) — CMYK PSD 저장에 사용 금지.
   - CMYK PSD 쓰기는 **Python 사이드카(psd-tools)** 에서만 수행.

5. **학교-집 크로스 개발 환경 지원 (`CLOUD.md` 준수)**:
   - 코드에 OS 절대 경로 사용 금지 — `path.resolve`(Node) / `pathlib`(Python) 사용.
   - 환경 의존적 라이브러리는 Docker / Dev Container 호환성을 고려할 것.

---

## 2. 코드 스타일 및 아키텍처 가이드라인

### 2.1 코드 구조 (Code Architecture)
```
dtf-gangsheet-studio/
├── src/                          # Electron + React (에디터)
│   ├── core/
│   │   ├── math/                 # DPI·cm-px 변환, 바운딩 박스 정렬 수학 함수
│   │   └── color/                # 프록시 표시색 관리 (CMYK 변환은 사이드카 담당)
│   ├── components/
│   │   ├── canvas/               # Konva 기반 대형 캔버스 뷰포트(프록시 렌더링)
│   │   ├── toolbar/              # 이미지 조작, 복사, 채우기, 세로 길이 선택 도구
│   │   └── sidebar/              # Layer 관리 및 문서 설정 (cm 단위)
│   ├── workers/                  # 프록시 렌더링용 백그라운드 웹워커
│   └── types/                    # DocumentConfig, CanvasObject 등 공유 인터페이스
└── export-sidecar/               # Python 3.12+ (내보내기 엔진)
    ├── renderer.py               # 레이어별 풀해상도 렌더 (바운딩 박스만)
    ├── color.py                  # ImageCms 기반 RGB→CMYK 변환
    ├── psd_writer.py             # psd-tools 래퍼 (Color Mode 4, 350 DPI 리소스)
    └── server.py                 # stdio/HTTP 진입점 (Electron 메인과 통신)
```

### 2.2 자주 사용하는 계산식 가이드 (Standard Math)
```typescript
// cm to pixel converter
export const cmToPx = (cm: number, dpi: number = 350): number => {
  return Math.round((cm / 2.54) * dpi);
};

// Default Dimensions @ 350 DPI
export const DTF_WIDTH_CM = 50;
export const CANVAS_WIDTH_PX = cmToPx(DTF_WIDTH_CM, 350);   // 6,890 px
export const PSD_MAX_PX = 30_000;                            // PSD 표준 한계

// 세로 프리셋: 1m, 2m만 허용 (3m+는 PSD 한계 초과로 금지)
export const HEIGHT_PRESETS_M = [1, 2] as const;

export const getCanvasHeightPx = (heightInMeters: number): number => {
  const px = cmToPx(heightInMeters * 100, 350);              // 1m → 13,780, 2m → 27,559
  if (px > PSD_MAX_PX) throw new Error('PSD 최대 치수(30,000px) 초과 — 2m 단위로 분할할 것');
  return px;
};
```

---

## 3. 명령어 (Commands)

| 작업 | 명령 |
|---|---|
| 에디터 개발 | `npm run dev` |
| 린트 / 타입체크 / 테스트 | `npm run lint` / `npm run typecheck` / `npm test` |
| 사이드카 검사 | `uv run ruff check .` / `uv run pyright` / `uv run pytest` |
| Windows 빌드 | `npm run build:win` (electron-builder + PyInstaller 사이드카 번들) |

---

## 4. 작업 완료 조건 (Definition of Done)

`SKILL.md` §4 검증 체크리스트 전부 통과 + lint/typecheck/test 통과.
**배경 제거는 구현 완료** — 데스크톱은 rembg 사이드카(`export-sidecar/removebg.py`), 웹은 브라우저 내
AI(`web/src/api/bgRemoval/`, ISNet + onnxruntime-web)와 단색 배경 모드. 기획·규칙은 `docs/` 참조.

---

## 5. 세션 운영 및 단계 종료 자동 프로토콜 (`PLAN.md`·`WORKFLOW.md` 준수 — 토큰 절약)

Z.ai GLM Coding Plan 할당량 보호를 위해 다음을 반드시 지킨다.

- **세션 시작**: `summary.md` + `.agent/PLAN.md`의 해당 단계 항목만 읽고 시작. 전체 프로젝트 탐색 금지.
- **계획 우선**: 코드 작성 전 구현 계획을 3단계로 요약해 제시하고, 승인 후 착수한다.
- **단계/세션 완료 시 자동 수행 (사용자가 요청하지 않아도)**:
  1. `summary.md` 갱신(진행 상황·결정 사항·다음 세션 정보)
  2. 해당 단계 완료 기준 검증 + lint/typecheck/test
  3. `git commit` + `git push origin dev` (CLOUD.md §1)
  4. 사용자에게 `/clear` 권장 + 다음 세션 시작 프롬프트(WORKFLOW.md §2 양식) 안내
- **에러 로그**: 핵심 메시지 + 스택 상단 20~30줄만 다룬다.
- **첨부 금지**: 대용량 이미지(.psd/.png)·로그는 경로로만 참조한다.
- **캐싱**: 연동 도구의 Z.ai 컨텍스트 캐싱이 활성화된 설정을 유지한다.
