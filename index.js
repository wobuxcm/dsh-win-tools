/**
 * dsh-win-tools — one tool surface for Windows desktop control.
 *
 * pc_snapshot / pc_act   -> agent-desktop native CLI (accessibility refs)
 * pc_act(point) / pc_key -> dsh-cua-win lib (SendInput, absolute coordinates)
 * pc_screen / pc_window  -> dsh-cua-win lib (GDI capture, user32 window calls)
 * pc_browser             -> dsh-browser web.js CLI (DOM, no pixels)
 * pc_pause               -> operator switch, toggles %DSH_HOME%/cua.stop
 *
 * apply() never throws: a broken backend degrades to fewer tools.
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { dirname, join } from 'node:path'

import * as core from './lib/core.js'

async function loadDefineTool() {
  const errors = []
  const candidates = ['@deepseek-ai/dsh-tools']
  const asarParts = ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js']
  try {
    const resources = process.resourcesPath
    if (typeof resources === 'string' && resources !== '') candidates.push(pathToFileURL(join(resources, ...asarParts)).href)
  } catch {}
  try {
    const exe = process.execPath
    if (typeof exe === 'string' && exe !== '') {
      let dir = dirname(exe)
      for (let depth = 0; depth < 7; depth += 1) {
        candidates.push(pathToFileURL(join(dir, 'resources', ...asarParts)).href)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {}
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate)
      if (typeof mod.defineTool === 'function') return mod.defineTool
      errors.push(candidate + ': no defineTool export')
    } catch (error) {
      errors.push(candidate + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  throw new Error(errors.join(' | '))
}

export const name = 'win-tools'
export const inject = ['tools']

let defineTool = null
let defineToolError = null
try { defineTool = await loadDefineTool() } catch (error) { defineToolError = error instanceof Error ? error.message : String(error) }

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
const render = (_a, value) => [{ type: 'text', text: JSON.stringify(value) }]

/**
 * Spawn the on-screen activity indicator once (top of screen, click-through).
 * @returns {() => void} disposer that stops the helper process.
 * @remarks Set PC_INDICATOR=0 to keep the desktop clean. Failures are logged and
 *          ignored: the indicator is a hint, never a dependency.
 */
function startIndicator() {
  if (String(process.env.PC_INDICATOR ?? '') === '0') return () => {}
  let child = null
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const script = join(here, 'bin', 'indicator.ps1')
    // detached:true makes powershell exit immediately under some hosts; the
    // Windows start trampoline detaches reliably and survives our own exit.
    child = spawn('cmd.exe', ['/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (e) => core.log({ tool: 'indicator', error: String(e && e.message ? e.message : e) }))
    child.unref()
  } catch (error) {
    core.log({ tool: 'indicator', error: String(error && error.message ? error.message : error) })
  }
  return () => {
    try { if (child && child.pid) process.kill(child.pid) } catch {}
    try {
      const pidFile = join(core.PATHS.home, 'indicator.pid')
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 0) process.kill(pid)
    } catch {}
  }
}

export function apply(ctx) {
  if (!defineTool) {
    try { ctx?.logger?.warn?.('win-tools unavailable: ' + defineToolError) } catch {}
    return
  }
  try {
    const state = { saveImage: null }
    const refStore = new Map()
    const stopIndicator = startIndicator()
    ctx.inject(['attachments'], (actx) => {
      actx.effect(() => {
        const attachments = actx.get('attachments')
        state.saveImage = attachments && typeof attachments.saveImages === 'function'
          ? (images) => attachments.saveImages(images).catch(() => null)
          : null
        return () => { state.saveImage = null }
      }, 'win-tools: attachments')
    })
    ctx.effect(() => {
      const disposers = []
      const tools = [
        defineTool({
          name: 'pc_display',
          description: 'Report the display layout: per-monitor bounds in physical pixels, primary flag, and system DPI scale.',
          parameters: {},
          output: { schema: OUTPUT_SCHEMA, render },
          async execute() { return core.display() },
        }),

        defineTool({
          name: 'pc_status',
          description: 'Show the agent-desktop adapter health, platform info, permission state and CLI version (same payload as the old desktop_status).',
          parameters: {},
          output: { schema: OUTPUT_SCHEMA, render },
          async execute() { return core.status() },
        }),

        defineTool({
          name: 'pc_clipboard',
          description: 'Read or write the Windows text clipboard (PowerShell Get-Clipboard/Set-Clipboard).',
          parameters: {
            mode: { type: 'string', required: true, enum: ['get', 'set'] },
            text: { type: 'string', description: 'Text to write when mode=set.' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.clipboard(args) },
        }),

        defineTool({
          name: 'pc_notify',
          description: 'Show a Windows tray balloon notification with a title and message.',
          parameters: {
            title: { type: 'string', description: 'Balloon title (default DSH).' },
            message: { type: 'string', description: 'Balloon body.' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.notify(args) },
        }),

        defineTool({
          name: 'pc_pause',
          description: 'Operator switch for desktop control. pause creates %DSH_HOME%/cua.stop and every write action (pc_act, pc_key, pc_window focus) is refused until resume. status reports the current state. The global hotkey Ctrl+Alt+Shift+F12 toggles the same file.',
          parameters: {
            action: { type: 'string', required: true, enum: ['pause', 'resume', 'status'], description: 'pause | resume | status' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) {
            if (args.action === 'status') return { ok: true, paused: core.isPaused(), file: core.PATHS.pauseFile }
            return core.setPaused(args.action === 'pause')
          },
        }),

        defineTool({
          name: 'pc_snapshot',
          description: 'Read the Windows accessibility tree and return @ref ids for pc_act. Prefer this over screenshots for standard apps: no pixels, no OCR, stable refs. Use --surface for menus/taskbar/start-menu when the window tree is empty.',
          parameters: {
            app: { type: 'string', description: 'Filter to an application by name.' },
            windowId: { type: 'string', description: 'Scope to one window: pass the hwnd from pc_window (e.g. "1575036") or the CLI form ("w-1575036").' },
            surface: { type: 'string', description: 'window | focused | menu | taskbar | start-menu | system-tray | action-center ...' },
            root: { type: 'string', description: 'Start traversal from this @ref.' },
            maxDepth: { type: 'integer', description: 'Tree depth ceiling (default 10).' },
            interactiveOnly: { type: 'boolean', description: 'Only interactive elements.' },
            skeleton: { type: 'boolean', description: 'Shallow overview with children_count.' },
            compact: { type: 'boolean', description: 'Collapse single-child unnamed nodes.' },
            includeBounds: { type: 'boolean', description: 'Include x/y/width/height for every element.' },
            waitFor: { type: 'string', description: 'Poll until a "role:text" element appears.' },
            timeoutMs: { type: 'integer', description: 'Observation deadline (default 6000).' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.snapshot(args) },
        }),

        defineTool({
          name: 'pc_act',
          description: 'Act on a snapshot @ref (accessibility action: click, double-click, right-click, type, set-value, clear, press, focus, select, toggle, check, uncheck, expand, collapse, scroll, scroll-to, hover) or on physical coordinates when only x/y are given (SendInput, works on self-drawn windows). Ref actions need no focus; point actions need the target window in front (pc_window focus).',
          parameters: {
            action: { type: 'string', required: true, description: 'Ref action verb, or click/double-click/right-click/move/drag/type for coordinates.' },
            ref: { type: 'string', description: 'Qualified @ref from pc_snapshot.' },
            x: { type: 'number', description: 'Physical screen x (point mode).' },
            y: { type: 'number', description: 'Physical screen y (point mode).' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Point-mode mouse button.' },
            text: { type: 'string', description: 'Text for type / set-value.' },
            keys: { type: 'string', description: 'Key combo for press, e.g. "ctrl+s".' },
            direction: { type: 'string', description: 'scroll direction: up|down|left|right.' },
            amount: { type: 'integer', description: 'scroll units (default 3).' },
            from: { type: 'array', items: { type: 'number' }, description: 'Drag start [x,y].' },
            to: { type: 'array', items: { type: 'number' }, description: 'Drag end [x,y].' },
            durationMs: { type: 'integer', description: 'Drag duration (default 300).' },
            headed: { type: 'boolean', description: 'Prefer physical delivery for a ref action. Required for cursor-moving verbs such as hover/focus — the default headless policy rejects them with POLICY_DENIED.' },
            timeoutMs: { type: 'integer', description: 'Action deadline.' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) {
            if (args.ref || args.action === 'press') return core.actByRef(args)
            if (args.x === undefined || args.y === undefined) return { ok: false, code: 'BAD_ARGS', message: 'provide ref, or x/y for point mode' }
            return core.actByPoint(args)
          },
        }),

        defineTool({
          name: 'pc_key',
          description: 'Press a key combo through SendInput (layout-independent), e.g. "enter", "ctrl+shift+tab", "win". Refused while paused.',
          parameters: {
            keys: { type: 'string', required: true, description: 'Combo like "ctrl+s".' },
            times: { type: 'integer', description: 'Repeat count (1..20).' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.keyCombo(args) },
        }),

        defineTool({
          name: 'pc_screen',
          description: 'Capture a pixel screenshot (GDI, DPI-aware) and save it to a PNG path. Returns the path so the caller can read the image when vision is needed. No annotation is drawn.',
          parameters: {
            target: { type: 'string', enum: ['screen', 'window', 'rect'], description: 'Capture target (default screen).' },
            window: { type: 'string', description: 'Window title substring or hwnd (target=window).' },
            rect: { type: 'array', items: { type: 'integer' }, description: '[x,y,w,h] physical pixels (target=rect).' },
            scale: { type: 'integer', description: 'Longest edge of the saved PNG (default 1600).' },
            out: { type: 'string', description: 'Absolute output path.' },
            annotate: { type: 'boolean', description: 'Draw accessibility bounding boxes and index labels onto the image (adds one UIA snapshot, ~3 s).' },
          },
          output: {
            schema: OUTPUT_SCHEMA,
            render: (_a, value) => {
              const blocks = [{ type: 'text', text: JSON.stringify(value) }]
              const img = value && value.image
              if (img) {
                const ref = refStore.get(img.attachment_id)
                if (ref) blocks.push({ type: 'image', attachment: ref })
              }
              return blocks
            },
          },
          async execute(args) {
            const shot = args.annotate ? await core.annotatedScreen(args) : await core.screenshot(args)
            if (!shot || !shot.ok || !state.saveImage) return shot
            try {
              const imgPath = shot.annotatedPath || shot.path
              const png = readFileSync(imgPath)
              const refs = await state.saveImage([{ data: new Uint8Array(png), mediaType: 'image/png', name: basename(imgPath) }])
              const ref = refs && refs[0]
              if (!ref) return shot
              refStore.set(String(ref.attachmentId), ref)
              return {
                ...shot,
                image: {
                  attachment_id: String(ref.attachmentId),
                  media_type: ref.mediaType,
                  bytes: ref.bytes,
                  width: ref.width,
                  height: ref.height,
                  ...(ref.name !== undefined ? { name: ref.name } : {}),
                },
              }
            } catch (error) {
              return { ...shot, imageError: String(error && error.message ? error.message : error) }
            }
          },
        }),

        defineTool({
          name: 'pc_find',
          description: 'Search the accessibility tree by role/name/value/text without a full snapshot. Cheaper than pc_snapshot when you already know what you are looking for; returns candidate elements with @ref ids.',
          parameters: {
            app: { type: 'string', description: 'Filter to an application by name.' },
            windowId: { type: 'string', description: 'Scope to one window: hwnd from pc_window ("1575036") or CLI form ("w-1575036").' },
            role: { type: 'string', description: 'Accessibility role: button, textfield, checkbox, listitem, menuitem ...' },
            name: { type: 'string', description: 'Accessible name or label.' },
            value: { type: 'string', description: 'Current value.' },
            text: { type: 'string', description: 'Text in name, value, title or description.' },
            timeoutMs: { type: 'integer', description: 'Search deadline (default 15000).' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.findElements(args) },
        }),

        defineTool({
          name: 'pc_read',
          description: 'Read one property (text, value, title, bounds, role, states) or one state (visible, enabled, checked, focused, expanded, selected) of an element by @ref. Read-only and much cheaper than re-snapshotting.',
          parameters: {
            what: { type: 'string', required: true, description: 'Property or state name.' },
            ref: { type: 'string', required: true, description: 'Qualified @ref from pc_snapshot or pc_find.' },
            timeoutMs: { type: 'integer', description: 'Deadline (default 8000).' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.readElement(args) },
        }),

        defineTool({
          name: 'pc_window',
          description: 'List visible titled windows or bring one to the foreground. Window ids come from this list.',
          parameters: {
            action: { type: 'string', required: true, enum: ['list', 'focus'], description: 'list | focus' },
            app: { type: 'string', description: 'list: filter by process/app name substring.' },
            target: { type: 'string', description: 'focus: decimal hwnd or title substring.' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) {
            if (args.action === 'list') return core.listWindows(args.app)
            return core.focusWindow(args.target)
          },
        }),

        defineTool({
          name: 'pc_browser',
          description: 'Browser DOM operations through dsh-browser (no screenshots): title, text, table (rows of a CSS selector pointing at <tr>), links, click, type, shot. Use --profile for persistent logins, --cdp to attach to a running browser.',
          parameters: {
            op: { type: 'string', required: true, enum: ['title', 'text', 'table', 'links', 'click', 'type', 'shot'], description: 'Operation.' },
            url: { type: 'string', required: true, description: 'Target URL.' },
            arg: { type: 'string', description: 'Selector (table/click/type), max chars (text), max links (links), or output png (shot).' },
            text: { type: 'string', description: 'Text for op=type (appended after the selector).' },
            profile: { type: 'string', description: 'Persistent profile directory.' },
            cdp: { type: 'string', description: 'CDP endpoint of a running browser.' },
            headful: { type: 'boolean', description: 'Show the browser window.' },
            wait: { type: 'integer', description: 'Extra settle time in ms.' },
            timeoutMs: { type: 'integer', description: 'Overall deadline.' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.browser(args) },
        }),
        defineTool({
          name: 'pc_wait',
          description: 'Poll a screen condition in-process (no model round-trips) and optionally act once it matches: window_title_contains {pattern}, pixel_matches {x,y,color,tolerance}, region_ratio {rect,color,tolerance,minRatio}. Refused while paused.',
          parameters: {
            condition: { type: 'object', additionalProperties: false, required: true, description: 'One condition object.', properties: {
              window_title_contains: { type: 'object', additionalProperties: false, properties: { pattern: { type: 'string', required: true } } },
              pixel_matches: { type: 'object', additionalProperties: false, properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true }, color: { type: 'string', required: true, description: "#rrggbb" }, tolerance: { type: 'integer' } } },
              region_ratio: { type: 'object', additionalProperties: false, properties: { rect: { type: 'array', items: { type: 'integer' }, required: true }, color: { type: 'string', required: true }, tolerance: { type: 'integer' }, minRatio: { type: 'number' } } },
              image_changed: { type: 'object', additionalProperties: false, properties: { rect: { type: 'array', items: { type: 'integer' }, required: true }, tolerance: { type: 'integer' }, minChangeRatio: { type: 'number' } } },
            } },
            action: { type: 'object', additionalProperties: false, description: 'Optional action executed on match.', properties: { type: { type: 'string', enum: ['click', 'double_click', 'move', 'type_text', 'key_press'] }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, text: { type: 'string' }, keys: { type: 'string' }, times: { type: 'integer' } } },
            timeoutMs: { type: 'integer', description: 'Wait ceiling (default 30000, max 600000).' },
            pollMs: { type: 'integer', description: 'Poll interval (default 120).' },
          },
          timeoutMs: 600000,
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.waitFor(args) },
        }),

        defineTool({
          name: 'pc_app',
          description: 'List, launch, close, resize, minimize, maximize or restore applications. Launch/close use PowerShell Start-Process/Stop-Process; window verbs use ShowWindow/MoveWindow on a target window title or hwnd.',
          parameters: {
            action: { type: 'string', required: true, enum: ['list', 'launch', 'close', 'resize', 'minimize', 'maximize', 'restore'] },
            app: { type: 'string', description: 'Executable path/name for launch or close.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Launch arguments.' },
            target: { type: 'string', description: 'Window title substring or hwnd for close/resize/minimize/maximize/restore.' },
            width: { type: 'integer', description: 'Resize width.' },
            height: { type: 'integer', description: 'Resize height.' },
            x: { type: 'integer', description: 'Optional target left edge for resize (tile two windows side by side).' },
            y: { type: 'integer', description: 'Optional target top edge for resize.' },
            activate: { type: 'boolean', description: 'Wait for the launched window (default true).' },
          },
          output: { schema: OUTPUT_SCHEMA, render },
          async execute(args) { return core.appControl(args) },
        }),
      ]
      for (const tool of tools) {
        try {
          disposers.push(ctx.tools.register(tool))
        } catch (error) {
          core.log({ tool: 'register', name: tool && tool.name, error: String(error && error.message ? error.message : error) })
        }
      }
      return () => {
        for (const d of disposers) { try { d() } catch {} }
        try { stopIndicator() } catch {}
      }
    }, 'win-tools: tools')
  } catch (error) {
    core.log({ tool: 'registration-failed', error: String(error && error.message ? error.message : error) })
    try { ctx?.logger?.warn?.('win-tools registration failed: ' + (error instanceof Error ? error.message : String(error))) } catch {}
  }
}