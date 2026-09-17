# DTF GangSheet Studio — 웹 버전 (Single Page Web App)

데스크톱(Electron + Python 사이드카) 앱의 **로직·UI를 그대로 재사용**하는 브라우저판
갱시트 에디터입니다. Electron IPC(`window.api`)만 브라우저 구현으로 교체해
반응형 웹 UI(React + Konva + Tailwind)로 동작하며, 빌드 결과물(`web/dist`)은
정적 파일이라 어떤 웹 서버에나 올릴 수 있습니다.

## 실행

```bash
npm install            # 최초 1회 (ag-psd 의존성 추가됨)
npm run web:dev        # 개발 서버 (Vite)
npm run web:build      # 정적 빌드 → web/dist
npm run web:preview    # 빌드 결과 미리보기
npm run web:typecheck  # 웹 타입체크
```

권장 브라우저: **Chrome / Edge** (File System Access API·OffscreenCanvas 지원).
Firefox/Safari에서도 동작하나 저장·열기가 "다운로드 + 파일 선택" 폴백으로 대체됩니다.

## 아키텍처

```
web/
  index.html            CSP + 진입점
  vite.config.ts        기존 src/ 재사용 alias (@renderer·@core·@workers·@shared)
  src/main.tsx          window.api 웹 구현 설치 → App 마운트 → 자동저장 복원
  src/app.css           렌더러 CSS 재사용 + @source 등록
  src/api/
    webApi.ts           DtfApi(src/types/ipc.ts) 전체 브라우저 구현
    vfs.ts              가상 파일 시스템(메모리 + IndexedDB write-through)
    fsAccess.ts         저장/열기: FS Access API → 다운로드/input 폴백
    imageOps.ts         임포트 프리뷰·단색 배경제거·오토트림·리샘플 업스케일
    exportWorker.ts     풀해상도 렌더 워커 → PNG/PSD 인코딩
    psdFlat.ts          평면 RGB PSD 라이터(350 DPI ResolutionInfo, RLE)
    pngMeta.ts          PNG pHYs(350 DPI) 주입·파싱
    autosave.ts         씬 변경 자동저장(IndexedDB) + 부팅 복원
```

렌더러·코어 소스는 `src/renderer/src`, `src/core`, `src/workers`를 그대로 참조하며,
기존 Electron 앱은 영향을 받지 않습니다(`dtf:scene-committed` 이벤트 등 추가 훅은
Electron에서 수신자가 없는 inert 코드).

## OS 전용 기능 → 웹 API 대응표

| 데스크톱 (Electron/Python)          | 웹 버전                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| 파일 대화상자(`dialog.show*Dialog`) | File System Access API + `<input type=file>` 폴백               |
| 디스크 원본 파일 경로 참조          | 가상 경로(`dtf-vfs://…`) + IndexedDB Blob 보관                  |
| .dtf 저장/열기 | FS Access 쓰기 또는 다운로드 / 업로드 + **자동저장(IndexedDB)** — 저장 시 **원본을 파일에 내장**(선택적 `assets`)해 데스크톱 exe·다른 브라우저에서 바로 열림 |
| PNG 저장(Pillow dpi=350)            | Canvas 인코딩 + **pHYs 청크 350 DPI 주입**                      |
| CMYK PSD 작성(psd-tools + lcms)     | **RGB 8bit PSD**(평면=자체 인코더, 레이어=ag-psd) + 350 DPI     |
| 배경 제거(rembg AI)                 | **단색(흰색 등) 배경 플러드필 제거** + 외부 AI 사이트 링크      |
| 업스케일(RealESRGAN/AnimeVideo AI)  | **단계별 고품질 리샘플**(공유 Plan Builder 체인)                |
| 번들 PDF 열기(shell.openPath)       | `web/public` PDF를 새 탭에서 열기                               |

## 데스크톱 대비 차이점 (알려진 제약)

1. **PSD 색상 모드**: 브라우저에서는 CMYK 변환(lcms)이 불가하므로 **RGB PSD**로
   저장됩니다. 전사업체가 CMYK를 요구하면 데스크톱 버전으로 내보내거나 PNG를
   사용하세요. (다이얼로그 표기도 `RGB · 350 DPI`로 표시됩니다)
2. **배경 제거·업스케일은 AI가 아닙니다**: 단색 배경 제거 플러드필 / 리샘플링
   확대이므로 정밀 누끼·디테일 복원이 필요한 작업은 외부 AI 사이트·데스크톱을
   권장합니다(앱 내 안내 동일).
3. **초대형 문서**: 브라우저 캔버스 상한(약 2.7억 픽셀)때문에 **100cm×2m 문서는
   내보내기에 실패**할 수 있습니다. 50cm×2m, 100cm×1m 이하 권장.
4. **자동저장**: 씬 변경 후 약 1.5초 뒤 IndexedDB에 기록되며 재방문 시 복원
   프롬프트가 뜹니다. 원본 이미지도 IndexedDB에 보관되어 함께 복원됩니다.

## E2E 검증

`web/e2e/web-e2e.mjs` — `vite preview` 서버에 Playwright(playwright-core)로
문서 생성 → 이미지 주입 → 이동 → PNG 내보내기(pHYs·치수 검증) → .dtf 저장 →
자동저장 복원을 실측합니다.
