/**
 * 웹 가상 파일 시스템(VFS) — 데스크톱의 "원본 파일 절대 경로" 계약을 대체.
 *
 * Electron에서는 PlacedImage.filePath가 OS 절대 경로였다. 웹에서는 파일을 직접
 * 보관할 수 없으므로 `dtf-vfs://<uuid>/<파일명>` 형태의 가상 경로를 발급하고
 * 원본 Blob을 메모리 + IndexedDB(write-through)에 저장해 재시작 후에도
 * .dtf 프로젝트 복원(hydrate)이 동작하게 한다.
 *
 * - IndexedDB 실패(사설 모드·쿼터 초과)는 기능 정지가 아닌 "세션 한정 저장"으로 강등.
 * - 파일명 표시 규약: ProxyCanvas fileBaseName가 `/`, `\` 분할 + 확장자 제거 — 경로
 *   포맷이 이와 호환된다.
 */

export interface VfsEntry {
  /** 가상 경로 — 키이자 PlacedImage.filePath */
  path: string
  /** 원본 표시 파일명 (확장자 포함) */
  name: string
  /** MIME 타입 */
  type: string
  /** 원본 바이트 */
  blob: Blob
  addedAt: number
}

const DB_NAME = 'dtf-web-studio'
const DB_VERSION = 1
const FILES_STORE = 'files'
const KV_STORE = 'kv'

const entries = new Map<string, VfsEntry>()

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (): void => {
      const db = req.result
      if (!db.objectStoreNames.contains(FILES_STORE))
        db.createObjectStore(FILES_STORE, { keyPath: 'path' })
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE)
    }
    req.onsuccess = (): void => resolve(req.result)
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const req = run(transaction.objectStore(store))
        req.onsuccess = (): void => resolve(req.result)
        req.onerror = (): void => reject(req.error ?? new Error('IndexedDB request failed'))
      })
  )
}

/** 영속화 실패는 경고로만 삼킨다 — 메모리 VFS는 계속 동작 (세션 한정 강등) */
function persistQuietly(entry: VfsEntry): void {
  tx(FILES_STORE, 'readwrite', (s) => s.put(entry)).catch((err: unknown) => {
    console.warn('[dtf-vfs] IndexedDB 저장 실패 (세션 한정 모드):', err)
  })
}

/** 파일명 경로 정리 — 경로 구분자·제어문자 제거 */
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '_')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('')
  return cleaned.length > 0 ? cleaned : 'image'
}

function issuePath(name: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `dtf-vfs://${uuid}/${name}`
}

function put(name: string, blob: Blob, type: string): VfsEntry {
  const entry: VfsEntry = {
    path: issuePath(name),
    name,
    type,
    blob,
    addedAt: Date.now()
  }
  entries.set(entry.path, entry)
  persistQuietly(entry)
  return entry
}

/** 사용자가 선택·드롭한 File 등록 → 가상 경로 발급 */
export function registerFile(file: File): string {
  return put(sanitizeName(file.name), file, file.type || 'application/octet-stream').path
}

/** 배경 제거·트림·업스케일 산출물 등 생성 Blob 등록 */
export function registerBlob(name: string, blob: Blob, type = 'image/png'): string {
  return put(sanitizeName(name), blob, type).path
}

/** 내장 에셋 복원 — 원 경로 그대로 재등록(.dtf assets 로드용, 신규 경로 발급 안 함) */
export function restoreEntry(path: string, name: string, type: string, blob: Blob): void {
  const entry: VfsEntry = { path, name, type, blob, addedAt: Date.now() }
  entries.set(path, entry)
  persistQuietly(entry)
}

export function getEntry(path: string): VfsEntry | undefined {
  return entries.get(path)
}

export function requireBlob(path: string): Blob {
  const entry = entries.get(path)
  if (!entry) throw new Error(`원본을 찾을 수 없습니다: ${vfsDisplayName(path)}`)
  return entry.blob
}

export function has(path: string): boolean {
  return entries.has(path)
}

/** 경로 → 표시 파일명 (ProxyCanvas fileBaseName와 동일 규칙) */
export function vfsDisplayName(path: string): string {
  const seg = path.split(/[\\/]/).pop() ?? path
  return seg.replace(/\.[^.]+$/, '') || path
}

/** 확장자 포함 파일명 — 레이어명·저장 제안 파일명 등 */
export function vfsFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** 부팅 시 IndexedDB에서 이전 세션 자산 복원 (실패 무시) */
export async function loadPersisted(): Promise<number> {
  try {
    const all = await tx<VfsEntry[]>(
      FILES_STORE,
      'readonly',
      (s) => s.getAll() as IDBRequest<VfsEntry[]>
    )
    for (const entry of all) {
      if (entry && typeof entry.path === 'string' && entry.blob instanceof Blob) {
        entries.set(entry.path, entry)
      }
    }
  } catch (err) {
    console.warn('[dtf-vfs] IndexedDB 복원 실패:', err)
  }
  return entries.size
}

/** 디버그·E2E 정리용 */
export async function clearAll(): Promise<void> {
  entries.clear()
  try {
    await tx(FILES_STORE, 'readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>)
    await tx(KV_STORE, 'readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>)
  } catch {
    /* 세션 한정 모드 — 이미 메모리만 정리됨 */
  }
}

// ---- kv 저장소 (자동저장 프로젝트 등 작은 JSON) ----

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await tx<T>(KV_STORE, 'readonly', (s) => s.get(key) as IDBRequest<T>)) ?? undefined
  } catch {
    return undefined
  }
}

export async function kvSet<T>(key: string, value: T): Promise<boolean> {
  try {
    await tx(KV_STORE, 'readwrite', (s) => s.put(value, key) as unknown as IDBRequest<IDBValidKey>)
    return true
  } catch {
    return false
  }
}

export async function kvDelete(key: string): Promise<void> {
  try {
    await tx(KV_STORE, 'readwrite', (s) => s.delete(key) as unknown as IDBRequest<undefined>)
  } catch {
    /* 무시 */
  }
}
