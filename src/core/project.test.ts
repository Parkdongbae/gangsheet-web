import { describe, expect, it } from 'vitest'
import {
  PROJECT_EXTENSION,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  validateProjectData,
  ProjectFormatError,
  type ProjectData
} from './project'

const validProject = (): ProjectData => ({
  format: PROJECT_FORMAT,
  version: PROJECT_VERSION,
  document: { widthPx: 6890, heightPx: 13780 },
  images: [
    {
      id: 'a1',
      filePath: 'C:/imgs/red.png',
      widthPx: 600,
      heightPx: 400,
      x: 100.5,
      y: -20,
      rotation: 45
    }
  ]
})

describe('validateProjectData — 정상 스키마', () => {
  it('유효 프로젝트 통과 + 미지 필드 제거(정규화)', () => {
    const raw = { ...validProject(), unknownField: 'x' }
    const result = validateProjectData(raw)
    expect(result).toEqual(validProject())
    expect(Object.keys(result)).toEqual(['format', 'version', 'document', 'images'])
  })

  it('빈 이미지 목록 허용 (문서만 저장)', () => {
    const result = validateProjectData({ ...validProject(), images: [] })
    expect(result.images).toEqual([])
  })

  it('음수 좌표·회전·소수 x/y 허용 (캔버스 밖 배치 대비)', () => {
    expect(() => validateProjectData(validProject())).not.toThrow()
  })

  it('이미지 치수 소수 허용 — 리사이즈·비율 연산 결과(2026-09-03 접수: 1206.99…px 거부 결함)', () => {
    const raw = validProject()
    raw.images[0].heightPx = 1206.9961977186313
    raw.images[0].widthPx = 1809.5
    expect(() => validateProjectData(raw)).not.toThrow()
  })
})

describe('validateProjectData — 스키마 위반 거부', () => {
  it.each([
    ['루트가 객체 아님', 'not-object'],
    ['format 불일치', { ...validProject(), format: 'other-app' }],
    ['버전 불일치(향후 마이그레이션 지점)', { ...validProject(), version: 2 }],
    ['document 누락', { format: PROJECT_FORMAT, version: PROJECT_VERSION, images: [] }],
    ['images가 배열 아님', { ...validProject(), images: 'x' }]
  ])('%s → throw', (_name, raw) => {
    expect(() => validateProjectData(raw)).toThrow(ProjectFormatError)
  })

  it('문서 치수 — 양의 정수 아닌 값 거부', () => {
    for (const bad of [0, -1, 1.5, '6890', NaN, Infinity]) {
      const raw = { ...validProject(), document: { widthPx: bad, heightPx: 13780 } }
      expect(() => validateProjectData(raw), `widthPx=${String(bad)}`).toThrow(ProjectFormatError)
    }
  })

  it('문서 치수 — PSD 30,000px 한계 초과 거부', () => {
    const raw = { ...validProject(), document: { widthPx: 30_001, heightPx: 1000 } }
    expect(() => validateProjectData(raw)).toThrow(/PSD/)
  })

  it('이미지 항목 — id·filePath 빈 문자열 거부, 치수 양수 강제(0·음수 거부, 소수는 허용)', () => {
    const badId = validProject()
    badId.images[0].id = ''
    expect(() => validateProjectData(badId)).toThrow(/id/)

    const badPath = validProject()
    badPath.images[0].filePath = ''
    expect(() => validateProjectData(badPath)).toThrow(/filePath/)

    for (const bad of [0, -1, NaN, Infinity]) {
      const badDim = validProject()
      badDim.images[0].widthPx = bad
      expect(() => validateProjectData(badDim), `widthPx=${String(bad)}`).toThrow(/widthPx/)
    }
  })

  it('이미지 x/y/rotation — 유한수 강제 (NaN 거부)', () => {
    const raw = validProject()
    raw.images[0].rotation = NaN
    expect(() => validateProjectData(raw)).toThrow(/rotation/)
  })
})

describe('validateProjectData — 그룹(groupId) 저장', () => {
  it('groupId 문자열 보존 — 같은 값 공유 시 그룹 유지', () => {
    const raw = validProject()
    raw.images.push({ ...raw.images[0], id: 'a2', groupId: 'g-1' })
    raw.images[0].groupId = 'g-1'
    const result = validateProjectData(raw)
    expect(result.images[0].groupId).toBe('g-1')
    expect(result.images[1].groupId).toBe('g-1')
  })

  it('groupId 생략·빈 문자열 → undefined 정규화 (v1 하위 호환)', () => {
    const raw = validProject()
    raw.images[0].groupId = ''
    const result = validateProjectData(raw)
    expect(result.images[0].groupId).toBeUndefined()
    const legacy = validateProjectData(validProject())
    expect(legacy.images[0].groupId).toBeUndefined()
  })

  it('groupId 비문자열 타입 거부 아님 — undefined 정규화', () => {
    const raw = { ...validProject() }
    const image = { ...raw.images[0], groupId: 123 }
    const withNumber = { ...raw, images: [image] }
    expect(validateProjectData(withNumber).images[0].groupId).toBeUndefined()
  })

  it('locked true 보존·false/비불 값은 undefined 정규화 (v1 하위 호환)', () => {
    const locked = validProject()
    locked.images[0].locked = true
    expect(validateProjectData(locked).images[0].locked).toBe(true)

    const falsy = validProject()
    falsy.images[0].locked = false
    expect(validateProjectData(falsy).images[0].locked).toBeUndefined()

    const legacy = validateProjectData(validProject())
    expect(legacy.images[0].locked).toBeUndefined()
  })
})

describe('validateProjectData — 내장 에셋(웹 저장)', () => {
  const withAssets = (): ProjectData => ({
    ...validProject(),
    images: [
      { ...validProject().images[0], filePath: 'dtf-vfs://u1/logo.png' },
      { ...validProject().images[0], id: 'a2', filePath: 'dtf-vfs://u1/logo.png' }
    ],
    assets: [
      { path: 'dtf-vfs://u1/logo.png', name: 'logo.png', type: 'image/png', dataBase64: 'aGVsbG8=' }
    ]
  })

  it('유효 에셋 보존 — 같은 path를 참조하는 이미지 2개도 1본만 내장', () => {
    const result = validateProjectData(withAssets())
    expect(result.assets).toHaveLength(1)
    expect(result.assets![0]).toEqual({
      path: 'dtf-vfs://u1/logo.png',
      name: 'logo.png',
      type: 'image/png',
      dataBase64: 'aGVsbG8='
    })
  })

  it('같은 path 중복 에셋은 첫 항목으로 정규화', () => {
    const raw = withAssets()
    raw.assets.push({ ...raw.assets[0], dataBase64: 'eHl6' })
    const result = validateProjectData(raw)
    expect(result.assets).toHaveLength(1)
    expect(result.assets![0].dataBase64).toBe('aGVsbG8=')
  })

  it('빈 배열·미지정은 assets 필드 없음 (데스크톱 저장 형태와 동일)', () => {
    expect(validateProjectData({ ...withAssets(), assets: [] }).assets).toBeUndefined()
    expect(validateProjectData(validProject()).assets).toBeUndefined()
  })

  it.each([
    ['배열 아님', { ...withAssets(), assets: 'x' }],
    ['항목이 객체 아님', { ...withAssets(), assets: ['x'] }],
    ['path 누락', { ...withAssets(), assets: [{ name: 'a', type: 't', dataBase64: 'QQ==' }] }],
    [
      '빈 dataBase64',
      { ...withAssets(), assets: [{ path: 'p', name: 'a', type: 't', dataBase64: '' }] }
    ]
  ])('%s → throw', (_name, raw) => {
    expect(() => validateProjectData(raw)).toThrow(ProjectFormatError)
  })
})

describe('프로젝트 상수', () => {
  it('확장자 .dtf · 포맷·버전 식별자', () => {
    expect(PROJECT_EXTENSION).toBe('dtf')
    expect(PROJECT_FORMAT).toBe('dtf-gangsheet-project')
    expect(PROJECT_VERSION).toBe(1)
  })
})
