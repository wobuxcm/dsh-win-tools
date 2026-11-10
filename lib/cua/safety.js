/**
 * Safety rails and durable logging for dsh-cua-win.
 *
 * Every click goes through one gate: dryRun -> confirm -> blacklist -> stop
 * file -> act. The gate is the ONLY place that turns "the model asked for a
 * click" into "the mouse moved", so audit trails are complete by construction.
 *
 * @module dsh-cua-win/lib/safety
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Default keyword blacklist: money-adjacent UI must never be auto-clicked. */
export const DEFAULT_BLACKLIST = ['支付', '充值', '购买', '授权', '扫码', '付款', '收银', '转账', '下单', '结算', '微信支付', '支付宝']

/** Default settings (overridable through the plugin Config). */
export const DEFAULTS = {
  enabled: true,
  defaultDryRun: true,
  requireConfirm: true,
  screenshotLongEdge: 1600,
  logDir: '',
  blacklist: [...DEFAULT_BLACKLIST],
  maxMacrosPerSession: 20,
  pollMs: 120,
  timeoutMs: 60000,
}

/**
 * DSH home, resolved the same way the host and dsh-agent-desktop resolve it.
 * @returns {string}
 */
export function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim()
    if (value === '~') return homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
    return isAbsolute(value) ? value : join(process.cwd(), value)
  }
  return join(homedir(), '.dsh')
}

/** Plugin state root (logs, shots, baseline). */
export function stateRoot() {
  const override = process.env.CUA_WIN_STATE_ROOT
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(dshHome(), 'cua-win')
}

/** Resolve the effective settings from a raw config object. */
export function resolveConfig(raw) {
  const value = typeof raw === 'object' && raw !== null ? raw : {}
  const list = (v) => (Array.isArray(v) ? v.map(String).filter((s) => s.trim() !== '') : undefined)
  return {
    enabled: value.enabled === undefined ? DEFAULTS.enabled : value.enabled !== false,
    defaultDryRun: value.defaultDryRun === undefined ? DEFAULTS.defaultDryRun : value.defaultDryRun !== false,
    requireConfirm: value.requireConfirm === undefined ? DEFAULTS.requireConfirm : value.requireConfirm !== false,
    screenshotLongEdge: Number.isFinite(value.screenshotLongEdge) && value.screenshotLongEdge > 0 ? value.screenshotLongEdge : DEFAULTS.screenshotLongEdge,
    logDir: typeof value.logDir === 'string' && value.logDir.trim() !== '' ? value.logDir.trim() : join(stateRoot(), 'logs'),
    blacklist: list(value.blacklist) ?? [...DEFAULT_BLACKLIST],
    maxMacrosPerSession: Number.isFinite(value.maxMacrosPerSession) && value.maxMacrosPerSession > 0 ? value.maxMacrosPerSession : DEFAULTS.maxMacrosPerSession,
    pollMs: Number.isFinite(value.pollMs) && value.pollMs >= 30 ? value.pollMs : DEFAULTS.pollMs,
    timeoutMs: Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : DEFAULTS.timeoutMs,
  }
}

// ---------------------------------------------------------------- logging

/**
 * Append one JSONL line to a log file. Logging must never throw into a tool
 * call — failures are swallowed (and best-effort mirrored to console).
 * @param {string} file - absolute path.
 * @param {object} entry
 */
export function logJsonl(file, entry) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
  } catch (error) {
    try {
      console.warn(`[dsh-cua-win] log write failed: ${error?.message ?? error}`)
    } catch {
      // even console can fail in a dead host; nothing more to do
    }
  }
}

/**
 * The action log — every click/drag/typed string/macro lands here.
 * @param {object} config - effective config.
 * @param {object} entry
 */
export function logAction(config, entry) {
  logJsonl(join(config.logDir, 'cua-actions.log'), entry)
}

/** Boot/diagnostic trace (why tools are missing, when they are). */
export function bootLog(line) {
  logJsonl(join(stateRoot(), 'logs', 'cua-boot.log'), { line })
}

// ---------------------------------------------------------------- gates

/** The kill-switch file: its existence aborts every macro loop immediately. */
export function stopFilePath() {
  return join(dshHome(), 'cua.stop')
}

/** @returns true when the operator has dropped a cua.stop file. */
export function isStopped() {
  try {
    return existsSync(stopFilePath())
  } catch {
    return false
  }
}

/**
 * Blacklist check on any number of texts (window title at the point, the
 * foreground window title, ...).
 * @param {object} config
 * @param {string[]} texts
 * @returns {string|null} the matched keyword, or null.
 */
export function blacklistHit(config, texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue
    for (const keyword of config.blacklist) {
      if (keyword !== '' && text.includes(keyword)) return keyword
    }
  }
  return null
}

/**
 * Decide what a destructive call may do.
 *
 * Order: explicit dryRun wins; else defaultDryRun; confirm=true is REQUIRED
 * before real input when requireConfirm is on (a one-shot escape from
 * defaultDryRun), and never sufficient when dryRun was forced.
 *
 * @param {object} config
 * @param {object} args - the tool call arguments.
 * @returns {{dryRun:boolean, reason?:string}}
 */
export function gate(config, args) {
  if (!config.enabled) return { dryRun: true, reason: 'plugin disabled (cua-win enabled=false)' }
  if (isStopped()) return { dryRun: true, reason: `stop file present (${stopFilePath()}); delete it to resume` }
  const explicitDry = args?.dryRun === true
  const confirm = args?.confirm === true
  if (explicitDry) return { dryRun: true, reason: 'dryRun requested' }
  if (config.defaultDryRun) {
    if (confirm) return { dryRun: false, reason: 'confirmed one-shot' }
    return { dryRun: true, reason: 'defaultDryRun=true and confirm not set' }
  }
  if (config.requireConfirm && !confirm) {
    return { dryRun: true, reason: 'requireConfirm=true and confirm not set' }
  }
  return { dryRun: false, reason: 'enabled' }
}
