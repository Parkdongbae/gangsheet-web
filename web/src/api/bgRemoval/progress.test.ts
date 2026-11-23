import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILES, estimateProgress, expectedStageMs, updateProfile } from './progress'

const profile = DEFAULT_PROFILES.webgpu

describe('estimateProgress', () => {
  it('다운로드 초반에는 %만 주고 남은 시간은 보류한다', () => {
    const out = estimateProgress({
      stage: 'download',
      ratio: 0.01,
      elapsedMs: 200,
      stageElapsedMs: 200,
      megapixels: 2,
      profile
    })
    expect(out.etaSeconds).toBeUndefined()
    expect(out.percent).toBeGreaterThanOrEqual(1)
  })

  it('다운로드는 실제 속도로 남은 시간을 계산한다', () => {
    // 10초에 50% → 다운로드 10초 + 이후 단계 예상
    const out = estimateProgress({
      stage: 'download',
      ratio: 0.5,
      elapsedMs: 10_000,
      stageElapsedMs: 10_000,
      megapixels: 1,
      profile
    })
    const later =
      expectedStageMs('init', profile, 1) +
      expectedStageMs('infer', profile, 1) +
      expectedStageMs('refine', profile, 1) +
      expectedStageMs('encode', profile, 1)
    expect(out.etaSeconds).toBe(Math.round((10_000 + later) / 1000))
  })

  it('단계가 뒤로 갈수록 %가 커진다', () => {
    const at = (stage: 'init' | 'infer' | 'refine' | 'encode', elapsedMs: number): number =>
      estimateProgress({ stage, elapsedMs, stageElapsedMs: 100, megapixels: 2, profile }).percent
    expect(at('init', 1000)).toBeLessThan(at('infer', 4000))
    expect(at('infer', 4000)).toBeLessThan(at('refine', 6500))
    expect(at('refine', 6500)).toBeLessThan(at('encode', 7000))
  })

  it('예상보다 오래 걸려도 99%를 넘지 않고 남은 시간이 1초 이상이다', () => {
    const out = estimateProgress({
      stage: 'init',
      elapsedMs: 120_000,
      stageElapsedMs: 120_000,
      megapixels: 2,
      profile
    })
    expect(out.percent).toBeLessThanOrEqual(99)
    expect(out.etaSeconds).toBeGreaterThanOrEqual(1)
    // 멈춘 듯 보이지 않게 남은 시간을 경과의 25% 이상으로 늘려 잡는다
    expect(out.etaSeconds).toBeGreaterThanOrEqual(30)
  })
})

describe('updateProfile', () => {
  it('실측값 쪽으로 예상값을 옮긴다', () => {
    const next = updateProfile(
      profile,
      { init: 1000, infer: 1000, refine: 400, encode: 200 },
      2,
      true
    )
    expect(next.initMs).toBeLessThan(profile.initMs)
    expect(next.inferMs).toBeLessThan(profile.inferMs)
    expect(next.refineMsPerMp).toBe(Math.round(profile.refineMsPerMp * 0.4 + 200 * 0.6))
    expect(next.encodeMsPerMp).toBe(Math.round(profile.encodeMsPerMp * 0.4 + 100 * 0.6))
  })

  it('세션 재사용 실행에서는 준비 시간을 건드리지 않는다', () => {
    const next = updateProfile(profile, { infer: 1500 }, 2, false)
    expect(next.initMs).toBe(profile.initMs)
    expect(next.refineMsPerMp).toBe(profile.refineMsPerMp)
  })
})
