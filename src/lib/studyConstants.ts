/** Default seconds of video timeline between Automate captures (and seek-scan steps). */
export const DEFAULT_CAPTURE_INTERVAL_VIDEO_SEC = 10

export const CAPTURE_INTERVAL_VIDEO_SEC_MIN = 1
export const CAPTURE_INTERVAL_VIDEO_SEC_MAX = 600

export function clampCaptureIntervalVideoSec(sec: number): number {
  return Math.min(
    CAPTURE_INTERVAL_VIDEO_SEC_MAX,
    Math.max(CAPTURE_INTERVAL_VIDEO_SEC_MIN, Math.round(sec)),
  )
}

/** Seek step for skip back / forward (buttons and keyboard). */
export const SEEK_STEP_SECONDS = 10

/** Wall-clock ms between auto captures so spacing matches video timeline at `playbackRate`. */
export function autoCaptureWallIntervalMs(
  playbackRate: number,
  intervalVideoSec: number,
): number {
  return (intervalVideoSec * 1000) / Math.max(playbackRate, 0.25)
}

/** Preferred speeds; actual options are intersected with `getAvailablePlaybackRates()`. */
export const PREFERRED_PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const

/** Delay after seek before capture so the iframe shows the new frame. */
export const SEEK_SCAN_SETTLE_MS = 480
