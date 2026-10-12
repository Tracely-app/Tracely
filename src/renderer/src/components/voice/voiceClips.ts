import { useEffect, useRef, useState } from 'react'
import type { VoiceId } from '@shared/voices'
import lindenClip from '../../assets/voices/linden.mp3'
import atlasClip from '../../assets/voices/atlas.mp3'
import wrenClip from '../../assets/voices/wren.mp3'
import roryClip from '../../assets/voices/rory.mp3'
import kipClip from '../../assets/voices/kip.mp3'
import hollisClip from '../../assets/voices/hollis.mp3'
import sterlingClip from '../../assets/voices/sterling.mp3'

/** Each persona's recorded preview (gpt-live-1, about ten seconds). */
export const VOICE_CLIPS: Record<VoiceId, string> = {
  linden: lindenClip,
  atlas: atlasClip,
  wren: wrenClip,
  rory: roryClip,
  kip: kipClip,
  hollis: hollisClip,
  sterling: sterlingClip
}

/**
 * Play / stop the preview clips, one at a time, through a single Audio
 * element that is paused when the component using it goes away (the picker
 * closing, leaving Settings). Shared by Settings → Voice and the in-call
 * voice picker so both behave the same.
 */
export function useVoicePreview(): { playing: VoiceId | null; toggle: (id: VoiceId) => void } {
  const [playing, setPlaying] = useState<VoiceId | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(
    () => () => {
      audioRef.current?.pause()
      audioRef.current = null
    },
    []
  )

  function toggle(id: VoiceId): void {
    const audio = (audioRef.current ??= new Audio())
    if (playing === id) {
      audio.pause()
      setPlaying(null)
      return
    }
    audio.pause()
    audio.src = VOICE_CLIPS[id]
    audio.currentTime = 0
    audio.onended = () => setPlaying(null)
    audio.onerror = () => setPlaying(null)
    setPlaying(id)
    void audio.play().catch(() => setPlaying(null))
  }

  return { playing, toggle }
}
