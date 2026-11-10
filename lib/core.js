/**
 * dsh-win-tools core — backend routing without any DSH imports.
 *
 * Backends stay where they already work:
 *  - UIA structure/actions: the agent-desktop native CLI (spawn per call)
 *  - pixel input / screenshots / window enumeration: dsh-cua-win lib (dynamic import)
 *  - browser DOM: the dsh-browser web.js CLI (spawn)
 *
 * Every write action is refused while the operator pause file exists.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const PATHS = {
  home: HOME,
  agentBin: process.env.PC_AGENT_BIN || join(ROOT, 'bin', 'agent-desktop-win32-x64.exe'),
  cuaDir: process.env.PC_CUA_DIR || join(HERE, 'cua'),
  browserJs: process.env.PC_BROWSER_JS || join(ROOT, 'bin', 'web.js'),
  nodeBin: process.env.PC_NODE_BIN || (process.versions.electron ? 'node' : process.execPath),
  pauseFile: join(HOME, 'cua.stop'),
  activeFile: join(HOME, 'cua.active'),
  indicatorPid: join(HOME, 'indicator.pid'),
  logFile: join(HOME, 'win-tools.log'),
  shotDir: join(HOME, 'win-tools', 'shots'),
}

/**
 * Append one JSONL record to %DSH_HOME%/win-tools.log.
 * @param {object} entry - free-form fields; a UTC timestamp is added.
 * @remarks Logging must never break a tool call, so every failure is swallowed.
 */
export function log(entry) {
  try {
    mkdirSync(dirname(PATHS.logFile), { recursive: true })
    writeFileSync(PATHS.logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', { flag: 'a' })
  } catch {
    // logging must never break a tool call
  }
}

/**
 * True while the operator pause file (%DSH_HOME%/cua.stop) exists.
 * @returns {boolean}
 * @remarks Checked before every write action; the Ctrl+Alt+Shift+F12 hotkey only
 *          toggles this file, so the two paths always agree.
 */
export function isPaused() {
  return existsSync(PATHS.pauseFile)
}

/**
 * Create or remove the operator pause file and report the resulting state.
 * @param {boolean} on - true to pause, false to resume.
 * @returns {{ok: true, paused: boolean, file: string}}
 */
export function setPaused(on) {
  if (on) {
    mkdirSync(dirname(PATHS.pauseFile), { recursive: true })
    writeFileSync(PATHS.pauseFile, 'paused by operator\n')
  } else {
    try { rmSync(PATHS.pauseFile, { force: true }) } catch {}
  }
  const state = isPaused()
  log({ tool: 'pc_pause', paused: state })
  return { ok: true, paused: state, file: PATHS.pauseFile }
}

/**
 * Touch the activity timestamp so the on-screen indicator lights up.
 * @param {string} tool - short tag stored in the file (for debugging).
 * @remarks The indicator polls this file's mtime; a failed write is ignored so the
 *          visual hint can never break a tool call.
 */
export function markActive(tool) {
  try {
    mkdirSync(dirname(PATHS.activeFile), { recursive: true })
    writeFileSync(PATHS.activeFile, new Date().toISOString() + ' ' + String(tool || '') + String.fromCharCode(10))
  } catch {}
}

function run(file, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const child = spawn(file, args, { windowsHide: true })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      if (!settled) { settled = true; resolve({ code: -1, stdout: out, stderr: err + '\n[timeout]', timedOut: true }) }
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (!settled) { settled = true; resolve({ code: -1, stdout: out, stderr: String(e.message) }) }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!settled) { settled = true; resolve({ code, stdout: out, stderr: err }) }
    })
  })
}

async function runAgent(args, opts) {
  const res = await run(PATHS.agentBin, args, opts)
  const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean)
  let parsed = null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { parsed = JSON.parse(lines[i]); break } catch {}
  }
  if (parsed) return parsed
  return { ok: false, code: 'CLI_OUTPUT', exitCode: res.code, raw: res.stdout.slice(0, 1500), stderr: res.stderr.slice(0, 800) }
}

// The agent-desktop CLI speaks its own window ids ("w-1575036"); pc_window hands
// out raw HWNDs. Accept either form so callers can pass whatever they have.
function normalizeWindowId(v) {
  const s = String(v).trim()
  return /^\d+$/.test(s) ? 'w-' + s : s
}

const SNAPSHOT_FLAGS = {
  app: (v) => ['--app', String(v)],
  windowId: (v) => ['--window-id', normalizeWindowId(v)],
  maxDepth: (v) => ['--max-depth', String(v)],
  surface: (v) => ['--surface', String(v)],
  root: (v) => ['--root', String(v)],
  waitFor: (v) => ['--wait-for', String(v)],
  timeoutMs: (v) => ['--timeout-ms', String(v)],
  interactiveOnly: () => ['--interactive-only'],
  skeleton: () => ['--skeleton'],
  compact: () => ['--compact'],
  includeBounds: () => ['--include-bounds'],
}

/**
 * Read the accessibility tree and hand back @ref ids for actByRef/readElement.
 * @param {object} o - app, windowId, surface, root, maxDepth, waitFor,
 *                     interactiveOnly, skeleton, compact, includeBounds, timeoutMs.
 * @returns {Promise<object>} agent-desktop envelope: { ok, data: { app, tree, snapshot_id, ref_count } }.
 * @remarks Refs are snapshot-scoped: reusing one after the UI changed returns
 *          STALE_REF, so take a fresh snapshot instead of retrying blindly.
 *          windowId accepts a raw HWND from listWindows or the CLI form "w-<hwnd>".
 *          skeleton keeps a full Chromium window down to a couple of KB.
 */
export async function snapshot(o = {}) {
  const args = ['snapshot']
  for (const [key, fn] of Object.entries(SNAPSHOT_FLAGS)) {
    if (o[key] !== undefined && o[key] !== null && o[key] !== false) args.push(...fn(o[key]))
  }
  const res = await runAgent(args, { timeoutMs: Number(o.timeoutMs ?? 6000) + 15000 })
  log({ tool: 'pc_snapshot', ok: res?.ok === true, surface: o.surface ?? 'window', interactiveOnly: !!o.interactiveOnly })
  return res
}

const REF_VERBS = new Set(['click', 'double-click', 'right-click', 'type', 'set-value', 'clear', 'press', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll-to', 'hover'])

/**
 * Run an accessibility action on a ref without stealing focus.
 * @param {object} o - action, ref, text, keys, direction, amount, headed, timeoutMs.
 * @returns {Promise<object>} CLI envelope; ok:false with a code on failure.
 * @remarks Refused with PAUSED_BY_USER while paused, and with BLOCKED_KEYWORD when
 *          the target/foreground window title matches the payment blacklist.
 *          Cursor-moving verbs (hover, focus) also need headed:true - the CLI
 *          defaults to strict headless delivery and answers POLICY_DENIED.
 */
export async function actByRef(o = {}) {
  const action = String(o.action || '')
  if (!REF_VERBS.has(action)) return { ok: false, code: 'BAD_ACTION', message: 'unsupported ref action: ' + action }
  if (isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present: ' + PATHS.pauseFile, file: PATHS.pauseFile }
  const blocked = await guardTitles()
  if (blocked) return blocked
  markActive('act:ref')
  const args = [action]
  if (action === 'press') {
    args.push(String(o.keys || 'return'))
  } else if (action === 'scroll') {
    args.push(String(o.ref))
    args.push('--direction', String(o.direction || 'down'))
    args.push('--amount', String(o.amount ?? 3))
  } else if (action === 'scroll-to' || action === 'hover' || action === 'focus' || action === 'toggle' || action === 'check' || action === 'uncheck' || action === 'expand' || action === 'collapse' || action === 'click' || action === 'double-click' || action === 'right-click' || action === 'clear') {
    args.push(String(o.ref))
    if (o.headed) args.push('--headed')
  } else {
    args.push(String(o.ref))
    if (o.text !== undefined && o.text !== null) args.push(String(o.text))
  }
  if (o.timeoutMs) args.push('--timeout-ms', String(o.timeoutMs))
  const res = await runAgent(args, { timeoutMs: Number(o.timeoutMs ?? 8000) + 20000 })
  log({ tool: 'pc_act', mode: 'ref', action, ref: o.ref ?? null, ok: res?.ok === true })
  return res
}

async function cuaLib(name) {
  return import(pathToFileURL(join(PATHS.cuaDir, name + '.js')).href)
}

/**
 * Physical mouse/keyboard input through SendInput (no accessibility needed).
 * @param {object} o - action (click|double-click|right-click|move|drag|type),
 *                     x, y, button, from, to, durationMs, text.
 * @returns {Promise<object>} { ok, action, cursor } or a failure code.
 * @remarks Coordinates are physical screen pixels (see display()); the target window
 *          must already be in front. This is the only path that works on self-drawn
 *          UIs whose UIA tree is empty (games, mini programs).
 */
export async function actByPoint(o = {}) {
  if (isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present: ' + PATHS.pauseFile, file: PATHS.pauseFile }
  const blocked = await guardTitles(o.x, o.y)
  if (blocked) return blocked
  markActive('act:point')
  const input = await cuaLib('input')
  const action = String(o.action || 'click')
  if (action === 'click' || action === 'double-click' || action === 'right-click') {
    const button = action === 'right-click' ? 'right' : (o.button || 'left')
    const count = action === 'double-click' ? 2 : 1
    const res = input.click(Number(o.x), Number(o.y), button, count)
    log({ tool: 'pc_act', mode: 'point', action, x: o.x, y: o.y, ok: true })
    return { ok: true, action, cursor: res?.cursor ?? null }
  }
  if (action === 'move') {
    const res = input.move(Number(o.x), Number(o.y))
    return { ok: true, action, cursor: res }
  }
  if (action === 'drag') {
    const res = await input.drag(o.from, o.to, Number(o.durationMs ?? 300), o.button || 'left')
    return { ok: true, action, cursor: res?.cursor ?? null }
  }
  if (action === 'type') {
    const res = await input.typeText(String(o.text ?? ''))
    return { ok: true, action, typed: String(o.text ?? '').length, result: res ?? null }
  }
  return { ok: false, code: 'BAD_ACTION', message: 'unsupported point action: ' + action }
}

/**
 * Press a key combo through SendInput, independent of the active keyboard layout.
 * @param {object} o - keys (e.g. "ctrl+s", "win", "f24"-like names are limited),
 *                     times (1..20).
 * @returns {Promise<object>} { ok, keys, times, ... }
 * @remarks Refused while paused and when the foreground window is blacklisted.
 */
export async function keyCombo(o = {}) {
  if (isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present: ' + PATHS.pauseFile, file: PATHS.pauseFile }
  const blocked = await guardTitles()
  if (blocked) return blocked
  markActive('key')
  const input = await cuaLib('input')
  const res = await input.keyPress(String(o.keys || 'enter'), Number(o.times ?? 1))
  log({ tool: 'pc_key', keys: o.keys, ok: true })
  return { ok: true, ...res }
}

/**
 * Enumerate visible titled windows.
 * @param {string} [app] - case-insensitive process-name substring filter.
 * @returns {Promise<object>} { ok, count, windows: [{ id, cliId, title, className, process, pid, rect, isForeground }], foreground }
 * @remarks `id` is the raw HWND; `cliId` is the agent-desktop form. Both can be
 *          passed to snapshot/find, `id` also to focusWindow and pc_screen.
 *          rect is [x, y, w, h] in physical pixels and is null when unknown.
 */
export async function listWindows(app) {
  const native = await cuaLib('native')
  const all = native.listWindows().map((w) => ({
    id: Number(w.hwnd), cliId: 'w-' + Number(w.hwnd), title: w.title, className: w.className, process: w.process, pid: w.pid,
    rect: w.rect ? [w.rect.x, w.rect.y, w.rect.w, w.rect.h] : null, isForeground: w.isForeground,
  }))
  const filtered = app ? all.filter((w) => String(w.process || '').toLowerCase().includes(String(app).toLowerCase())) : all
  return { ok: true, count: filtered.length, windows: filtered, foreground: (await cuaLib('native')).foregroundInfo()?.title ?? null }
}

/**
 * Bring a window to the foreground, by decimal HWND or by title substring.
 * @param {string} target
 * @returns {Promise<object>} { ok, window: { id, title }, foreground }
 * @remarks Refused while paused; a plain substring match takes the first hit, so
 *          prefer the HWND when several windows share a title.
 */
export async function focusWindow(target) {
  if (isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present: ' + PATHS.pauseFile, file: PATHS.pauseFile }
  markActive('window:focus')
  const native = await cuaLib('native')
  const win = native.findWindow(String(target))
  if (!win) return { ok: false, code: 'WINDOW_NOT_FOUND', message: 'no window matches ' + JSON.stringify(target) }
  const res = native.setForeground(win.hwnd)
  log({ tool: 'pc_window', action: 'focus', window: win.title, ok: res?.ok === true })
  return { ok: true, window: { id: Number(win.hwnd), title: win.title }, foreground: res?.foreground ?? null }
}

/**
 * Capture pixels with GDI (DPI aware) and write a PNG.
 * @param {object} o - target (screen|window|rect), window (title/hwnd),
 *                     rect [x,y,w,h], scale (longest edge, default 1600), out (absolute path).
 * @returns {Promise<object>} { ok, path, screenshotId, width, height, sourceWidth, sourceHeight, scale, rect, foreground }
 * @remarks Default output lives in %DSH_HOME%/win-tools/shots; pass `out` to keep
 *          the file elsewhere. For boxes plus numbers use annotatedScreen().
 */
export async function screenshot(o = {}) {
  const screen = await cuaLib('screen')
  const shot = screen.capture({ target: o.target || 'screen', rect: o.rect, window: o.window, bringToFront: o.bringToFront })
  if (!shot?.ok) return shot ?? { ok: false, code: 'CAPTURE_FAILED' }
  const encoded = screen.pngForShot(shot.screenshotId, Number(o.scale ?? 1600))
  if (!encoded?.png) return { ok: false, code: 'SHOT_EXPIRED' }
  mkdirSync(PATHS.shotDir, { recursive: true })
  const out = o.out && String(o.out).trim() !== '' ? String(o.out) : join(PATHS.shotDir, 'win-' + Date.now() + '.png')
  screen.savePng(out, encoded.png)
  log({ tool: 'pc_screen', target: o.target || 'screen', path: out, width: encoded.width, height: encoded.height })
  return { ok: true, path: out, screenshotId: shot.screenshotId, width: encoded.width, height: encoded.height, sourceWidth: shot.width, sourceHeight: shot.height, scale: encoded.scale, rect: shot.rect, foreground: shot.foreground?.title ?? null }
}

/**
 * Drive the browser CLI for DOM work instead of pixels.
 * @param {object} o - op (title|text|table|links|click|type|shot), url, arg, text,
 *                     profile, cdp, headful, wait, timeoutMs.
 * @returns {Promise<object>} the CLI JSON payload, or raw output when it is not JSON.
 * @remarks Requires the optional peer dependency playwright-core plus a local
 *          Edge/Chrome; `--cdp` attaches to an already running browser so logins survive.
 */
export async function browser(o = {}) {
  const op = String(o.op || 'title')
  const url = String(o.url || '')
  if (!url) return { ok: false, code: 'BAD_ARGS', message: 'url is required' }
  const args = [PATHS.browserJs, op, url]
  if (o.arg !== undefined && o.arg !== null && String(o.arg) !== '') args.push(String(o.arg))
  if (o.profile) args.push('--profile', String(o.profile))
  if (o.cdp) args.push('--cdp', String(o.cdp))
  if (o.headful) args.push('--headful')
  if (o.wait != null) args.push('--wait', String(o.wait))
  const res = await run(PATHS.nodeBin, args, { timeoutMs: Number(o.timeoutMs ?? 60000) })
  const text = res.stdout.trim()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  log({ tool: 'pc_browser', op, ok: res.code === 0 })
  if (parsed) return parsed
  return { ok: res.code === 0, exitCode: res.code, stdout: text.slice(0, 3000), stderr: res.stderr.slice(0, 800) }
}


// ---------------------------------------------------------------- wait / app

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function parseColor(input) {
  const m = String(input || '').trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return null
  return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) }
}

function colorNear(rgba, offset, color, tol) {
  return Math.abs(rgba[offset] - color.r) <= tol && Math.abs(rgba[offset + 1] - color.g) <= tol && Math.abs(rgba[offset + 2] - color.b) <= tol
}

async function checkCondition(cond) {
  if (!cond || typeof cond !== 'object') return false
  const native = await cuaLib('native')
  if (cond.window_title_contains && cond.window_title_contains.pattern) {
    const pattern = String(cond.window_title_contains.pattern).toLowerCase()
    return native.listWindows().some((w) => String(w.title || '').toLowerCase().includes(pattern))
  }
  if (cond.pixel_matches) {
    const p = cond.pixel_matches
    const color = parseColor(p.color)
    if (!color || p.x === undefined || p.y === undefined) return false
    const frame = native.captureRegion(Number(p.x), Number(p.y), 1, 1)
    return colorNear(frame.rgba, 0, color, Number(p.tolerance ?? 16))
  }
  if (cond.region_ratio) {
    const r = cond.region_ratio
    const color = parseColor(r.color)
    if (!color || !Array.isArray(r.rect) || r.rect.length !== 4) return false
    const [x, y, w, h] = r.rect.map(Number)
    const frame = native.captureRegion(x, y, w, h)
    let hits = 0
    for (let i = 0; i < frame.width * frame.height; i += 1) if (colorNear(frame.rgba, i * 4, color, Number(r.tolerance ?? 16))) hits += 1
    return hits / (frame.width * frame.height) >= Number(r.minRatio ?? 0.5)
  }
  return false
}

/**
 * Poll a screen condition inside this process - no model round-trips between tries.
 * @param {object} o - condition { window_title_contains | pixel_matches | region_ratio | image_changed },
 *                     action (one point action run on match), timeoutMs (<=600000), pollMs.
 * @returns {Promise<object>} { ok:true, matched:true, elapsedMs, ... } or { ok:false, code:'TIMEOUT' }.
 * @remarks One condition and one action per call by design (no multi-step macros).
 *          image_changed needs an explicit rect; whole-screen polling is expensive.
 *          The pause file is re-checked every poll, so the hotkey stops a live wait.
 */
export async function waitFor(o = {}) {
  if (isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present', file: PATHS.pauseFile }
  if (o.action) markActive('wait:armed')
  const timeoutMs = Math.max(1, Math.min(Number(o.timeoutMs ?? 30000), 600000))
  const pollMs = Math.max(30, Math.min(Number(o.pollMs ?? 120), 5000))
  const started = Date.now()
  let baseline = null
  try {
    while (Date.now() - started < timeoutMs) {
      if (isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present', file: PATHS.pauseFile }
      const ic = o.condition && o.condition.image_changed
      if (ic) {
        const rect = Array.isArray(ic.rect) && ic.rect.length === 4 ? ic.rect.map(Number) : null
        if (!rect) return { ok: false, code: 'BAD_ARGS', message: 'image_changed requires rect [x,y,w,h]' }
        const nativeMod = await cuaLib('native')
        const frame = nativeMod.captureRegion(rect[0], rect[1], rect[2], rect[3])
        if (!baseline) { baseline = frame; await sleep(pollMs); continue }
        const ratio = frameDiff(baseline, frame, Number(ic.tolerance ?? 24))
        if (ratio >= Number(ic.minChangeRatio ?? 0.02)) {
          const acted = o.action ? await actByPoint(o.action) : null
          log({ tool: 'pc_wait', matched: true, changeRatio: ratio })
          return { ok: true, matched: true, changeRatio: ratio, elapsedMs: Date.now() - started, ...(acted ? { action: acted } : {}) }
        }
        await sleep(pollMs)
        continue
      }
      if (await checkCondition(o.condition)) {
        if (!o.action) return { ok: true, matched: true, elapsedMs: Date.now() - started }
        const acted = await actByPoint(o.action)
        log({ tool: 'pc_wait', matched: true, action: o.action?.action ?? null, elapsedMs: Date.now() - started })
        return { ok: true, matched: true, elapsedMs: Date.now() - started, action: acted }
      }
      await sleep(pollMs)
    }
  } catch (error) {
    return { ok: false, code: 'WAIT_ERROR', message: String(error?.message ?? error) }
  }
  log({ tool: 'pc_wait', matched: false, timeoutMs })
  return { ok: false, code: 'TIMEOUT', elapsedMs: Date.now() - started, condition: o.condition ?? null }
}

// Force the child's stdout to UTF-8; otherwise Windows PowerShell writes the
// OEM/ANSI code page into the pipe and any non-ASCII text comes back mangled.
const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'

async function runPowerShell(script, timeoutMs = 20000) {
  const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8 + script], { timeoutMs })
  return { code: res.code, out: String(res.stdout || '').trim(), err: String(res.stderr || '').trim() }
}

const PS_MOVE = "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);'; [W.U]::MoveWindow([IntPtr]{HWND}, {X}, {Y}, {W}, {H}, \$true)"
const PS_SHOW = "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'; [W.U]::ShowWindow([IntPtr]{HWND}, {CMD})"
const PS_CLOSE = "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'; [W.U]::PostMessage([IntPtr]{HWND}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)"

/**
 * Enumerate, launch, close, resize, minimize, maximize or restore applications.
 * @param {object} o - action, app, args, target (title/hwnd), width, height, activate.
 * @returns {Promise<object>} action-specific result, or ok:false with a code.
 * @remarks launch waits up to ~10 s for the window unless activate:false.
 *          Window verbs go through ShowWindow/MoveWindow; close posts WM_CLOSE
 *          when a window matches, otherwise it force-stops the process by name.
 */
export async function appControl(o = {}) {
  const action = String(o.action || 'list')
  if (action !== 'list' && isPaused()) return { ok: false, code: 'PAUSED_BY_USER', message: 'operator pause file present', file: PATHS.pauseFile }
  if (action !== 'list') markActive('app:' + action)
  const app = o.app ? String(o.app) : ''
  try {
    if (action === 'list') {
      const ps = "Get-Process | Where-Object { \$_.MainWindowTitle -ne '' } | Select-Object ProcessName,Id,MainWindowTitle | ConvertTo-Json -Compress"
      const r = await runPowerShell(ps)
      let list = []
      try { list = JSON.parse(r.out || '[]') } catch {}
      if (!Array.isArray(list)) list = [list]
      return { ok: true, count: list.length, apps: list.map((x) => ({ process: x.ProcessName, pid: x.Id, title: x.MainWindowTitle })) }
    }
    if (action === 'launch') {
      if (!app) return { ok: false, code: 'BAD_ARGS', message: 'app is required' }
      const args = Array.isArray(o.args) ? o.args : []
      const argLine = args.map((a) => '"' + String(a).replace(/"/g, '') + '"').join(' ')
      const ps = '$p = Start-Process -FilePath ' + JSON.stringify(app) + (argLine ? ' -ArgumentList ' + argLine : '') + ' -PassThru; $p.Id'
      const r = await runPowerShell(ps, 30000)
      const pid = Number(String(r.out || '').trim().split(/\s+/).pop())
      let window = null
      for (let i = 0; i < 40 && o.activate !== false; i += 1) {
        await sleep(250)
        const native = await cuaLib('native')
        const base = app.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
        const wins = native.listWindows().filter((w) => w.pid === pid || (base !== '' && (String(w.process || '').toLowerCase().includes(base) || String(w.title || '').toLowerCase().includes(base))))
        if (wins.length > 0) { window = wins[0]; break }
      }
      log({ tool: 'pc_app', action: 'launch', app, pid })
      return { ok: true, action: 'launch', pid: Number.isFinite(pid) ? pid : null, window: window ? { id: Number(window.hwnd), title: window.title } : null }
    }
    const native = await cuaLib('native')
    const win = o.target ? native.findWindow(String(o.target)) : null
    if (action === 'close') {
      if (win) {
        const ps = PS_CLOSE.replace('{HWND}', String(win.hwnd))
        const r = await runPowerShell(ps)
        return { ok: r.code === 0, action: 'close', window: { id: Number(win.hwnd), title: win.title }, detail: r.out || r.err }
      }
      if (!app) return { ok: false, code: 'BAD_ARGS', message: 'target or app is required' }
      const r = await runPowerShell('Stop-Process -Name ' + JSON.stringify(app.replace(/\.exe$/i, '')) + ' -Force -ErrorAction SilentlyContinue; "done"')
      return { ok: r.code === 0, action: 'close', app, detail: r.out }
    }
    if (action === 'minimize' || action === 'maximize' || action === 'restore' || action === 'resize') {
      if (!win) return { ok: false, code: 'WINDOW_NOT_FOUND', message: 'no window matches ' + JSON.stringify(o.target) }
      if (action === 'resize') {
        const w = Math.max(100, Number(o.width ?? 800))
        const h = Math.max(100, Number(o.height ?? 600))
        // Optional x/y let a caller tile windows side by side (agent + target app).
        const x = o.x !== undefined && o.x !== null ? Number(o.x) : Number(win.rect?.x ?? 100)
        const y = o.y !== undefined && o.y !== null ? Number(o.y) : Number(win.rect?.y ?? 100)
        const ps = PS_MOVE.replace('{HWND}', String(win.hwnd)).replace('{X}', String(x)).replace('{Y}', String(y)).replace('{W}', String(w)).replace('{H}', String(h))
        const r = await runPowerShell(ps)
        return { ok: r.code === 0, action: 'resize', window: { id: Number(win.hwnd), title: win.title }, size: [w, h], detail: r.out || r.err }
      }
      const cmd = action === 'minimize' ? 6 : action === 'maximize' ? 3 : 9
      const ps = PS_SHOW.replace('{HWND}', String(win.hwnd)).replace('{CMD}', String(cmd))
      const r = await runPowerShell(ps)
      log({ tool: 'pc_app', action, window: win.title })
      return { ok: r.code === 0, action, window: { id: Number(win.hwnd), title: win.title }, detail: r.out || r.err }
    }
    return { ok: false, code: 'BAD_ACTION', message: 'unsupported action: ' + action }
  } catch (error) {
    return { ok: false, code: 'APP_ERROR', message: String(error?.message ?? error) }
  }
}

// ---------------------------------------------------------------- safety / parity

export const DEFAULT_BLACKLIST = ['支付', '充值', '购买', '授权', '扫码', '付款', '收银', '转账', '下单', '结算', '微信支付', '支付宝']

/**
 * Return the first blacklisted payment/authorization keyword found in the titles.
 * @param {Array<string|null>} titles
 * @returns {{keyword: string, title: string}|null}
 * @remarks Pure function so the guard can be reasoned about (and tested) without a UI.
 */
export function blacklistHit(titles) {
  for (const t of titles) {
    if (!t) continue
    const s = String(t)
    for (const k of DEFAULT_BLACKLIST) if (s.includes(k)) return { keyword: k, title: s }
  }
  return null
}

async function guardTitles(x, y) {
  const native = await cuaLib('native')
  const fg = native.foregroundInfo()
  let at = null
  try { if (x !== undefined && y !== undefined) at = native.windowAtPoint(Number(x), Number(y)) } catch {}
  const hit = blacklistHit([at && at.title, fg && fg.title])
  if (!hit) return null
  log({ tool: 'blacklist', keyword: hit.keyword, window: hit.title })
  return { ok: false, code: 'BLOCKED_KEYWORD', keyword: hit.keyword, window: hit.title, message: 'refused: window title contains blacklisted keyword' }
}

/**
 * Bridge health from the agent-desktop CLI.
 * @returns {Promise<object>} { ok, version, data: { platform, permissions, version, ref_count, ... } }
 * @remarks Start here when tools fail: a revoked accessibility permission shows up
 *          as a failing snapshot rather than as an error from this call.
 */
export async function status() {
  return runAgent(['status'], { timeoutMs: 15000 })
}

function frameDiff(a, b, tol) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 1
  const n = a.width * a.height
  let diff = 0
  for (let i = 0; i < n; i += 1) {
    const o = i * 4
    if (Math.abs(a.rgba[o] - b.rgba[o]) > tol || Math.abs(a.rgba[o + 1] - b.rgba[o + 1]) > tol || Math.abs(a.rgba[o + 2] - b.rgba[o + 2]) > tol) diff += 1
  }
  return diff / n
}

// ---------------------------------------------------------------- clipboard / notify

/**
 * Read or write the Windows text clipboard.
 * @param {object} o - mode ("get" | "set"), text (for set).
 * @returns {Promise<object>} { ok, mode, text } for get, { ok, mode, length } for set.
 * @remarks Both directions carry the text as base64 and force the child's stdout to
 *          UTF-8, otherwise CJK/emoji come back mangled through the OEM code page.
 *          Ctrl+V to restore a previous value after a probe.
 */
export async function clipboard(o = {}) {
  const mode = String(o.mode || 'get')
  if (mode === 'get') {
    // Base64 through PowerShell so the text never crosses the console encoding.
    const r = await runPowerShell("$t = Get-Clipboard -Raw; if ($null -eq $t) { '' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }")
    let text = ''
    try { text = Buffer.from(String(r.out || '').trim(), 'base64').toString('utf8') } catch {}
    const out = { ok: r.code === 0, mode: 'get', text }
    if (r.err) out.detail = r.err
    return out
  }
  const text = String(o.text ?? '')
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const ps = "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))); 'ok'"
  const r = await runPowerShell(ps)
  log({ tool: 'pc_clipboard', mode: 'set', length: text.length })
  return { ok: r.code === 0, mode: 'set', length: text.length, detail: r.out || r.err }
}

/**
 * Show a tray balloon for ~3 s so a long task can signal completion.
 * @param {object} o - title, message.
 * @returns {Promise<object>} { ok, title, detail }
 * @remarks Title and message are base64 encoded for the same encoding reason as the
 *          clipboard. The process sleeps 4 s inside the call, so do not await it in a loop.
 */
export async function notify(o = {}) {
  const title = String(o.title || 'DSH')
  const message = String(o.message || '')
  const b64t = Buffer.from(title, 'utf8').toString('base64')
  const b64m = Buffer.from(message, 'utf8').toString('base64')
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64t + "'))",
    "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64m + "'))",
    '$n=New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon=[System.Drawing.SystemIcons]::Information',
    '$n.Visible=$true',
    '$n.BalloonTipTitle=$t',
    '$n.BalloonTipText=$m',
    '$n.ShowBalloonTip(3000)',
    'Start-Sleep -Seconds 4',
    '$n.Visible=$false',
    '$n.Dispose()',
    "'ok'",
  ].join('; ')
  const r = await runPowerShell(ps, 15000)
  log({ tool: 'pc_notify', ok: r.code === 0 })
  return { ok: r.code === 0, title, detail: r.out || r.err }
}

// ---------------------------------------------------------------- display / annotated shot

/**
 * Report the monitor layout in physical pixels plus the DPI scale.
 * @returns {Promise<object>} { ok, dpi, monitors: [{ device, primary, x, y, width, height }] }
 * @remarks The child calls SetProcessDPIAware first, so these numbers line up with
 *          actByPoint/SendInput coordinates rather than with logical (CSS) pixels.
 *          On a 200% display dpi is 192 / 96 = 2 and a 2880x1800 panel reports 2880x1800.
 */
export async function display() {
  const ps = [
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WIN_TOOLS_DPI { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
    '[WIN_TOOLS_DPI]::SetProcessDPIAware() | Out-Null',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$g=[System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)',
    '$dpi=[double]$g.DpiX',
    '$screens=[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ device=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } }',
    '[pscustomobject]@{ dpi=$dpi; monitors=@($screens) } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ')
  const r = await runPowerShell(ps)
  try {
    const data = JSON.parse(r.out)
    return { ok: true, dpi: data.dpi, monitors: Array.isArray(data.monitors) ? data.monitors : [data.monitors] }
  } catch {
    return { ok: false, code: 'DISPLAY_ERROR', detail: r.err || r.out }
  }
}

function collectBoxes(node, out) {
  if (!node) return
  const b = node.bounds
  if (node.ref_id && b && Number(b.width) > 1 && Number(b.height) > 1) {
    out.push({ ref: node.ref_id, role: node.role, name: node.name, x: Number(b.x), y: Number(b.y), w: Number(b.width), h: Number(b.height) })
  }
  for (const child of node.children || []) collectBoxes(child, out)
}

/**
 * Screenshot with accessibility boxes and numbers drawn on top.
 * @param {object} o - same options as screenshot().
 * @returns {Promise<object>} screenshot result plus { annotatedPath, boxes }
 * @remarks Only interactive elements are boxed, capped at 80, and the UI is snapshotted
 *          right after the capture (so a moving UI can drift). Costs ~3 s extra for
 *          the UIA pass plus a GDI draw; the plain PNG stays available at `path`.
 */
export async function annotatedScreen(o = {}) {
  const shot = await screenshot(o)
  if (!shot || !shot.ok) return shot
  const snap = await runAgent(['snapshot', '--interactive-only', '--include-bounds', '--timeout-ms', String(o.timeoutMs ?? 6000)], { timeoutMs: Number(o.timeoutMs ?? 6000) + 15000 })
  const boxes = []
  collectBoxes(snap && snap.data && snap.data.tree, boxes)
  const scale = shot.sourceWidth ? shot.width / shot.sourceWidth : 1
  const scaled = boxes.slice(0, 80).map((b, i) => ({
    i: i + 1,
    x: Math.round(b.x * scale),
    y: Math.round(b.y * scale),
    w: Math.max(2, Math.round(b.w * scale)),
    h: Math.max(2, Math.round(b.h * scale)),
  }))
  const out = shot.path.replace(/\.png$/i, '') + '-annotated.png'
  const b64 = Buffer.from(JSON.stringify(scaled), 'utf8').toString('base64')
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    '$boxes=$json | ConvertFrom-Json',
    "$img=[System.Drawing.Image]::FromFile('" + shot.path.replace(/'/g, "''") + "')",
    '$bmp=New-Object System.Drawing.Bitmap $img',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$pen=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255,220,40)),2',
    "$font=New-Object System.Drawing.Font('Consolas',11)",
    '$br=[System.Drawing.Brushes]::Yellow',
    'foreach($b in $boxes){ $g.DrawRectangle($pen,[int]$b.x,[int]$b.y,[int]$b.w,[int]$b.h); $g.DrawString([string]$b.i,$font,$br,[single]$b.x,[single]$b.y) }',
    "$bmp.Save('" + out.replace(/'/g, "''") + "',[System.Drawing.Imaging.ImageFormat]::Png)",
    '$g.Dispose(); $bmp.Dispose(); $img.Dispose()',
    "'ok'",
  ].join('; ')
  const r = await runPowerShell(ps, 30000)
  log({ tool: 'pc_screen', annotate: true, boxes: scaled.length, ok: r.code === 0 })
  const result = { ...shot, annotatedPath: out, boxes: scaled.length }
  if (r.code !== 0) result.annotateError = r.err || r.out
  return result
}

// ---------------------------------------------------------------- find / read

/**
 * Search the accessibility tree without taking a full snapshot.
 * @param {object} o - role, name, value, text, app, windowId, timeoutMs.
 * @returns {Promise<object>} CLI envelope with data.matches[] and data.total_matches.
 * @remarks Much cheaper than a full snapshot when the target is known. A miss is
 *          ok:true with total_matches 0 - distinguish "not there" from "call failed".
 *          windowId accepts a raw HWND or the CLI form "w-<hwnd>".
 */
export async function findElements(o = {}) {
  const a = ['find']
  if (o.app) a.push('--app', String(o.app))
  if (o.windowId) a.push('--window-id', normalizeWindowId(o.windowId))
  if (o.role) a.push('--role', String(o.role))
  if (o.name) a.push('--name', String(o.name))
  if (o.value) a.push('--value', String(o.value))
  if (o.text) a.push('--text', String(o.text))
  if (o.timeoutMs) a.push('--timeout-ms', String(o.timeoutMs))
  const res = await runAgent(a, { timeoutMs: Number(o.timeoutMs ?? 15000) + 15000 })
  log({ tool: 'pc_find', role: o.role ?? null, name: o.name ?? null, ok: res?.ok === true })
  return res
}

/**
 * Read one property or state of an element by ref.
 * @param {object} o - ref plus what: text|value|title|bounds|role|states as properties,
 *                     visible|enabled|checked|focused|expanded|selected as states.
 * @returns {Promise<object>} { ok, data: { property, ref, value|result } }
 * @remarks Cheaper than re-snapshotting; bounds returns { x, y, width, height } in
 *          physical pixels. The ref must come from a live snapshot (STALE_REF otherwise).
 */
export async function readElement(o = {}) {
  const ref = String(o.ref || '')
  if (!ref) return { ok: false, code: 'BAD_ARGS', message: 'ref is required' }
  const what = String(o.what || 'text')
  const states = ['visible', 'enabled', 'checked', 'focused', 'expanded', 'selected']
  const a = states.includes(what) ? ['is', ref, '--property', what] : ['get', ref, '--property', what]
  const res = await runAgent(a, { timeoutMs: Number(o.timeoutMs ?? 8000) + 12000 })
  log({ tool: 'pc_read', ref, what, ok: res?.ok === true })
  return res
}
