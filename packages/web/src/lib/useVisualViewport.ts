import { useEffect, useState } from 'react'

/**
 * Returns the current visual viewport height in pixels.
 *
 * On mobile, the visual viewport shrinks when the soft keyboard appears.
 * Using this value instead of `100dvh` / `window.innerHeight` ensures that
 * the main chat container never gets hidden behind the keyboard.
 *
 * On desktop (no keyboard) the value equals `window.innerHeight`.
 */
export function useVisualViewport(): number {
  const [height, setHeight] = useState<number>(
    () => window.visualViewport?.height ?? window.innerHeight
  )

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const handler = (): void => { setHeight(vv.height) }

    vv.addEventListener('resize', handler)
    vv.addEventListener('scroll', handler)

    return () => {
      vv.removeEventListener('resize', handler)
      vv.removeEventListener('scroll', handler)
    }
  }, [])

  return height
}
