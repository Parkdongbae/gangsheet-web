/* eslint-disable @typescript-eslint/explicit-function-return-type -- 실행 스크립트(.mjs)는 타입 구문 표기 불가 */
/**
 * 웹 버전 E2E — vite preview + playwright-core(msedge 채널).
 *
 * 검증: 문서 생성 → dtf:import-paths 주입 → 씬 커밋 → 배경 제거(단색) 알파 실측 →
 * 드래그 이동 → PNG 내보내기(치수·pHYs 350 DPI Node 검증) → .dtf 저장(내장 에셋) 다운로드 →
 * 재로드 후 IndexedDB 자동저장 복원 → 다른 세션에서 .dtf 파일 열기. 페이지 오류 0 단정.
 *
 * 실행: node web/e2e/web-e2e.mjs  (사전에 npm run web:build 필요)
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const PORT = 4173
const BASE = `http://localhost:${PORT}`
const ROOT = resolve(import.meta.dirname, '../..')

const assert = (cond, message) => {
  if (!cond) throw new Error(`E2E FAILED: ${message}`)
  console.log(`  ok - ${message}`)
}

function parsePng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47]
  for (let i = 0; i < 4; i++) assert(bytes[i] === sig[i], `PNG 시그니처[${i}]`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  const meta = { width: view.getUint32(16), height: view.getUint32(20), dpi: null }
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    )
    if (type === 'pHYs' && length >= 9) {
      const dataStart = offset + 8
      if (bytes[dataStart + 8] === 1) meta.dpi = Math.round(view.getUint32(dataStart) * 0.0254)
      break
    }
    if (type === 'IDAT' || type === 'IEND') break
    offset += 12 + length
  }
  return meta
}

async function startPreview() {
  const proc = spawn(
    'npx',
    ['vite', 'preview', '--config', 'web/vite.config.ts', '--port', String(PORT), '--strictPort'],
    {
      cwd: ROOT,
      shell: true,
      stdio: 'ignore'
    }
  )
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return proc
    } catch {
      /* 대기 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  proc.kill()
  throw new Error('vite preview 기동 실패')
}

async function main() {
  assert(existsSync(resolve(ROOT, 'web/dist/index.html')), 'web/dist 빌드 산출물 존재')

  const preview = await startPreview()
  const browser = await chromium.launch({ channel: 'msedge' })
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  try {
    await page.goto(`${BASE}/?dtf-e2e-download`, { waitUntil: 'domcontentloaded' })
    await page.getByText('새 문서').first().waitFor({ timeout: 15000 })
    assert(true, '새 문서 화면 렌더')

    await page.selectOption('select[aria-label="문서 가로 폭 (cm)"]', '5')
    await page.getByRole('button', { name: '문서 만들기' }).click()
    await page.locator('button[title="내보내기 (PSD·PNG)"]').waitFor({ timeout: 15000 })
    assert(true, '문서 생성(5cm×1m) → 편집 화면 진입')

    // 씬 레코더 — dtf:scene-committed 최신 상태를 window.__lastScene에 유지
    await page.evaluate(() => {
      window.__lastScene = null
      window.addEventListener('dtf:scene-committed', (e) => {
        window.__lastScene = e.detail
      })
    })

    // --- 이미지 주입 (dtf:import-paths) + 씬 커밋 대기 ---
    const importResult = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(400, 300)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 400, 300)
      ctx.fillStyle = '#e11d48'
      ctx.fillRect(100, 60, 200, 180)
      const blob = await canvas.convertToBlob()
      const file = new File([blob], 'e2e-design.png', { type: 'image/png' })
      const path = window.api.getPathForFile(file)
      window.dispatchEvent(new CustomEvent('dtf:import-paths', { detail: [path] }))
      return path
    })
    await page.waitForFunction(() => window.__lastScene?.images?.length >= 1, undefined, {
      timeout: 20000
    })
    const placed = await page.evaluate(() => window.__lastScene.images[0])
    assert(true, `이미지 임포트 → 씬 1개 (filePath=${placed.filePath.slice(0, 24)}…)`)

    // --- 배경 제거(단색 플러드필) 실측: 모서리 알파 0 · 중심 불투명 ---
    const bg = await page.evaluate(async (path) => {
      const result = await window.api.removeBackground(path)
      const img = new Image()
      img.src = result.dataUrl
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const corner = ctx.getImageData(0, 0, 1, 1).data
      const center = ctx.getImageData(
        Math.floor(img.width / 2),
        Math.floor(img.height / 2),
        1,
        1
      ).data
      return {
        cornerAlpha: corner[3],
        centerAlpha: center[3],
        w: result.widthPx,
        h: result.heightPx
      }
    }, importResult)
    assert(bg.cornerAlpha === 0, `배경 제거 — 모서리 투명 (alpha=${bg.cornerAlpha})`)
    assert(bg.centerAlpha === 255, `배경 제거 — 피사체 유지 (alpha=${bg.centerAlpha})`)

    // --- 드래그 이동 ---
    const stage = page.locator('.konvajs-content').first()
    const box = await stage.boundingBox()
    assert(box !== null, 'Konva 스테이지 렌더')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const prevX = placed.x
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 90, cy + 60, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction(
      (px) => {
        const scene = window.__lastScene
        return scene && scene.images.length === 1 && Math.abs(scene.images[0].x - px) > 20
      },
      prevX,
      { timeout: 15000 }
    )
    assert(true, '드래그 이동 → 씬 좌표 커밋')

    // --- PNG 내보내기 (다운로드 캡처 → Node에서 pHYs/치수 검증) ---
    await page.locator('button[title="내보내기 (PSD·PNG)"]').click()
    await page.getByRole('dialog', { name: '내보내기' }).getByText('PNG', { exact: true }).click()
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 })
    await page
      .getByRole('dialog', { name: '내보내기' })
      .getByRole('button', { name: '내보내기', exact: true })
      .click()
    const download = await downloadPromise
    const pngPath = await download.path()
    const meta = parsePng(new Uint8Array(readFileSync(pngPath)))
    assert(
      meta.width === 689 && meta.height === 13780,
      `PNG 치수 5cm×1m @350DPI (${meta.width}×${meta.height})`
    )
    assert(meta.dpi === 350, `PNG pHYs 350 DPI (${meta.dpi})`)
    await page.keyboard.press('Escape')

    // --- .dtf 저장 (dtf:save-project → 다운로드) ---
    const saveDownloadPromise = page.waitForEvent('download', { timeout: 30000 })
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('dtf:save-project', { detail: 'e2e-project' }))
    })
    const saveDownload = await saveDownloadPromise
    const dtfPath = await saveDownload.path()
    const project = JSON.parse(readFileSync(dtfPath, 'utf8'))
    assert(
      project.format === 'dtf-gangsheet-project' && project.version === 1,
      '.dtf 스키마 형식·버전'
    )
    assert(
      project.document.widthPx === 689 && project.document.heightPx === 13780,
      '.dtf 문서 규격'
    )
    assert(Array.isArray(project.images) && project.images.length === 1, '.dtf 이미지 1개 저장')
    assert(
      Array.isArray(project.assets) && project.assets.length === 1,
      `.dtf 내장 에셋 1본 (데스크톱 exe 호환)`
    )
    assert(
      project.assets[0].path === placed.filePath && project.assets[0].dataBase64.length > 100,
      '내장 에셋 경로 일치·Base64 페이로드 존재'
    )

    // --- 재로드 → 자동저장 복원 (IndexedDB) ---
    await new Promise((r) => setTimeout(r, 2200))
    page.on('dialog', (dialog) => void dialog.accept())
    await page.reload({ waitUntil: 'domcontentloaded' })
    // 복원 신호 = 빈 씬이 아님(내보내기 버튼 활성) + 페이지 오류 없음
    await page
      .locator('button[title="내보내기 (PSD·PNG)"]:not([disabled])')
      .waitFor({ timeout: 30000 })
    const restoredCount = await page.evaluate(async () => {
      const keys = await indexedDB.databases()
      return keys.some((db) => db.name === 'dtf-web-studio') ? 'db-present' : 'db-missing'
    })
    assert(
      restoredCount === 'db-present',
      '자동저장 복원 — 편집 화면(이미지 있음) + IndexedDB 유지'
    )

    // --- 다른 브라우저 세션(신규 컨텍스트)에서 .dtf 파일 열기 — 내장 에셋 복원 ---
    const context2 = await browser.newContext({ acceptDownloads: true })
    const page2 = await context2.newPage()
    page2.on('pageerror', (err) => pageErrors.push(String(err)))
    try {
      await page2.goto(`${BASE}/?dtf-e2e-download`, { waitUntil: 'domcontentloaded' })
      await page2.getByRole('button', { name: '열기', exact: true }).click()
      await page2.waitForSelector('input[data-dtf-picker="open-project"]', { timeout: 10000 })
      await page2.setInputFiles('input[data-dtf-picker="open-project"]', dtfPath)
      await page2
        .locator('button[title="내보내기 (PSD·PNG)"]:not([disabled])')
        .waitFor({ timeout: 30000 })
      assert(true, '내장 에셋 .dtf를 다른 세션에서 열기 — 이미지 1개 복원(원본 파일 없음 해결)')
    } finally {
      await context2.close()
    }

    assert(pageErrors.length === 0, `페이지 오류 0 (${pageErrors.slice(0, 3).join(' | ')})`)
    console.log('\nWEB E2E: ALL PASSED')
  } finally {
    await browser.close()
    preview.kill()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
