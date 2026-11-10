/**
 * Input injection for dsh-cua-win: SendInput only, absolute coordinates.
 *
 * SetCursorPos + relative mouse_event were tried against WeChatAppEx.exe
 * (Chromium borderless, Chrome_WidgetWin_0): the cursor moves but the click
 * never lands. Absolute SendInput (MOUSEEVENTF_ABSOLUTE | MOVE, coordinates
 * normalized to the virtual desktop) hits the same point first try. This
 * file contains nothing else on purpose.
 *
 * @module dsh-cua-win/lib/input
 */
import {
  CONST,
  cursorPos,
  keyInput,
  mouseButtonInput,
  mouseMoveInput,
  native,
  sendInput,
  sleep,
  unicodeInput,
} from './native.js'

/** Map of key names to virtual-key codes (the combos a desktop agent needs). */
const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11,
  alt: 0x12, menu: 0x12, pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  printscreen: 0x2c, insert: 0x2d, delete: 0x2e, win: 0x5b, meta: 0x5b, apps: 0x5d,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78,
  f10: 0x79, f11: 0x7a, f12: 0x7b, f13: 0x7c, f14: 0x7d, f15: 0x7e,
  numlock: 0x90, scrolllock: 0x91,
}

const BUTTONS = {
  left: { down: CONST.MOUSEEVENTF_LEFTDOWN, up: CONST.MOUSEEVENTF_LEFTUP },
  right: { down: CONST.MOUSEEVENTF_RIGHTDOWN, up: CONST.MOUSEEVENTF_RIGHTUP },
  middle: { down: CONST.MOUSEEVENTF_MIDDLEDOWN, up: CONST.MOUSEEVENTF_MIDDLEUP },
}

/**
 * Parse a key combo string ("ctrl+shift+tab", "enter", "a") to VK codes.
 * @param {string} keys
 * @returns {Array<number>} in modifier-first order.
 * @throws on an unknown key name.
 */
export function parseKeys(keys) {
  if (typeof keys !== 'string' || keys.trim() === '') throw new Error('keys must be a non-empty string')
  const parts = keys.split('+').map((part) => part.trim().toLowerCase()).filter((part) => part !== '')
  if (parts.length === 0) throw new Error('keys parsed to nothing')
  const out = []
  for (const part of parts) {
    if (part.length === 1) {
      out.push(part.toUpperCase().charCodeAt(0))
    } else if (VK[part] !== undefined) {
      out.push(VK[part])
    } else {
      throw new Error(`unknown key "${part}"`)
    }
  }
  return out
}

/**
 * Move the cursor to a physical point (absolute SendInput).
 * @param {number} x
 * @param {number} y
 */
export function move(x, y) {
  sendInput([mouseMoveInput(x, y)])
  return cursorPos()
}

/**
 * Click at a physical point. Moves first (absolute), then the button events.
 * @param {number} x
 * @param {number} y
 * @param {string} button - left | right | middle.
 * @param {number} clickCount - 1 or 2 (2 = double click).
 * @param {number} [delayMs] - between events.
 * @returns {{cursor:{x,y}|null, sent:number, afterWindow:null}}
 */
export function click(x, y, button = 'left', clickCount = 1, delayMs = 40) {
  const b = BUTTONS[button] ?? BUTTONS.left
  move(x, y)
  const events = []
  const count = clickCount === 2 ? 2 : 1
  for (let i = 0; i < count; i += 1) {
    events.push(mouseButtonInput(b.down))
    events.push(mouseButtonInput(b.up))
  }
  // Interleave small waits inside one batch is not possible; send per pair.
  let sent = 0
  for (let i = 0; i < events.length; i += 2) {
    sent += sendInput([events[i], events[i + 1]])
    if (i + 2 < events.length && delayMs > 0) {
      // busy-free pause between double-click halves
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    }
  }
  return { cursor: cursorPos(), sent }
}

/**
 * Drag from one point to another with interpolated motion.
 * @param {number[]} from - [x,y].
 * @param {number[]} to - [x,y].
 * @param {number} durationMs - total drag duration.
 * @param {string} button
 */
export async function drag(from, to, durationMs = 300, button = 'left') {
  const b = BUTTONS[button] ?? BUTTONS.left
  const fx = from[0], fy = from[1], tx = to[0], ty = to[1]
  move(fx, fy)
  await sleep(60)
  sendInput([mouseButtonInput(b.down)])
  const steps = Math.max(2, Math.min(60, Math.round(durationMs / 10)))
  const dt = durationMs / steps
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    // ease-in-out so Chromium sees a plausible human-ish swipe
    const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
    move(fx + (tx - fx) * eased, fy + (ty - fy) * eased)
    await sleep(Math.max(1, Math.round(dt)))
  }
  move(tx, ty)
  await sleep(40)
  sendInput([mouseButtonInput(b.up)])
  return { cursor: cursorPos() }
}

/**
 * Press a key combo n times.
 * @param {string} keys
 * @param {number} times
 */
export async function keyPress(keys, times = 1) {
  const codes = parseKeys(keys)
  const count = Math.min(20, Math.max(1, Math.round(times) || 1))
  for (let n = 0; n < count; n += 1) {
    for (const vk of codes) sendInput([keyInput(vk, false)])
    // release in reverse (modifiers last)
    for (const vk of [...codes].reverse()) sendInput([keyInput(vk, true)])
    if (n + 1 < count) await sleep(60)
  }
  return { keys, times: count }
}

/**
 * Type text through KEYEVENTF_UNICODE (layout-independent).
 *
 * A newline cannot travel as a unicode character: most edit controls ignore a
 * U+000A / U+000D arrival, so a multi-line string used to land on one line.
 * "\n" (and "\r\n") is therefore emitted as a real VK_RETURN keystroke.
 *
 * @param {string} text
 */
export async function typeText(text) {
  const value = typeof text === 'string' ? text : String(text)
  if (value.length === 0) return { typed: 0 }
  const VK_RETURN = 0x0d
  // Batch so a single sync call does not stall the host for long text.
  const CHUNK = 64
  let events = []
  let typed = 0
  const flush = () => {
    if (events.length > 0) {
      sendInput(events)
      events = []
    }
  }
  for (const ch of value) {
    if (ch === '\r') continue // CRLF collapses to the single Enter below
    if (ch === '\n') {
      flush()
      sendInput([keyInput(VK_RETURN, false)])
      sendInput([keyInput(VK_RETURN, true)])
      await sleep(25)
      typed += 1
      continue
    }
    const code = ch.codePointAt(0)
    if (code > 0xffff) {
      const lead = 0xd800 + Math.floor((code - 0x10000) / 0x400)
      const trail = 0xdc00 + ((code - 0x10000) % 0x400)
      events.push(unicodeInput(lead, false), unicodeInput(lead, true), unicodeInput(trail, false), unicodeInput(trail, true))
    } else {
      events.push(unicodeInput(code, false), unicodeInput(code, true))
    }
    typed += 1
    if (events.length >= CHUNK * 2) {
      flush()
      await sleep(8)
    }
  }
  flush()
  return { typed }
}

/** Scroll helper (not a first-class tool yet; used by future cua_scroll). */
export async function scroll(dx, dy) {
  if (dy) sendInput([mouseButtonInput(CONST.MOUSEEVENTF_WHEEL, -Math.round(dy) * CONST.WHEEL_DELTA)])
  if (dx) sendInput([mouseButtonInput(CONST.MOUSEEVENTF_HWHEEL, Math.round(dx) * CONST.WHEEL_DELTA)])
  return { dx, dy }
}
