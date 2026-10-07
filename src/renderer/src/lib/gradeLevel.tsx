import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { REFERENCE_LEVEL, storedGradeLevel } from '@shared/gradeLevel'
import { tracelyApi } from './api'

/**
 * The school year every letter grade in this window is banded against.
 *
 * Context rather than a prop, because the six places that call `gradeFor` —
 * Home's average, the Documents cards, the report, the shared Essay Grade
 * panel — have nothing else to do with settings, and threading a number
 * through four view layers to reach them is how a setting ends up applied in
 * three places out of four.
 *
 * There is no settings-changed IPC event, so this re-reads on `setLevel`,
 * which `SettingsView` calls when the dropdown moves. That keeps the letters
 * on Home correct the moment the user comes back from Settings without adding
 * a channel for one number.
 */
const GradeLevelContext = createContext<{
  level: number
  setLevel: (level: number) => void
}>({ level: REFERENCE_LEVEL, setLevel: () => {} })

export function GradeLevelProvider({ children }: { children: ReactNode }): JSX.Element {
  const [level, setLevel] = useState<number>(REFERENCE_LEVEL)

  useEffect(() => {
    tracelyApi
      .getSettings()
      .then((s) => setLevel(storedGradeLevel(s.gradingLevel)))
      // The reference level is the pre-setting behaviour, so a failed read
      // grades exactly as the app did before this existed rather than showing
      // nothing.
      .catch(() => setLevel(REFERENCE_LEVEL))
  }, [])

  return (
    <GradeLevelContext.Provider value={{ level, setLevel }}>{children}</GradeLevelContext.Provider>
  )
}

/** The current grading level. `REFERENCE_LEVEL` outside a provider. */
export function useGradeLevel(): number {
  return useContext(GradeLevelContext).level
}

/** For Settings, which owns the dropdown that changes it. */
export function useSetGradeLevel(): (level: number) => void {
  return useContext(GradeLevelContext).setLevel
}
