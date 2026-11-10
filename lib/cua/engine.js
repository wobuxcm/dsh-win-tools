/**
 * The in-process wait/macro engine — the reason this plugin exists.
 *
 * Everything here runs INSIDE the host process: poll -> condition -> act, with
 * zero model round-trips per iteration. A 60s wait at 120ms polling is ~500
 * comparisons; done in-process that is one tool call, done through the model
 * it would be a thousand.
 *
 * @module dsh-cua-win/lib/engine
 */
import { capture, getShot, imageChangeRatio, parseColor, pixelMatches, regionRatio } from './screen.js'
import { click, keyPress, move, typeText } from './input.js'
import { blacklistHit, isStopped, logAction } from './safety.js'
import { foregroundInfo, sleep, windowAtPoint } from './native.js'

/** Cap on trace entries so a 60s poll storm cannot bloat the tool result. */
const TRACE_CAP = 240

/**
 * Validate and normalize one condition object.
 * @param {object} raw
 * @returns {{type:string, data:object}|{error:string}}
 */
export function normalizeCondition(raw) {
  if (typeof raw !== 'object' || raw === null) return { error: 'condition must be an object' }
  if (raw.pixel_matches !== undefined) {
    const c = raw.pixel_matches
    const rgb = parseColor(c?.color)
    if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y) || !rgb) return { error: 'pixel_matches needs numeric x,y and color "#rrggbb"' }
    return { type: 'pixel_matches', data: { x: c.x, y: c.y, rgb, tolerance: Number.isFinite(c.tolerance) ? c.tolerance : 16 } }
  }
  if (raw.region_ratio !== undefined) {
    const c = raw.region_ratio
    const rgb = parseColor(c?.color)
    const rect = Array.isArray(c?.rect) ? c.rect.map(Number) : null
    if (!rgb || !rect || rect.length !== 4 || rect.some((v) => !Number.isFinite(v)) || rect[2] <= 0 || rect[3] <= 0) {
      return { error: 'region_ratio needs rect [x,y,w,h] and color "#rrggbb"' }
    }
    if (!Number.isFinite(c?.minRatio) || c.minRatio < 0 || c.minRatio > 1) return { error: 'region_ratio needs minRatio in [0,1]' }
    return { type: 'region_ratio', data: { rect, rgb, tolerance: Number.isFinite(c.tolerance) ? c.tolerance : 16, minRatio: c.minRatio } }
  }
  if (raw.image_changed !== undefined) {
    const c = raw.image_changed
    if (typeof c?.baselineShotId !== 'string' || !getShot(c.baselineShotId)) return { error: 'image_changed needs a valid baselineShotId from a previous cua_screen_capture' }
    let rect
    if (c.rect !== undefined) {
      const r = Array.isArray(c.rect) ? c.rect.map(Number) : null
      if (!r || r.length !== 4 || r.some((v) => !Number.isFinite(v)) || r[2] <= 0 || r[3] <= 0) {
        return { error: 'image_changed rect must be [x,y,w,h]' }
      }
      rect = r
    }
    return { type: 'image_changed', data: { baselineShotId: c.baselineShotId, rect, minChangeRatio: Number.isFinite(c.minChangeRatio) ? c.minChangeRatio : 0.02 } }
  }
  if (raw.window_title_contains !== undefined) {
    const c = raw.window_title_contains
    if (typeof c?.pattern !== 'string' || c.pattern.trim() === '') return { error: 'window_title_contains needs a non-empty pattern' }
    return { type: 'window_title_contains', data: { pattern: c.pattern } }
  }
  return { error: 'condition must be one of pixel_matches | region_ratio | image_changed | window_title_contains' }
}

/**
 * Evaluate one normalized condition against the current screen state.
 *
 * @param {{type:string,data:object}} cond
 * @param {object|null} frame - latest capture frame (null for pure-title checks).
 * @returns {{matched:boolean, observed?:number}} observed = ratio or 0/1.
 */
export function evaluateCondition(cond, frame) {
  if (cond.type === 'window_title_contains') {
    const fg = foregroundInfo()
    const title = fg?.title ?? ''
    return { matched: title.toLowerCase().includes(cond.data.pattern.toLowerCase()), observed: title === '' ? 0 : 1 }
  }
  if (!frame) return { matched: false, observed: 0 }
  if (cond.type === 'pixel_matches') {
    const matched = pixelMatches(frame, cond.data.x, cond.data.y, cond.data.rgb, cond.data.tolerance)
    return { matched, observed: matched ? 1 : 0 }
  }
  if (cond.type === 'region_ratio') {
    const ratio = regionRatio(frame, cond.data.rect, cond.data.rgb, cond.data.tolerance)
    return { matched: ratio >= cond.data.minRatio && ratio >= 0, observed: ratio }
  }
  if (cond.type === 'image_changed') {
    const baseline = getShot(cond.data.baselineShotId)
    const ratio = imageChangeRatio(frame, baseline, cond.data.rect)
    return { matched: ratio >= cond.data.minChangeRatio && ratio >= 0, observed: ratio }
  }
  return { matched: false, observed: 0 }
}

/** One condition needs a screen capture to evaluate. */
function conditionNeedsFrame(cond) {
  return cond.type !== 'window_title_contains'
}

/**
 * Build the act function used by both wait_and_click and macro steps.
 *
 * @param {object} config - effective settings.
 * @param {object} gateState - {dryRun, reason} from the safety gate.
 * @param {string} toolName - for the log line.
 * @returns {Function} async (action: {type, x, y, text, keys, ...}) -> result object
 */
export function makeAct(config, gateState, toolName) {
  return async (action) => {
    const type = action?.type ?? 'click'
    const started = Date.now()
    const fgBefore = foregroundInfo()

    if (type !== 'type_text' && type !== 'key_press') {
      const x = Number(action?.x)
      const y = Number(action?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, code: 'INVALID_ARGS', message: `${type} needs numeric x,y` }
      // window under the point: blacklist on its title AND the foreground title
      const at = windowAtPoint(x, y)
      const hit = blacklistHit(config, [at?.title, fgBefore?.title])
      if (hit) {
        logAction(config, { tool: toolName, action: type, x, y, window: at?.title, blocked: true, keyword: hit, gate: gateState.reason })
        return {
          ok: false, code: 'BLOCKED_KEYWORD', keyword: hit,
          message: `refused to click: window title "${at?.title ?? fgBefore?.title ?? '?'}" contains blacklisted keyword "${hit}"`,
        }
      }
    }

    if (gateState.dryRun) {
      const what = type === 'type_text' ? `type_text(${(action?.text ?? '').slice(0, 60)}…)`
        : type === 'key_press' ? `key_press(${action?.keys})`
        : type === 'double_click' ? `double_click(${action?.x},${action?.y})`
        : `${type}(${action?.x},${action?.y})`
      logAction(config, { tool: toolName, action: type, x: action?.x, y: action?.y, dryRun: true, gate: gateState.reason, window: fgBefore?.title })
      return { ok: true, dryRun: true, would: what, gate: gateState.reason, foreground: fgBefore?.title ?? null }
    }

    let result
    if (type === 'click' || type === 'double_click') {
      result = click(action.x, action.y, action.button === 'right' || action.button === 'middle' ? action.button : 'left', type === 'double_click' ? 2 : 1)
    } else if (type === 'move') {
      result = move(action.x, action.y)
    } else if (type === 'type_text') {
      result = await typeText(String(action?.text ?? ''))
    } else if (type === 'key_press') {
      result = await keyPress(String(action?.keys ?? ''), Number(action?.times) || 1)
    } else {
      return { ok: false, code: 'INVALID_ARGS', message: `unknown action type "${type}"` }
    }
    const fgAfter = foregroundInfo()
    const entry = {
      tool: toolName, action: type,
      ...(['click', 'double_click', 'move'].includes(type) ? { x: action.x, y: action.y, cursor: result?.cursor ?? null } : {}),
      ...(type === 'type_text' ? { chars: String(action?.text ?? '').length } : {}),
      ...(type === 'key_press' ? { keys: action?.keys, times: result?.times } : {}),
      window: fgBefore?.title, windowAfter: fgAfter?.title, elapsedMs: Date.now() - started,
    }
    logAction(config, entry)
    return { ok: true, dryRun: false, foreground: fgAfter?.title ?? null, ...(result ?? {}) }
  }
}

/**
 * cua_wait_and_click: poll conditions in-process, act on first match.
 *
 * @param {object} options
 * @param {object} config - effective settings.
 * @param {object} gateState
 * @param {AbortSignal|undefined} signal
 */
export async function waitAndClick(options, config, gateState, signal) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || config.timeoutMs, 500), 600000)
  const pollMs = Math.min(Math.max(Number(options.pollMs) || config.pollMs, 30), 2000)

  const conditions = []
  const conditionSources = Array.isArray(options.conditions) ? options.conditions : options.condition !== undefined ? [options.condition] : []
  for (const raw of conditionSources) {
    const norm = normalizeCondition(raw)
    if (norm.error) return { ok: false, code: 'INVALID_ARGS', message: norm.error }
    conditions.push(norm)
  }
  if (conditions.length === 0) return { ok: false, code: 'INVALID_ARGS', message: 'provide at least one condition (pixel_matches | region_ratio | image_changed | window_title_contains)' }

  const actions = Array.isArray(options.actions) ? options.actions : options.action !== undefined ? [options.action] : []
  if (actions.length === 0) return { ok: false, code: 'INVALID_ARGS', message: 'provide at least one action (click/double_click/type_text/move/key_press)' }
  if (actions.length > 12) return { ok: false, code: 'INVALID_ARGS', message: 'at most 12 actions per wait call' }

  let abortCond = null
  if (options.abortIf !== undefined) {
    const norm = normalizeCondition(options.abortIf)
    if (norm.error) return { ok: false, code: 'INVALID_ARGS', message: `abortIf: ${norm.error}` }
    abortCond = norm
  }

  const act = makeAct(config, gateState, 'cua_wait_and_click')
  const trace = []
  const started = Date.now()
  let attempts = 0
  let lastFrame = null
  let lastShotId = null

  while (true) {
    if (signal?.aborted) return { ok: false, code: 'ABORTED', message: 'session aborted', elapsedMs: Date.now() - started, attempts }
    if (isStopped()) return { ok: false, code: 'STOPPED', message: 'cua.stop file present; macro loop terminated', elapsedMs: Date.now() - started, attempts }

    attempts += 1
    const needFrame = conditions.some(conditionNeedsFrame) || (abortCond !== null && conditionNeedsFrame(abortCond))
    if (needFrame) {
      const shot = capture({ target: 'screen' })
      if (shot.ok) {
        lastFrame = getShot(shot.screenshotId)
        lastShotId = shot.screenshotId
      }
    }

    if (abortCond !== null) {
      const { matched } = evaluateCondition(abortCond, lastFrame)
      if (matched) {
        return { matched: false, aborted: true, attempts, elapsedMs: Date.now() - started, trace: trace.slice(-TRACE_CAP), screenshotId: lastShotId }
      }
    }

    for (const cond of conditions) {
      const { matched, observed } = evaluateCondition(cond, lastFrame)
      if (trace.length < TRACE_CAP && (attempts <= 5 || matched || attempts % 20 === 0)) {
        trace.push({ t: Date.now() - started, cond: cond.type, observed: round(observed, 4) })
      }
      if (matched) {
        const results = []
        for (const action of actions) {
          const result = await act(action)
          results.push(result)
          if (!result.ok) {
            return { matched: true, ok: false, code: result.code, message: result.message, attempts, elapsedMs: Date.now() - started, trace: trace.slice(-TRACE_CAP), screenshotId: lastShotId, actionResults: results }
          }
        }
        return { matched: true, ok: true, attempts, elapsedMs: Date.now() - started, actions: results.length, actionResults: results, trace: trace.slice(-TRACE_CAP), screenshotId: lastShotId }
      }
    }

    if (Date.now() - started >= timeoutMs) {
      return { matched: false, ok: true, timedOut: true, attempts, elapsedMs: Date.now() - started, trace: trace.slice(-TRACE_CAP), screenshotId: lastShotId }
    }
    await sleep(pollMs)
  }
}

/**
 * cua_macro: ordered steps, each optionally waiting on a condition first.
 * @param {object} options
 * @param {object} config
 * @param {object} gateState
 * @param {AbortSignal|undefined} signal
 */
export async function runMacro(options, config, gateState, signal) {
  const steps = Array.isArray(options.steps) ? options.steps : []
  if (steps.length === 0) return { ok: false, code: 'INVALID_ARGS', message: 'steps must be a non-empty array' }
  if (steps.length > 50) return { ok: false, code: 'INVALID_ARGS', message: 'at most 50 steps per macro' }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || config.timeoutMs, 1000), 600000)
  const stepTimeoutMs = Math.min(Math.max(Number(options.stepTimeoutMs) || 20000, 1000), 120000)

  const act = makeAct(config, gateState, 'cua_macro')
  const started = Date.now()
  const results = []

  for (let index = 0; index < steps.length; index += 1) {
    if (signal?.aborted) return { ok: false, code: 'ABORTED', message: `aborted at step ${index}`, steps: results }
    if (isStopped()) return { ok: false, code: 'STOPPED', message: `cua.stop present; terminated at step ${index}`, steps: results }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, code: 'TIMEOUT', message: `macro exceeded ${timeoutMs}ms at step ${index}`, steps: results, elapsedMs: Date.now() - started }
    }

    const step = steps[index]
    const actions = Array.isArray(step.actions) ? step.actions : step.action !== undefined ? [step.action] : []
    if (actions.length === 0) return { ok: false, code: 'INVALID_ARGS', message: `step ${index}: no action(s)` }

    // optional wait inside the step
    let waitInfo = null
    if (step.wait !== undefined) {
      const norm = normalizeCondition(step.wait)
      if (norm.error) return { ok: false, code: 'INVALID_ARGS', message: `step ${index} wait: ${norm.error}` }
      const stepStart = Date.now()
      let attempts = 0
      let frame = null
      while (true) {
        if (signal?.aborted || isStopped()) return { ok: false, code: 'ABORTED', message: `aborted while waiting in step ${index}`, steps: results }
        attempts += 1
        if (conditionNeedsFrame(norm)) {
          const shot = capture({ target: 'screen' })
          if (shot.ok) frame = getShot(shot.screenshotId)
        }
        const { matched, observed } = evaluateCondition(norm, frame)
        if (matched) { waitInfo = { attempts, elapsedMs: Date.now() - stepStart, observed: round(observed, 4) }; break }
        if (Date.now() - stepStart >= stepTimeoutMs) {
          return { ok: false, code: 'WAIT_TIMEOUT', message: `step ${index} wait condition not met within ${stepTimeoutMs}ms`, steps: results }
        }
        if (Date.now() - started >= timeoutMs) {
          return { ok: false, code: 'TIMEOUT', message: `macro exceeded ${timeoutMs}ms while waiting in step ${index}`, steps: results }
        }
        await sleep(Math.min(Math.max(config.pollMs, 30), 500))
      }
    }

    const actionResults = []
    for (const action of actions) {
      const result = await act(action)
      actionResults.push(result)
      if (!result.ok) {
        return { ok: false, code: result.code, message: `step ${index}: ${result.message}`, steps: results, failedStep: index }
      }
    }
    results.push({ step: index, wait: waitInfo, actions: actionResults })
    if (typeof step.delayMs === 'number' && step.delayMs > 0) await sleep(Math.min(step.delayMs, 2000))
  }

  return { ok: true, steps: results, elapsedMs: Date.now() - started }
}

function round(value, digits) {
  if (!Number.isFinite(value)) return value
  const f = 10 ** digits
  return Math.round(value * f) / f
}
