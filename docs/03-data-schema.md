# 데이터 스키마

- **문서 목적**: `.dtf` 프로젝트 파일, 런타임 모델, 내보내기 매니페스트, 웹 저장소(IndexedDB·localStorage·Cache Storage)의 구조·키·검증 규칙·호환 규칙을 고정한다. (v0.5.0)
- **대상 독자**: 구현 엔지니어, QA, 파일 호환성 검토자
- **최종 수정일**: 2026-11-23 (v0.5.0)

> 출처 표기: 경로가 적힌 항목은 v0.5.0 코드에서 확인한 사실이다. 이전 판의 "제안" 키·이름은 모두 구현되었거나(`dtf:bg-mode`, `dtf-bg-models-v1`) 폐기되었다(`dtf-onboarding-seen`).

---

## 1. `.dtf` 프로젝트 파일 (`src/core/project.ts`)

### 1.1 형식

- 확장자 `dtf`(`PROJECT_EXTENSION`), 내용은 **JSON**(UTF-8). 웹 저장은 `JSON.stringify(data, null, 2)`, MIME `application/json`.
- 식별: `format === 'dtf-gangsheet-project'`(`PROJECT_FORMAT`), `version === 1`(`PROJECT_VERSION`).
- **프리뷰 dataUrl은 저장하지 않는다** — 로드 시 `filePath`에서 재생성(파일 경량화).

### 1.2 `ProjectData`

```jsonc
{
  "format": "dtf-gangsheet-project",
  "version": 1,
  "document": { "widthPx": 6890, "heightPx": 13780 },
  "images": [
    {
      "id": "uuid",
      "filePath": "…",           // 데스크톱: OS 절대 경로 / 웹: dtf-vfs://<uuid>/<파일명>
      "widthPx": 1206.99,        // 350 DPI 절대 px, 소수 허용
      "heightPx": 800,
      "x": 120, "y": 340,        // 노드 원점(Konva 원점 피벗) 문서 px
      "rotation": 90,            // 도, 정규화 (-180, 180]
      "groupId": "uuid",         // 선택
      "locked": true             // 선택 (true일 때만 저장)
    }
  ],
  "assets": [                    // 선택 — 웹 저장 시 원본 내장
    { "path": "dtf-vfs://…", "name": "logo.png", "type": "image/png", "dataBase64": "…" }
  ]
}
```

### 1.3 필드 규칙과 검증 (`validateProjectData`)

| 필드 | 타입 | 검증 | 위반 시 |
|---|---|---|---|
| `format` | string | `=== 'dtf-gangsheet-project'` | `ProjectFormatError('unsupported format: …')` |
| `version` | number | `=== 1` (마이그레이션 지점은 이 분기) | `unsupported version: …` |
| `document.widthPx/heightPx` | number | **양의 정수**, 각 ≤ **30,000**(`PSD_MAX_PX`) | `must be a positive integer` / `document exceeds PSD 30000px limit` |
| `images` | array | 배열이어야 함 | `images must be an array` |
| `images[].id` | string | 비어있지 않음 | `images[i].id must be a non-empty string` |
| `images[].filePath` | string | 비어있지 않음 | 동일 형식 |
| `images[].widthPx/heightPx` | number | **양수**(정수 강제 금지 — 리사이즈 결과는 소수) | `must be a positive number` |
| `images[].x/y/rotation` | number | 유한수 | `must be a finite number` |
| `images[].groupId` | string? | 비어있지 않은 문자열만 유지, 그 외 `undefined` | 조용히 정규화 |
| `images[].locked` | boolean? | `=== true`만 유지, 그 외 `undefined` | 조용히 정규화 |
| `assets` | array? | 미정의 허용, 배열 아니면 오류. **빈 배열은 `undefined`로 정규화** | `assets must be an array` |
| `assets[].path/name/type/dataBase64` | string | 모두 비어있지 않음 | `assets[i].… must be a non-empty string` |
| `assets` 중복 `path` | — | **첫 항목만 유지** | 조용히 정규화 |
| 미지 필드 | — | **제거**(정규화) — 구형 리더는 `assets`를 제거하고 연다 | — |

검증은 로드뿐 아니라 **저장 직전**(`saveProject`, 자동저장)에도 실행되어 손상 파일 생성을 막는다.

### 1.4 내장 에셋 (웹) / 링크 (데스크톱)

| 저장 환경 | `images[].filePath` | `assets` |
|---|---|---|
| 데스크톱 | OS 절대 경로 (링크 기반) | 생략 |
| 웹 | `dtf-vfs://<uuid>/<파일명>` | **원본 Base64 내장** (`withEmbeddedAssets`) → 다른 브라우저·데스크톱에서 바로 열림 |

로드(`openProject`): `assets`가 있으면 `restoreEntry(path, name, type, blob)`로 **원 경로 그대로** VFS에 재등록(신규 경로 발급 안 함). 로드 후 `hydrateProjectImages`가 각 `filePath`로 `importImage`를 호출해 프리뷰를 재생성하며, 원본이 없는 항목은 **제외하고** "원본 파일을 찾을 수 없어 N개 항목을 제외했습니다" 알림(`projectIO.ts`).

웹 `saveProject`는 파일 저장과 동시에 **링크 형태(assets 제거)**로 자동저장 레코드도 갱신한다(`kvSet('autosave-project', …)`).

### 1.5 스키마 진화 · 호환 규칙

| 규칙 | 내용 |
|---|---|
| 버전 정책 | 필수 필드 의미 변경·삭제는 `PROJECT_VERSION` 증가 + `validateProjectData`에 변환 분기 추가. **선택 필드 추가는 증가하지 않는다**(v1의 `groupId`, `locked`, `assets`가 그 사례) |
| 하위 호환 | 새 버전 리더는 이전 버전을 열 수 있어야 한다(변환 분기). v0.5.0 리더는 v0.4.x가 만든 version 1 파일을 그대로 연다 |
| 상위 호환 | 구버전 리더가 새 파일을 열면 `unsupported version` 오류(현재) — 선택 필드만 추가한 경우는 미지 필드 제거로 열림 |
| **v0.5.0 결정** | **`PROJECT_VERSION`을 올리지 않는다.** v0.5.0의 신규 기능(테마·배경 제거 모드)은 프로젝트 데이터가 아니라 **브라우저 로컬 설정**(§6)에 저장되므로 `.dtf` 스키마 변경이 없다 |
| 신규 필드 추가 시 | 반드시 선택(optional), 기본값 정의, 검증에서 타입 불일치는 조용히 무시(`groupId` 패턴), `ProjectImage`와 `SceneCommittedDetail`(autosave)에 함께 반영, 테스트 추가 |
| 금지 | 문서 한계(30,000px)를 푸는 변경, 3m+ 값을 허용하는 변경 |

---

## 2. 런타임 모델 `PlacedImage` (`ProxyCanvas.tsx`)

`ProjectImage` + 런타임 전용 필드. 모든 좌표·치수는 350 DPI 절대 px.

| 필드 | 타입 | 저장 | 설명 |
|---|---|---|---|
| `id` | string | ✓ | 씬 내 유일 (복제 시 새 UUID) |
| `filePath` | string | ✓ | 원본 키 (VFS 경로 또는 OS 경로) |
| `dataUrl` | string | ✗ | ≤2,048px PNG 프리뷰(알파 보존), 로드 시 재생성 |
| `widthPx`, `heightPx` | number | ✓ | 현재 치수 — **회전 전** 치수 |
| `x`, `y` | number | ✓ | 노드 원점. 회전은 원점 기준(Konva 원점 피벗) |
| `rotation` | number | ✓ | (−180, 180] |
| `groupId?` | string | ✓ | 같은 값 = 같은 그룹 |
| `locked?` | boolean | ✓ | 이동·변형·삭제·정렬 보호 |

씬 배열 순서 = z순서. 선택(`selectedIds`)·히스토리(`past/future`, 100단계)·그리드 설정·체커·방향키 스텝·뷰 변환은 **저장되지 않는 세션 상태**.

씬 변경 이벤트: `window.dispatchEvent(new CustomEvent('dtf:scene-committed', { detail: SceneCommittedDetail }))` — `{ widthPx, heightPx, images[{id,filePath,widthPx,heightPx,x,y,rotation,groupId?,locked?}] }`. 자동저장이 수신(Electron에서는 수신자 없음). E2E 훅: `dtf:open-project`(detail=경로 문자열), `dtf:import-paths`, `dtf:save-project`.

배경 제거 결과는 `PlacedImage.filePath`만 새 VFS 경로(`<원본>_nobg.png`)로 치환하며, 모드·모델 정보는 `PlacedImage`에 **저장하지 않는다**.

---

## 3. `ExportManifest` (`src/workers/exportManifest.ts`)

Electron↔사이드카(Python) 및 웹 워커 공용 계약. **경로 + cm 좌표만** 담는다(바이너리·Base64 금지, stdio 2KB 상한 회귀 테스트 대상).

```ts
interface ExportManifest {
  output_path: string
  canvas: { width_cm: number; height_m: number; dpi: number }   // dpi 기본 350
  items: Array<{
    src: string        // filePath (VFS 경로 또는 OS 경로)
    x_cm: number; y_cm: number
    width_cm: number; height_cm: number
    rotation: number
  }>
  format?: 'psd' | 'png' | 'pdf'   // 기본(psd)은 생략
  flatten?: boolean                // true일 때만 포함, PSD 단일 병합 레이어
}
```

- 변환: `x_cm = px × 2.54 / dpi`, `height_m = pxToCm(heightPx) / 100`. 워커는 `cmToPx`(반올림)로 복원.
- `ExportProgress { stage: 'items' | 'write'; current; total }`, `ExportResult { output_path, width_px, height_px, layer_count, duration_ms }` (`src/types/ipc.ts`).
- 매니페스트는 파일로 저장하지 않는 **일시 메시지**이므로 버전 필드가 없다. 필드 추가는 선택 필드로(기본값 생략 규칙 유지).

---

## 4. 웹 저장소: IndexedDB (`web/src/api/vfs.ts`)

- DB 이름 `dtf-web-studio`, 버전 `1` (`DB_NAME`, `DB_VERSION`).

| 스토어 | keyPath / 키 | 값 | 용도 |
|---|---|---|---|
| `files` | keyPath `path` | `VfsEntry { path, name, type, blob, addedAt }` | 원본/생성 Blob (write-through 영속화) |
| `kv` | 외부 키(문자열) | 임의 JSON | 작은 문서(자동저장 등) |

- `path` 형식: `dtf-vfs://<crypto.randomUUID()>/<sanitizedName>` (UUID 미지원 환경은 `Date.now().toString(36)-랜덤8자`). `sanitizeName`: `\`·`/` → `_`, 제어문자(< 0x20) 제거, 빈 값은 `image`.
- 표시명 규칙: 마지막 세그먼트에서 확장자 제거(`vfsDisplayName`) — `ProxyCanvas.fileBaseName`과 동일.
- 메모리 맵 `entries`가 1차 캐시, IndexedDB는 재시작 복원용. 부팅 시 `loadPersisted()`가 `files`를 `getAll`해 `entries`에 적재(`blob instanceof Blob` 확인).
- 실패 강등: IndexedDB 미지원·사설 모드·쿼터 초과 시 `persistQuietly`가 경고만 남기고 **세션 한정(메모리) 모드**로 계속 동작. `kvSet`은 `false`, `kvGet`은 `undefined` 반환.
- 정리: `clearAll()`(디버그/E2E) — 메모리 + 두 스토어 비움. **현재 GC 없음**: 삭제된 이미지·치환된 원본의 Blob이 `files`에 남는다. 용량 점검 UI/정리 로직은 구현하지 않았다(향후, `04` §10).
- 스키마 변경 시: `DB_VERSION` 증가 + `onupgradeneeded`에서 스토어 추가(기존 `contains` 가드 패턴).

### 4.1 `kv` 키

| 키 | 값 | 기록 시점 |
|---|---|---|
| `autosave-project` | `{ data: ProjectData(assets 제외), savedAt: number(ms) }` | 씬 변경 1,500ms 디바운스 / 명시적 저장 시 |

이어하기 카드의 "이미지 개수·저장 시각·규격"은 레코드를 확장하지 않고 `data.images.length`, `savedAt`, `data.document`로 계산한다(`webApi.getResumableSession`).

---

## 5. 자동저장 레코드와 규칙 (`web/src/api/autosave.ts`)

| 항목 | 값 |
|---|---|
| 키 | `kv['autosave-project']` |
| 값 | `{ data: ProjectData, savedAt: number }` (`validateProjectData` 통과분만, `assets` 없음 — 원본은 `files` 스토어에) |
| 디바운스 | 1,500ms (`DEBOUNCE_MS`), 변경 연속 시 타이머 재설정 |
| 빈 씬 | **기록하지 않음**(이미지 0개) — 새 문서 화면 진입이 직전 자동저장을 덮어쓰는 사고 방지 |
| 가상 경로 | `web-autosave://last` — `openProject`가 이 값이면 kv에서 읽어 `filePath: '자동 저장 문서'`로 반환 |
| 복원 흐름 | `window.confirm`은 제거됨. 시작 화면이 `window.api.getResumableSession()`(`ResumableSession { path, savedAt, imageCount, widthPx, heightPx }`, 이미지 1개 이상일 때만)로 "이어서 작업하기" 카드를 그리고, 클릭 시 `openProject('web-autosave://last')` 경로로 복원. 시작 화면에 돌아올 때마다 다시 조회 |
| 검증 실패 | 비정상 씬은 기록 건너뜀(저장 실패보다 안전) |
| 복원 실패 | `자동 저장된 작업이 없습니다` 오류 → 시작 화면에서 `alert("프로젝트 열기 실패: …")` / 원본 누락 항목 제외 |

주의: 자동저장 레코드는 **마지막 1개**뿐(히스토리 없음). 다른 탭에서 동시에 편집하면 마지막 기록이 이긴다(탭 간 잠금 없음, 사용자 안내 문구도 없음).

---

## 6. localStorage 키

| 키 | 값 | 기본값 | 위치 | 비고 |
|---|---|---|---|---|
| `dtf:auto-trim` | `'on'` \| `'off'` | ON(`!== 'off'`) | `ProxyCanvas.tsx` | 기존 키, 콜론 구분자 |
| `dtf-theme` | `'light'` \| `'dark'` | `'light'` | `src/renderer/src/theme.ts` | 하이픈 구분자(위 키와 다름 — 통일하지 않음) |
| `dtf:bg-mode` | `'ai'` \| `'solid'` | `'ai'` | `ProxyCanvas.tsx` | 마지막으로 고른 배경 제거 방식(웹 전용 UI) |
| `dtf:bg-backend` | `'wasm'` | 없음(WebGPU 우선) | `web/src/api/bgRemoval/bgClient.ts` | 문제 해결용 강제 스위치. 개발자 도구에서 `localStorage.setItem('dtf:bg-backend','wasm')` 후 새로고침하면 WebGPU를 건너뜀. UI 없음 |

폐기: 이전 판의 `dtf-onboarding-seen`(코치마크)은 구현하지 않았다. `dtf-bg-mode`는 `dtf:bg-mode`(콜론)로 확정됐다.

규칙:
- 모든 접근은 `try/catch` — 실패 시 기본값으로 동작하고 에러 표시 안 함.
- 알 수 없는 값은 기본값으로 처리(예: `dtf-theme = 'blue'` → `'light'`, `dtf:bg-mode` 가 `'solid'`가 아니면 `'ai'`).
- 저장 용량이 작은 **UI 선호**만 둔다. 문서·이미지는 localStorage에 넣지 않는다.
- 개인정보: 키에 사용자 식별자·파일명을 넣지 않는다.

---

## 7. 배경 제거 모델 캐시: Cache Storage

| 항목 | 값 |
|---|---|
| 저장소 | **Cache Storage**(`caches.open`), `fetch` 응답 단위. IndexedDB가 아님. 워커(`bgWorker.ts`)가 기록·조회 |
| 캐시 이름 | `dtf-bg-models-v1` (확정) |
| 요청 키 | 리비전 고정 URL `https://huggingface.co/imgly/isnet-general-onnx/resolve/440dea96dd4a3b06bbbf5abec3e26569dd7ec49f/onnx/` + `model_fp16.onnx`(WebGPU용, 약 84MB) 또는 `model.onnx`(WASM용, 약 168MB). 한 브라우저는 보통 둘 중 하나만 받는다 |
| 무결성 | 응답 스트림을 끝까지 읽은 뒤에만 `cache.put`(`res.ok` 확인). 읽는 도중 끊기면 저장하지 않음. 응답 크기와 예상 크기의 일치 검증은 하지 않음 |
| 조회 | 세션 생성 전 `cache.match(url)` — 적중 시 네트워크 0. 세션은 워커 안에서 재사용 |
| 삭제 | UI 없음. 필요하면 DevTools에서 `dtf-bg-models-v1` 캐시를 지운다. 모델을 바꿀 때는 접미사를 올리는 규칙이나 이전 캐시 자동 삭제는 구현하지 않음 |
| 용량 | 쿼터 사전 확인(`navigator.storage.estimate()`)은 구현하지 않음. `cache.put` 실패(공간 부족)는 무시하고 다음 방문에 다시 내려받는다 |
| 실패 강등 | `caches` 접근 실패(일부 사설 모드)는 캐시 없이 진행(매 세션 다운로드), 사용자 안내 문구는 없음 |
| 라이선스 | 모델 MIT(`imgly/isnet-general-onnx`), onnxruntime-web 1.31.1 MIT — `web/public/THIRD_PARTY_LICENSES.txt`에 기재됨 |
| 프라이버시 | 이 캐시에는 **모델 가중치만** 저장. 사용자 이미지·마스크는 저장하지 않음 |

ONNX 런타임: onnxruntime-web 1.31.1의 WASM(`ort-wasm-simd-threaded.asyncify.wasm`)을 Vite `?url`로 번들에 포함해 `'self'`로 제공한다(CDN 미사용). 번들에 포함되는 WASM 런타임은 28.7MB(gzip 7.2MB). 모델 가중치는 번들에 없다.

---

## 8. 기타 영속/전송 데이터 정리

| 데이터 | 위치 | 서버 전송 |
|---|---|---|
| 사용자 이미지·프로젝트 | IndexedDB `files`/`kv`, 사용자가 저장한 `.dtf`/내보내기 파일 | **없음** |
| 모델 가중치 | Cache Storage | 다운로드만(수신), 업로드 없음 |
| UI 선호 | localStorage | 없음 |
| 시작 화면 대표 이미지 | 앱 번들 에셋 `hero.webp`(1200×900, 47KB) | 없음(동일 출처) |
| 배경 제거 외부 사이트 | 사용자가 링크 클릭 시 새 탭 | 사용자가 해당 사이트에 직접 업로드(앱은 관여 안 함) |

---

## 9. 변경 시 체크리스트

1. `ProjectImage`/`ProjectData` 변경 → `validateProjectData`, `autosave.ts`(`SceneCommittedDetail`/`toProjectData`), `projectIO.ts`, 테스트(`project.test.ts` 등) 동기화.
2. IndexedDB 스토어 추가 → `DB_VERSION++` + `onupgradeneeded`.
3. 새 localStorage 키 → §6 표에 추가, `try/catch` 기본값 확인.
4. 새 외부 호스트 접근 → `web/index.html` CSP(`connect-src`) 및 `03` §7·`PRD` 개인정보 항목 갱신.
