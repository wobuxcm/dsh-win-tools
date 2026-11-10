/**
 * Win32 native bindings for dsh-cua-win.
 *
 * One module, one koffi context, loaded lazily and at most once. Everything
 * the rest of the plugin needs from user32/gdi32/kernel32 is declared here
 * behind small JS wrappers, so no other file ever touches koffi directly and
 * a koffi failure degrades to "plugin reports missing native layer" instead
 * of an activation crash.
 *
 * DPI: SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) is called at init
 * (falling back to SetProcessDPIAware on old systems). Electron hosts are
 * already per-monitor aware, so this is a defensive no-op there — but a bare
 * Node host gets correct physical-pixel coordinates either way. Without it,
 * GetSystemMetrics/GetWindowRect lie by the scale factor (e.g. ~2x off at
 * 150% on 2880x1800).
 *
 * @module dsh-cua-win/lib/native
 */
import koffi from 'koffi'

/** All GDI objects created by this module are deleted eagerly; leaks here hang sessions. */
let state = null

/** Win32 constants used by the wrappers. */
export const CONST = {
  SM_CXSCREEN: 0,
  SM_CYSCREEN: 1,
  SM_XVIRTUALSCREEN: 76,
  SM_YVIRTUALSCREEN: 77,
  SM_CXVIRTUALSCREEN: 78,
  SM_CYVIRTUALSCREEN: 79,
  SRCCOPY: 0x00cc0020,
  SW_RESTORE: 9,
  SW_SHOW: 5,
  GA_ROOT: 2,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  // mouse flags
  MOUSEEVENTF_MOVE: 0x0001,
  MOUSEEVENTF_LEFTDOWN: 0x0002,
  MOUSEEVENTF_LEFTUP: 0x0004,
  MOUSEEVENTF_RIGHTDOWN: 0x0008,
  MOUSEEVENTF_RIGHTUP: 0x0010,
  MOUSEEVENTF_MIDDLEDOWN: 0x0020,
  MOUSEEVENTF_MIDDLEUP: 0x0040,
  MOUSEEVENTF_XDOWN: 0x0080,
  MOUSEEVENTF_XUP: 0x0100,
  MOUSEEVENTF_WHEEL: 0x0800,
  MOUSEEVENTF_HWHEEL: 0x1000,
  MOUSEEVENTF_MOVE_NOCOALESCE: 0x2000,
  MOUSEEVENTF_VIRTUALDESK: 0x4000,
  MOUSEEVENTF_ABSOLUTE: 0x8000,
  // keyboard flags
  KEYEVENTF_EXTENDEDKEY: 0x0001,
  KEYEVENTF_KEYUP: 0x0002,
  KEYEVENTF_UNICODE: 0x0004,
  // input types
  INPUT_MOUSE: 0,
  INPUT_KEYBOARD: 1,
  WHEEL_DELTA: 120,
}

/**
 * Declare every native function once and wrap it behind plain JS.
 * @returns the native state object.
 */
function init() {
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  const RECT = koffi.struct('CUA_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = koffi.struct('CUA_POINT', { x: 'long', y: 'long' })
  const MOUSEINPUT = koffi.struct('CUA_MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
  const KEYBDINPUT = koffi.struct('CUA_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
  const HARDWAREINPUT = koffi.struct('CUA_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
  const INPUT_UNION = koffi.union('CUA_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
  const INPUT = koffi.struct('CUA_INPUT', { type: 'uint32', u: INPUT_UNION })
  const BITMAPINFOHEADER = koffi.struct('CUA_BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16', biBitCount: 'uint16',
    biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'long', biYPelsPerMeter: 'long',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  })
  const EnumWindowsCb = koffi.proto('bool __stdcall CUA_EnumWindowsCb(intptr hwnd, intptr lparam)')

  // ---- DPI awareness: must happen before any coordinate API is trusted.
  let dpiAware = false
  try {
    const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr value)')
    dpiAware = SetProcessDpiAwarenessContext(-4) // PER_MONITOR_AWARE_V2
  } catch {
    dpiAware = false
  }
  if (!dpiAware) {
    try {
      user32.func('bool __stdcall SetProcessDPIAware()')()
      dpiAware = true
    } catch {
      dpiAware = false
    }
  }

  const fn = {
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    GetDpiForSystem: user32.func('uint32 __stdcall GetDpiForSystem()'),
    GetForegroundWindow: user32.func('intptr __stdcall GetForegroundWindow()'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr hWnd, _Out_ uint16_t *buf, int max)'),
    GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr hWnd)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr hWnd, _Out_ uint16_t *buf, int max)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr hWnd, _Out_ CUA_RECT *rect)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(intptr hWnd, _Out_ CUA_RECT *rect)'),
    ClientToScreen: user32.func('bool __stdcall ClientToScreen(intptr hWnd, _Inout_ CUA_POINT *pt)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(CUA_EnumWindowsCb *cb, intptr lparam)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *pid)'),
    GetAncestor: user32.func('intptr __stdcall GetAncestor(intptr hwnd, uint32 gaFlags)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ CUA_POINT *pt)'),
    WindowFromPoint: user32.func('intptr __stdcall WindowFromPoint(CUA_POINT pt)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 n, CUA_INPUT *inputs, int size)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr)'),
    BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr, int)'),
    AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 from, uint32 to, bool attach)'),
    GetDC: user32.func('intptr __stdcall GetDC(intptr)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr, intptr)'),
    CreateCompatibleDC: gdi32.func('intptr __stdcall CreateCompatibleDC(intptr)'),
    CreateCompatibleBitmap: gdi32.func('intptr __stdcall CreateCompatibleBitmap(intptr, int, int)'),
    SelectObject: gdi32.func('intptr __stdcall SelectObject(intptr, intptr)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(intptr, int, int, int, int, intptr, int, int, uint32)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(intptr hdc, intptr hbm, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ CUA_BITMAPINFOHEADER *bmi, uint32 usage)'),
    GetCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    OpenProcess: kernel32.func('intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr h)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr h, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32 *size)'),
  }

  return { koffi, RECT, POINT, INPUT, BITMAPINFOHEADER, fn, dpiAware, INPUT_SIZE: koffi.sizeof(INPUT) }
}

/**
 * Get (and lazily create) the native binding state.
 * @returns the state object, or null when koffi is unusable on this machine.
 */
export function native() {
  if (state !== null) return state
  try {
    state = init()
  } catch (error) {
    console.warn(`[dsh-cua-win] native init failed: ${error?.message ?? error}`)
    state = { failed: String(error?.message ?? error) }
  }
  return state
}

/** @returns {boolean} whether the native layer loaded. */
export function nativeReady() {
  const s = native()
  return s !== null && s.failed === undefined
}

// ---------------------------------------------------------------- wrappers

/**
 * Read one window title (UTF-16 safe).
 * @param {bigint|number} hwnd
 * @returns {string}
 */
export function windowTitle(hwnd) {
  const { fn } = native()
  const len = fn.GetWindowTextLengthW(hwnd)
  if (len <= 0) return ''
  const buf = Buffer.alloc((len + 1) * 2)
  const n = fn.GetWindowTextW(hwnd, buf, len + 1)
  return buf.toString('utf16le', 0, n * 2)
}

/**
 * Read one window class name.
 * @param {bigint|number} hwnd
 * @returns {string}
 */
export function windowClass(hwnd) {
  const { fn } = native()
  const buf = Buffer.alloc(512)
  const n = fn.GetClassNameW(hwnd, buf, 256)
  return buf.toString('utf16le', 0, n * 2)
}

/**
 * Physical window rect.
 * @param {bigint|number} hwnd
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function windowRect(hwnd) {
  const { fn } = native()
  const rect = {}
  if (!fn.GetWindowRect(hwnd, rect)) return null
  return { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top }
}

/**
 * @param {bigint|number} hwnd
 * @returns {number} pid, or 0.
 */
export function windowPid(hwnd) {
  const { fn } = native()
  const pid = [0]
  fn.GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}

/**
 * Executable path of a pid (no external CLI: OpenProcess + QueryFullProcessImageNameW).
 * @param {number} pid
 * @returns {string|null}
 */
export function processPath(pid) {
  const { fn } = native()
  if (!pid) return null
  const h = fn.OpenProcess(CONST.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!h) return null
  try {
    const buf = Buffer.alloc(2048)
    const size = [1024]
    if (!fn.QueryFullProcessImageNameW(h, 0, buf, size)) return null
    return buf.toString('utf16le', 0, size[0] * 2)
  } finally {
    fn.CloseHandle(h)
  }
}

/** Executable base name, lowercase. */
export function processName(pid) {
  const path = processPath(pid)
  if (!path) return ''
  const base = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
  return base.toLowerCase()
}

/**
 * @returns {{left:number,top:number,width:number,height:number,dpi:number}} virtual desktop geometry.
 */
export function virtualScreen() {
  const { fn } = native()
  return {
    left: fn.GetSystemMetrics(CONST.SM_XVIRTUALSCREEN),
    top: fn.GetSystemMetrics(CONST.SM_YVIRTUALSCREEN),
    width: fn.GetSystemMetrics(CONST.SM_CXVIRTUALSCREEN),
    height: fn.GetSystemMetrics(CONST.SM_CYVIRTUALSCREEN),
    dpi: fn.GetDpiForSystem(),
  }
}

/**
 * Foreground window info.
 * @returns {{hwnd:any, title:string, pid:number, process:string}|null}
 */
export function foregroundInfo() {
  const { fn } = native()
  const hwnd = fn.GetForegroundWindow()
  if (!hwnd) return null
  const pid = windowPid(hwnd)
  return { hwnd, title: windowTitle(hwnd), pid, process: processName(pid) }
}

/**
 * Enumerate visible, titled, top-level windows.
 * @returns {Array<{hwnd:any,title:string,className:string,rect:object,pid:number,process:string,isForeground:boolean}>}
 */
export function listWindows() {
  const { fn } = native()
  const fg = fn.GetForegroundWindow()
  const out = []
  fn.EnumWindows((hwnd) => {
    if (!fn.IsWindowVisible(hwnd)) return true
    const title = windowTitle(hwnd)
    if (title === '') return true
    const pid = windowPid(hwnd)
    out.push({
      hwnd,
      title,
      className: windowClass(hwnd),
      rect: windowRect(hwnd),
      pid,
      process: processName(pid),
      isForeground: hwnd === fg,
    })
    return true
  }, 0)
  return out
}

/**
 * Find a window by decimal hwnd id or by title substring (case-insensitive).
 * @param {object} spec - {window} where window is a numeric id or title fragment.
 * @returns the window entry, or null.
 */
export function findWindow(value) {
  const windows = listWindows()
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value ?? ''))
  if (numeric) {
    const id = typeof value === 'number' ? value : parseInt(value, 10)
    return windows.find((w) => Number(w.hwnd) === id) ?? null
  }
  const needle = String(value ?? '').toLowerCase()
  if (needle === '') return null
  return (
    windows.find((w) => w.title.toLowerCase() === needle)
    ?? windows.find((w) => w.title.toLowerCase().includes(needle))
    ?? null
  )
}

/**
 * Root window at a screen point.
 * @returns {{hwnd:any,title:string,pid:number,process:string}|null}
 */
export function windowAtPoint(x, y) {
  const { fn } = native()
  const hwnd = fn.WindowFromPoint({ x: Math.round(x), y: Math.round(y) })
  if (!hwnd) return null
  const root = fn.GetAncestor(hwnd, CONST.GA_ROOT) || hwnd
  const pid = windowPid(root)
  return { hwnd: root, title: windowTitle(root), pid, process: processName(pid) }
}

/**
 * Bring a window to the foreground — the full AttachThreadInput dance.
 *
 * A background process calling SetForegroundWindow alone gets FALSE (or a
 * silent flash) because Windows only grants foreground to the process the user
 * last interacted with. Attaching our thread to the current foreground
 * thread's input queue puts us in that queue, which unlocks
 * SetForegroundWindow. Without this, clicks land on whatever window Windows
 * kept in front instead.
 *
 * @param {bigint|number} hwnd
 * @returns {{ok:boolean, foreground:boolean, title:string}}
 */
export function setForeground(hwnd) {
  const { fn } = native()
  if (!fn.IsWindow(hwnd)) return { ok: false, foreground: false, title: '' }
  let attached = false
  let foreignThread = 0
  try {
    const fg = fn.GetForegroundWindow()
    if (fg && fg !== hwnd) {
      const pid = [0]
      foreignThread = fn.GetWindowThreadProcessId(fg, pid)
      const me = fn.GetCurrentThreadId()
      if (foreignThread && foreignThread !== me) {
        attached = fn.AttachThreadInput(foreignThread, me, true)
      }
    }
    if (fn.IsIconic(hwnd)) fn.ShowWindow(hwnd, CONST.SW_RESTORE)
    else fn.ShowWindow(hwnd, CONST.SW_SHOW)
    fn.BringWindowToTop(hwnd)
    const ok = fn.SetForegroundWindow(hwnd)
    const nowFg = fn.GetForegroundWindow() === hwnd
    return { ok: ok || nowFg, foreground: nowFg, title: windowTitle(hwnd) }
  } finally {
    if (attached && foreignThread) {
      try {
        fn.AttachThreadInput(foreignThread, fn.GetCurrentThreadId(), false)
      } catch {
        // detach failure leaves a harmless shared input queue; do not throw
      }
    }
  }
}

/**
 * Capture a screen region as raw BGRA (top-down) using GDI BitBlt.
 *
 * PrintWindow renders Chromium windows black; BitBlt from the screen DC
 * captures what is physically on those pixels — so the caller must ensure the
 * target is in the foreground or accept occlusion.
 *
 * @param {number} x - physical screen x.
 * @param {number} y - physical screen y.
 * @param {number} w - width in pixels.
 * @param {number} h - height in pixels.
 * @returns {{rgba:Uint8Array,width:number,height:number}} RGBA, top-down.
 */
export function captureRegion(x, y, w, h) {
  const { fn, BITMAPINFOHEADER } = native()
  if (w <= 0 || h <= 0) throw new Error(`invalid capture size ${w}x${h}`)
  const hdc = fn.GetDC(0)
  if (!hdc) throw new Error('GetDC(NULL) failed')
  let mem = 0
  let bm = 0
  try {
    mem = fn.CreateCompatibleDC(hdc)
    bm = fn.CreateCompatibleBitmap(hdc, w, h)
    if (!bm) throw new Error('CreateCompatibleBitmap failed')
    fn.SelectObject(mem, bm)
    if (!fn.BitBlt(mem, 0, 0, w, h, hdc, x, y, CONST.SRCCOPY)) {
      throw new Error(`BitBlt failed (region ${x},${y} ${w}x${h})`)
    }
    const bgra = Buffer.alloc(w * h * 4)
    const bmi = {
      biSize: native().koffi.sizeof(BITMAPINFOHEADER), biWidth: w, biHeight: -h, biPlanes: 1,
      biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
      biClrUsed: 0, biClrImportant: 0,
    }
    const lines = fn.GetDIBits(mem, bm, 0, h, bgra, bmi, 0)
    if (lines !== h) throw new Error(`GetDIBits returned ${lines}/${h} lines`)
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i += 1) {
      rgba[i * 4] = bgra[i * 4 + 2]
      rgba[i * 4 + 1] = bgra[i * 4 + 1]
      rgba[i * 4 + 2] = bgra[i * 4]
      rgba[i * 4 + 3] = 255
    }
    return { rgba, width: w, height: h }
  } finally {
    if (bm) fn.DeleteObject(bm)
    if (mem) fn.DeleteDC(mem)
    fn.ReleaseDC(0, hdc)
  }
}

/**
 * Normalize one SendInput mouse struct with absolute virtual-desktop coords.
 * @param {number} x - physical screen x.
 * @param {number} y - physical screen y.
 * @returns {{type:number,u:{mi:object}}}
 */
export function mouseMoveInput(x, y) {
  const { left, top, width, height } = virtualScreen()
  const nx = Math.round(((x - left) * 65535) / (width - 1))
  const ny = Math.round(((y - top) * 65535) / (height - 1))
  return {
    type: CONST.INPUT_MOUSE,
    u: { mi: { dx: nx, dy: ny, mouseData: 0, dwFlags: CONST.MOUSEEVENTF_MOVE | CONST.MOUSEEVENTF_ABSOLUTE | CONST.MOUSEEVENTF_VIRTUALDESK, time: 0, dwExtraInfo: 0n } },
  }
}

/**
 * @param {number} flags - MOUSEEVENTF_* flags.
 * @param {number} [data] - mouseData (button or wheel delta).
 * @returns {{type:number,u:{mi:object}}}
 */
export function mouseButtonInput(flags, data = 0) {
  return { type: CONST.INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0n } } }
}

/**
 * @param {number} vk - virtual key code.
 * @param {boolean} up - key-up instead of key-down.
 * @returns {{type:number,u:{ki:object}}}
 */
export function keyInput(vk, up) {
  return { type: CONST.INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? CONST.KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0n } } }
}

/**
 * @param {number} codePoint - one UTF-16 code unit.
 * @param {boolean} up
 * @returns {{type:number,u:{ki:object}}}
 */
export function unicodeInput(codePoint, up) {
  return { type: CONST.INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: codePoint, dwFlags: CONST.KEYEVENTF_UNICODE | (up ? CONST.KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0n } } }
}

/**
 * Submit one input batch. Returns how many events were accepted.
 * @param {Array<object>} inputs
 * @returns {number}
 */
export function sendInput(inputs) {
  const { fn, INPUT_SIZE } = native()
  if (inputs.length === 0) return 0
  return fn.SendInput(inputs.length, inputs, INPUT_SIZE)
}

/** Current cursor position in physical screen coordinates. */
export function cursorPos() {
  const { fn } = native()
  const pt = {}
  if (!fn.GetCursorPos(pt)) return null
  return { x: pt.x, y: pt.y }
}

/** Sleep helper usable inside the poll loop (keeps the host event loop live). */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
