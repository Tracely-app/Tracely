// Types for env.mjs, which electron.vite.config.ts imports.
//
// The resolver stays plain JavaScript because the node scripts that use it
// (preflight, evaluate, timing, ship) run directly through node with no build
// step. This file is what lets the one TypeScript consumer import it without
// `any`.

export declare const REPO_ROOT: string
export declare const ENV_NAME: 'production' | 'staging'
export declare const ENV_FILE: string

export interface EnvInfo {
  name: 'production' | 'staging'
  file: string
  /** Host of the Tracely server this build talks to, e.g. api.jointracely.com. */
  apiHost: string
  /** True when TRACELY_API_URL set it; false when it is DEFAULT_API_URL. */
  apiFromEnv: boolean
  /** Supabase project ref — the first label of the project host. */
  supabaseRef: string
}

export declare function loadEnv(options?: { root?: string; quiet?: boolean }): EnvInfo

export declare function describeEnv(info: EnvInfo): string

/** Where a build points when TRACELY_API_URL is unset or blank. */
export declare const DEFAULT_API_URL: string

/** TRACELY_API_URL (trailing slashes dropped), or DEFAULT_API_URL. */
export declare function apiUrl(): string

/** The three compile-time constants, already JSON.stringify'd for esbuild. */
export declare function appDefines(): {
  __API_URL__: string
  __SUPABASE_URL__: string
  __SUPABASE_ANON_KEY__: string
}

/** Cassette directory for the active environment, under the given out dir. */
export declare function cassetteDir(outDir: string): string
