import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api'

function loadIframeApi(): Promise<void> {
  return new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve()
      return
    }
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve()
    }
    if (document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
      return
    }
    const tag = document.createElement('script')
    tag.src = IFRAME_API_SRC
    document.body.appendChild(tag)
  })
}

type PlayerPanelProps = {
  videoId: string | null
  shellRef: RefObject<HTMLDivElement | null>
  onStatus: (message: string) => void
  onPlayerReady: (player: YT.Player | null) => void
  /** Opaque strip over top of player to hide YouTube’s title overlay (also appears in tab capture). */
  hideTitleOverlay?: boolean
}

export function PlayerPanel({
  videoId,
  shellRef,
  onStatus,
  onPlayerReady,
  hideTitleOverlay = false,
}: PlayerPanelProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YT.Player | null>(null)
  const [apiLoaded, setApiLoaded] = useState(Boolean(window.YT?.Player))
  const [iframeReady, setIframeReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadIframeApi().then(() => {
      if (!cancelled) setApiLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const destroyPlayer = useCallback(() => {
    if (playerRef.current) {
      try {
        playerRef.current.destroy()
      } catch {
        /* ignore */
      }
      playerRef.current = null
    }
    setIframeReady(false)
    onPlayerReady(null)
  }, [onPlayerReady])

  useEffect(() => {
    if (!apiLoaded || !videoId || !mountRef.current) {
      destroyPlayer()
      return
    }

    let cancelled = false
    destroyPlayer()
    setIframeReady(false)
    onStatus('Loading player…')

    const origin =
      window.location.origin || `${window.location.protocol}//${window.location.host}`

    const timer = window.setTimeout(() => {
      if (cancelled || !mountRef.current || !window.YT?.Player) return
      playerRef.current = new window.YT.Player(mountRef.current, {
        videoId,
        playerVars: {
          enablejsapi: 1,
          origin,
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: () => {
            if (cancelled || !playerRef.current) return
            setIframeReady(true)
            onPlayerReady(playerRef.current)
            onStatus('Player ready')
          },
        },
      })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      destroyPlayer()
    }
  }, [apiLoaded, videoId, destroyPlayer, onStatus, onPlayerReady])

  const showLoadingOverlay = Boolean(videoId && (!apiLoaded || !iframeReady))

  return (
    <div
      ref={shellRef}
      className="player-shell"
      role={videoId ? 'region' : undefined}
      aria-label={videoId ? `YouTube video ${videoId}` : undefined}
    >
      {!videoId && (
        <div className="player-placeholder" role="status">
          <p>No video loaded</p>
          <p className="player-placeholder-hint">
            Paste a URL or ID above, press Load, then use Playback controls when the player is ready.
          </p>
        </div>
      )}
      {videoId && <div ref={mountRef} className="player-mount" />}
      {showLoadingOverlay && (
        <div className="player-loading-overlay" role="status" aria-live="polite">
          <div className="player-loading-pulse" aria-hidden={true} />
          <span className="player-loading-text">
            {!apiLoaded ? 'Loading YouTube player…' : 'Starting video…'}
          </span>
        </div>
      )}
      {videoId && hideTitleOverlay && (
        <div className="player-title-mask" aria-hidden={true} />
      )}
    </div>
  )
}
