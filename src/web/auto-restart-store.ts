import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeAutoRestartConfig,
  DEFAULT_AUTO_RESTART,
  type AutoRestartConfig,
} from '../auto-restart.js'

// Per-agent auto-restart config lives in one JSON map keyed by agent name
// (the main orchestrator included, under its agent id). A single file keeps the
// main session and sub-agents uniform and sidesteps the per-agent-dir vs
// PROJECT_ROOT config-path split.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'auto-restart.json')

function readRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** All configured agents, normalized. Agents with no entry are simply absent. */
export function readAllAutoRestartConfigs(): Record<string, AutoRestartConfig> {
  const raw = readRaw()
  const out: Record<string, AutoRestartConfig> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    out[name] = normalizeAutoRestartConfig(cfg)
  }
  return out
}

/** One agent's config, normalized; the disabled default when unset. */
export function readAutoRestartConfig(name: string): AutoRestartConfig {
  const raw = readRaw()
  return name in raw ? normalizeAutoRestartConfig(raw[name]) : { ...DEFAULT_AUTO_RESTART }
}

// The main channels session ALWAYS comes back fresh: performRestart routes it to
// restartMainChannelsSession(), which never reads cfg.mode. Storing 'continue'
// there is a field the runner cannot honour, and the damage is not cosmetic --
// someone who sees the field, flips it, observes no change and concludes "so
// that is not the cause" has been handed a false disproof. The write path
// therefore stores what will actually happen.
//
// ON THE WRITE PATH ONLY, AND THAT IS LOAD-BEARING: the runner warns when the
// STORED mode is not 'fresh', which is how a direct file edit -- the one route
// that bypasses this function -- still leaves a trace. Normalizing on read
// would make that condition permanently false and silently delete the warning.
export function mainAgentModeIsFresh(name: string, cfg: AutoRestartConfig): AutoRestartConfig {
  if (name !== MAIN_AGENT_ID || cfg.mode === 'fresh') return cfg
  return { ...cfg, mode: 'fresh' }
}

/** Persist one agent's config (normalized first so the store stays clean). */
export function writeAutoRestartConfig(name: string, cfg: unknown): AutoRestartConfig {
  const normalized = mainAgentModeIsFresh(name, normalizeAutoRestartConfig(cfg))
  const raw = readRaw()
  raw[name] = normalized
  atomicWriteFileSync(STORE_PATH, JSON.stringify(raw, null, 2))
  return normalized
}
