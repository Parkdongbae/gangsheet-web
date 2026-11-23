/**
 * 배경 제거 진행률·남은 시간 예측 — 순수 로직(Vitest 대상).
 *
 * 실제 진행률을 알 수 있는 구간은 모델 다운로드뿐이고, 준비(init)·분석(infer)·
 * 다듬기(refine)·저장(encode)은 한 번의 호출이라 중간값이 없다. 그래서 단계별 예상
 * 소요 시간을 두고 "경과 / (경과 + 남은 예상)"으로 전체 %와 남은 시간을 계산한다.
 * 예상값은 이 기기에서 실제로 걸린 시간으로 매번 보정해 localStorage에 저장한다.
 */
export type BgStage = 'download' | 'init' | 'infer' | 'refine' | 'encode'
export type BgBackend = 'webgpu' | 'wasm'

export const STAGE_ORDER: readonly BgStage[] = ['download', 'init', 'infer', 'refine', 'encode']

/** 보정 대상 예상값 — refine·encode는 이미지 크기에 비례하므로 메가픽셀당 ms */
export interface BgTimingProfile {
  initMs: number
  inferMs: number
  refineMsPerMp: number
  encodeMsPerMp: number
}

export const DEFAULT_PROFILES: Record<BgBackend, BgTimingProfile> = {
  webgpu: { initMs: 3000, inferMs: 2500, refineMsPerMp: 250, encodeMsPerMp: 250 },
  wasm: { initMs: 5000, inferMs: 12000, refineMsPerMp: 250, encodeMsPerMp: 250 }
}

/** 첫 실행(세션 없음)에만 드는 단계 */
const FIRST_RUN_ONLY: ReadonlySet<BgStage> = new Set(['download', 'init'])

export function expectedStageMs(
  stage: BgStage,
  profile: BgTimingProfile,
  megapixels: number
): number {
  switch (stage) {
    case 'download':
      return 0 // 다운로드는 실제 속도로 따로 계산
    case 'init':
      return profile.initMs
    case 'infer':
      return profile.inferMs
    case 'refine':
      return Math.max(150, profile.refineMsPerMp * megapixels)
    case 'encode':
      return Math.max(150, profile.encodeMsPerMp * megapixels)
  }
}

export interface EstimateInput {
  stage: BgStage
  /** 다운로드 단계의 실제 진행률 0..1 */
  ratio?: number
  /** 전체 시작 후 경과(ms) */
  elapsedMs: number
  /** 현재 단계 진입 후 경과(ms) */
  stageElapsedMs: number
  megapixels: number
  profile: BgTimingProfile
}

export interface Estimate {
  percent: number
  etaSeconds?: number
}

/**
 * 전체 진행률(%)과 남은 시간(초). 예상보다 오래 걸리면 현재 단계의 남은 시간을
 * "지금까지 걸린 시간의 25%"로 늘려 잡아, 100%에 붙은 채 멈춘 것처럼 보이지 않게 한다.
 */
export function estimateProgress(input: EstimateInput): Estimate {
  const { stage, ratio, elapsedMs, stageElapsedMs, megapixels, profile } = input
  const index = STAGE_ORDER.indexOf(stage)

  let currentRemaining: number
  let etaKnown = true
  if (stage === 'download') {
    const r = Math.min(0.999, Math.max(0, ratio ?? 0))
    if (r < 0.02 || stageElapsedMs < 400) {
      currentRemaining = 8000
      etaKnown = false
    } else {
      currentRemaining = (stageElapsedMs * (1 - r)) / r
    }
  } else {
    const expected = expectedStageMs(stage, profile, megapixels)
    currentRemaining = Math.max(expected - stageElapsedMs, stageElapsedMs * 0.25, 200)
  }

  let laterRemaining = 0
  for (const later of STAGE_ORDER.slice(index + 1)) {
    laterRemaining += expectedStageMs(later, profile, megapixels)
  }

  const remaining = currentRemaining + laterRemaining
  const percent = Math.max(1, Math.min(99, Math.round((elapsedMs / (elapsedMs + remaining)) * 100)))
  return etaKnown ? { percent, etaSeconds: Math.max(1, Math.round(remaining / 1000)) } : { percent }
}

/** 실측값으로 예상값 보정(지수이동평균) — 첫 실행 전용 단계는 측정됐을 때만 반영 */
export function updateProfile(
  profile: BgTimingProfile,
  timings: Partial<Record<BgStage, number>>,
  megapixels: number,
  firstRun: boolean
): BgTimingProfile {
  const mix = (prev: number, next: number | undefined): number =>
    next === undefined || !Number.isFinite(next) || next <= 0
      ? prev
      : Math.round(prev * 0.4 + next * 0.6)
  const mp = Math.max(0.05, megapixels)
  return {
    initMs: firstRun ? mix(profile.initMs, timings.init) : profile.initMs,
    inferMs: mix(profile.inferMs, timings.infer),
    refineMsPerMp: mix(
      profile.refineMsPerMp,
      timings.refine === undefined ? undefined : timings.refine / mp
    ),
    encodeMsPerMp: mix(
      profile.encodeMsPerMp,
      timings.encode === undefined ? undefined : timings.encode / mp
    )
  }
}

export function isFirstRunStage(stage: BgStage): boolean {
  return FIRST_RUN_ONLY.has(stage)
}
