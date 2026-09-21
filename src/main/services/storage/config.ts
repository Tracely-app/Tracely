import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import dotenv from 'dotenv'
import { getAppPaths } from './paths'
import { INSTALL_ID_FIELD, isInstallId, readOrCreateInstallId } from './installId'

export interface AppConfig {
  semanticScholarApiKey: string | null
  ncbiApiKey: string | null
}

let config: AppConfig | null = null
let configPath: string | null = null
let envLoaded = false
let installId: string | null = null

function getConfigPath(): string {
  if (!configPath) {
    configPath = join(getAppPaths().dataDir, 'config.json')
  }
  return configPath
}

// dotenv.config() does not overwrite variables already present in the real
// environment, so calling this repeatedly is harmless — the flag is only to
// avoid the file read.
function envDefaults(): AppConfig {
  if (!envLoaded) {
    dotenv.config({ path: join(getAppPaths().appRoot, '.env') })
    envLoaded = true
  }
  return {
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || null,
    ncbiApiKey: process.env.NCBI_API_KEY || null
  }
}

function readStored(): Partial<AppConfig> {
  const path = getConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppConfig>
  } catch (error) {
    // A truncated or hand-edited config.json used to throw straight out of
    // getConfig, which every provider calls — one bad character in a file the
    // user is invited to edit took the whole app down at boot.
    console.warn('[config] config.json is unreadable — falling back to environment', error)
    return {}
  }
}

/**
 * Merged view of stored settings over environment defaults.
 *
 * This used to short-circuit on `existsSync(configPath)` and return the stored
 * file verbatim, consulting `.env` only when no file existed. Since the file
 * was written on first boot with whatever `.env` held at the time — usually
 * nothing — adding a key to `.env` afterwards was silently ignored forever, on
 * every machine that had ever launched the app. The failure mode was the worst
 * kind: no error, just a provider that quietly stayed unauthenticated.
 *
 * Env-derived values are deliberately *not* written back. config.json holds
 * only what was explicitly set through Settings; anything still unset falls
 * through to `.env` on every read, so editing `.env` keeps working.
 */
export function getConfig(): AppConfig {
  if (config) return config

  const defaults = envDefaults()
  const stored = readStored()

  config = {
    semanticScholarApiKey: stored.semanticScholarApiKey ?? defaults.semanticScholarApiKey,
    ncbiApiKey: stored.ncbiApiKey ?? defaults.ncbiApiKey
  }
  return config
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  // Persist the stored layer plus the patch — never the merged view, which
  // would bake the current environment into the file and reintroduce the
  // shadowing bug the next time someone edited .env.
  //
  // readStored() returns every key in the file, so the install id rides
  // through untouched. The one exception is a config.json that was unreadable
  // when the id was asked for: readStored() then returns {}, and the id this
  // session has been sending lives only in memory. Saving settings rewrites the
  // file anyway, so that is the moment to put the id back rather than let the
  // next launch mint a second one.
  const stored: Record<string, unknown> = { ...readStored(), ...patch }
  if (installId && !isInstallId(stored[INSTALL_ID_FIELD])) stored[INSTALL_ID_FIELD] = installId
  writeFileSync(getConfigPath(), JSON.stringify(stored, null, 2))
  config = null
  return getConfig()
}

/**
 * This installation's id, sent to the Tracely server as `X-Tracely-Install` on
 * every AI call so a signed-out install gets a daily quota of its own rather
 * than sharing its school's address. Created on first read, never regenerated
 * — see installId.ts for why both halves of that matter.
 *
 * Held in memory after the first read: the id cannot change underneath a
 * running app, and when config.json cannot be written the in-memory copy is
 * what keeps it stable for the rest of the session.
 */
export function getInstallId(): string {
  if (installId) return installId
  const result = readOrCreateInstallId(getConfigPath())
  if (!result.persisted) {
    console.warn('[config] could not store the install id in config.json — using one for this session only')
  }
  installId = result.id
  return installId
}
