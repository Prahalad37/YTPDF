import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export function useAnimatedNumber(target: number, durationMs = 900): number {
  const [v, setV] = useState(target)
  const vRef = useRef(v)
  useLayoutEffect(() => {
    vRef.current = v
  })

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      queueMicrotask(() => setV(target))
      return
    }
    const from = vRef.current
    let raf: number
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - (1 - t) ** 2
      const next = Math.round(from + (target - from) * eased)
      setV(next)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return v
}
