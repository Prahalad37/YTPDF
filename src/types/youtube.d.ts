export {}

declare global {
  namespace YT {
    interface PlayerEvent {
      target: Player
    }

    type OnReadyEvent = PlayerEvent

    interface PlayerOptions {
      videoId?: string
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: (e: OnReadyEvent) => void
        onStateChange?: (e: PlayerEvent) => void
      }
    }

    class Player {
      constructor(elementId: string | HTMLElement, options: PlayerOptions)
      playVideo(): void
      pauseVideo(): void
      getCurrentTime(): number
      getDuration(): number
      seekTo(seconds: number, allowSeekAhead?: boolean): void
      getPlaybackRate(): number
      setPlaybackRate(suggestedRate: number): void
      getAvailablePlaybackRates(): number[]
      destroy(): void
    }
  }

  interface Window {
    YT?: { Player: typeof YT.Player }
    onYouTubeIframeAPIReady?: () => void
  }
}
