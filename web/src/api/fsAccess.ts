/**
 * 파일 저장/열기 — File System Access API + 폴백 계층.
 *
 * 데스크톱의 Electron 파일 대화상자(dialog.showSaveDialog/showOpenDialog)를 대체:
 * - 지원 브라우저(Chrome/Edge): 네이티브 저장/열기 픽커 + 핸들 직접 쓰기.
 * - 미지원(Firefox/Safari)·헤드리스: <a download> 다운로드 + 숨김 <input type=file>.
 *   (숨김 input은 data-dtf-picker 속성을 가져 E2E setInputFiles 자동화 대상이 된다)
 */

interface WritableFileStreamLike {
  write(data: BlobPart): Promise<void>
  close(): Promise<void>
}

type SavePickerHandle = FileSystemFileHandle & {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableFileStreamLike>
}

type SaveFileOptions = {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string | string[]> }>
}

type WindowWithPickers = Window & {
  showSaveFilePicker?: (options?: SaveFileOptions) => Promise<SavePickerHandle>
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    types?: Array<{ description?: string; accept: Record<string, string | string[]> }>
  }) => Promise<FileSystemFileHandle[]>
}

const pickerWindow = (): WindowWithPickers => window as WindowWithPickers

/** 사용자 취소(AbortError) 식별 — 다른 오류(미지원·헤드리스)는 폴백으로 분기 */
function isUserCancel(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')
  )
}

export type SaveTarget =
  { mode: 'handle'; handle: SavePickerHandle; name: string } | { mode: 'download'; name: string }

/**
 * 저장 위치 선택. 픽커 사용 가능하면 네이티브 픽커(취소 시 null),
 * 아니면 다운로드 폴백(항상 진행 — cancel 개념 없음)으로 분기한다.
 */
// E2E·CI: 픽커 없이 다운로드/숨김 input으로 확정하는 강제 플래그
function e2eDownloadForced(): boolean {
  return new URLSearchParams(window.location.search).has('dtf-e2e-download')
}

export async function pickSaveFile(
  suggestedName: string,
  types: SaveFileOptions['types']
): Promise<SaveTarget | null> {
  if (e2eDownloadForced()) {
    return { mode: 'download', name: suggestedName }
  }
  const picker = pickerWindow().showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker({ suggestedName, types })
      return { mode: 'handle', handle, name: handle.name }
    } catch (err) {
      if (isUserCancel(err)) return null
      // 미지원·제약(헤드리스 등) → 다운로드 폴백
    }
  }
  return { mode: 'download', name: suggestedName }
}

/** 핸들에 Blob 쓰기 (기존 내용 교체) */
export async function writeToHandle(handle: SavePickerHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}

/** 다운로드 폴백 — 앵커 클릭으로 Blob 저장 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout((): void => URL.revokeObjectURL(url), 30_000)
}

/** 범용 열기 — 픽커 우선, 폴백으로 data-dtf-picker 숨김 input */
export async function pickOpenFile(
  pickerId: string,
  types: Array<{ description?: string; accept: Record<string, string | string[]> }>
): Promise<File | null> {
  if (e2eDownloadForced()) {
    const files = await openViaHiddenInput(pickerId, acceptOf(types), false)
    return files[0] ?? null
  }
  const picker = pickerWindow().showOpenFilePicker
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({ multiple: false, types })
      if (handle) return await handle.getFile()
      return null
    } catch (err) {
      if (isUserCancel(err)) return null
      // 폴백 계속
    }
  }
  const files = await openViaHiddenInput(pickerId, acceptOf(types), false)
  return files[0] ?? null
}

/** 다중 이미지 열기 — openImages 계약 */
export async function pickOpenFiles(
  pickerId: string,
  types: Array<{ description?: string; accept: Record<string, string | string[]> }>
): Promise<File[] | null> {
  if (e2eDownloadForced()) return openViaHiddenInput(pickerId, acceptOf(types), true)
  const picker = pickerWindow().showOpenFilePicker
  if (typeof picker === 'function') {
    try {
      const handles = await picker({ multiple: true, types })
      const files: File[] = []
      for (const handle of handles) files.push(await handle.getFile())
      return files
    } catch (err) {
      if (isUserCancel(err)) return null
      // 폴백 계속
    }
  }
  return openViaHiddenInput(pickerId, acceptOf(types), true)
}

function acceptOf(types: Array<{ accept: Record<string, string | string[]> }>): string {
  const values = types.flatMap((entry) => Object.values(entry.accept).flat())
  return values.join(',')
}

function openViaHiddenInput(pickerId: string, accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const existing = document.querySelector(`input[data-dtf-picker="${pickerId}"]`)
    const input = existing instanceof HTMLInputElement ? existing : document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.dataset.dtfPicker = pickerId
    if (!existing) document.body.appendChild(input)
    input.value = ''
    input.onchange = (): void => {
      resolve(Array.from(input.files ?? []))
      input.onchange = null
    }
    // 제스처 체인 밖 호출(자동복원 등)시 change 없으면 창 클릭으로 재시도 가능하게
    input.click()
  })
}

export const IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.psd'

export function acceptExtensionsFor(
  format: 'psd' | 'png' | 'pdf'
): Array<{ description: string; accept: Record<string, string[]> }> {
  if (format === 'psd')
    return [{ description: 'Photoshop PSD', accept: { 'image/vnd.adobe.photoshop': ['.psd'] } }]
  if (format === 'pdf')
    return [{ description: 'PDF 문서', accept: { 'application/pdf': ['.pdf'] } }]
  return [{ description: 'PNG 이미지', accept: { 'image/png': ['.png'] } }]
}
