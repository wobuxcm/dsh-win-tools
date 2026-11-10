/**
 * Screen capture, PNG encoding, scaling, and pixel probes for dsh-cua-win.
 *
 * Every capture keeps TWO artifacts:
 *  1. the full-resolution RGBA frame in an in-memory LRU shot store (this is
 *     what pixel_matches / region_ratio / image_changed compare against —
 *     physical-pixel exact);
 *  2. the (possibly downscaled) PNG handed to the model as a DSH attachment,
 *     so tokens stay sane (default longest edge 1600px).
 *
 * @module dsh-cua-win/lib/screen
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PNG } from 'pngjs'
import {
  CONST,
  captureRegion,
  findWindow,
  foregroundInfo,
  native,
  setForeground,
  virtualScreen,
  windowRect,
} from './native.js'

/** In-memory shot store: id -> full-res frame. Bounded, oldest dropped. */
const SHOT_LIMIT = 8
const shots = new Map()
let shotSeq = 0

/**
 * Store one frame and return its id.
 * @param {{rgba:Uint8Array,width:number,height:number,rect:object}} frame
 * @returns {string} shot id.
 */
function rememberShot(frame) {
  shotSeq += 1
  const id = `shot-${shotSeq}`
  shots.set(id, frame)
  while (shots.size > SHOT_LIMIT) {
    const oldest = shots.keys().next().value
    shots.delete(oldest)
  }
  return id
}

/** @returns a stored shot by id, or null. */
export function getShot(id) {
  return typeof id === 'string' ? shots.get(id) ?? null : null
}

/**
 * Biliear-rescale an RGBA frame to a target long edge.
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @param {number} longEdge - target longest side in pixels (<=0 = keep).
 * @returns {{rgba:Uint8Array,width:number,height:number,scale:number}}
 */
export function rescale(rgba, w, h, longEdge) {
  const target = Number.isFinite(longEdge) && longEdge > 0 ? Math.round(longEdge) : 0
  if (!target || (w <= target && h <= target)) return { rgba, width: w, height: h, scale: 1 }
  const ratio = Math.min(target / w, target / h)
  const nw = Math.max(1, Math.round(w * ratio))
  const nh = Math.max(1, Math.round(h * ratio))
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y += 1) {
    const sy = Math.min(h - 1, (y + 0.5) / ratio - 0.5)
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(h - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(w - 1, (x + 0.5) / ratio - 0.5)
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(w - 1, x0 + 1)
      const fx = sx - x0
      const i = (y * nw + x) * 4
      for (let c = 0; c < 3; c += 1) {
        const p00 = rgba[(y0 * w + x0) * 4 + c]
        const p01 = rgba[(y0 * w + x1) * 4 + c]
        const p10 = rgba[(y1 * w + x0) * 4 + c]
        const p11 = rgba[(y1 * w + x1) * 4 + c]
        out[i + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy
      }
      out[i + 3] = 255
    }
  }
  return { rgba: out, width: nw, height: nh, scale: ratio }
}

/**
 * Encode an RGBA frame as PNG.
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @returns {Buffer}
 */
export function encodePng(rgba, w, h) {
  const png = new PNG({ width: w, height: h })
  png.data.set(rgba)
  return PNG.sync.write(png, { deflateLevel: 6 })
}

/**
 * Capture the screen (or a window, or a rect) at full resolution.
 *
 * target:
 *  - "screen": the whole virtual desktop.
 *  - "window": a window's rect. The window is brought to the foreground FIRST
 *    (BitBlt sees whatever is on top — an occluded window is captured as its
 *    occluder), and the result reports who ended up in the foreground.
 *  - "rect": an explicit physical-pixel rect [x, y, w, h].
 *
 * @param {object} options - {target, window, rect, bringToFront}
 * @returns {object} {ok, screenshotId, width, height, rect, foreground, scaled, scale, message}
 */
export function capture(options = {}) {
  const target = options.target === 'window' || options.target === 'rect' ? options.target : 'screen'
  const vs = virtualScreen()
  let rect
  let foreground = foregroundInfo()
  let bringToFront = options.bringToFront !== false

  if (target === 'window') {
    const win = findWindow(options.window)
    if (!win) return { ok: false, code: 'WINDOW_NOT_FOUND', message: `no window matches ${JSON.stringify(options.window)}` }
    const wr = windowRect(win.hwnd)
    if (!wr) return { ok: false, code: 'WINDOW_NOT_FOUND', message: 'window rect unavailable' }
    rect = wr
    if (bringToFront) {
      const fg = setForeground(win.hwnd)
      foreground = foregroundInfo()
      if (!fg.foreground) {
        return {
          ok: false, code: 'FOREGROUND_FAILED',
          message: `could not bring "${win.title}" to the foreground (current: "${foreground?.title ?? 'unknown'}"); capture aborted because BitBlt would photograph the occluder`,
        }
      }
    }
  } else if (target === 'rect') {
    const r = Array.isArray(options.rect) ? options.rect.map(Number) : null
    if (!r || r.length !== 4 || r.some((v) => !Number.isFinite(v))) {
      return { ok: false, code: 'INVALID_ARGS', message: 'rect must be [x, y, w, h] in physical pixels' }
    }
    rect = { x: r[0], y: r[1], w: Math.round(r[2]), h: Math.round(r[3]) }
    if (rect.w <= 0 || rect.h <= 0) return { ok: false, code: 'INVALID_ARGS', message: 'rect w/h must be positive' }
  } else {
    rect = { x: vs.left, y: vs.top, w: vs.width, h: vs.height }
  }

  // Clamp capture to the virtual desktop so an off-screen rect cannot hang GDI.
  const x1 = Math.max(vs.left, rect.x)
  const y1 = Math.max(vs.top, rect.y)
  const x2 = Math.min(vs.left + vs.width, rect.x + rect.w)
  const y2 = Math.min(vs.top + vs.height, rect.y + rect.h)
  const w = Math.max(1, Math.round(x2 - x1))
  const h = Math.max(1, Math.round(y2 - y1))

  let frame
  try {
    frame = captureRegion(x1, y1, w, h)
  } catch (error) {
    return { ok: false, code: 'CAPTURE_FAILED', message: String(error?.message ?? error) }
  }
  const screenshotId = rememberShot({ ...frame, rect: { x: x1, y: y1, w, h } })
  return {
    ok: true,
    screenshotId,
    width: w,
    height: h,
    rect: { x: x1, y: y1, w, h },
    foreground: foreground ? { title: foreground.title, pid: foreground.pid, process: foreground.process } : null,
  }
}

/**
 * Produce the model-facing PNG for a capture result.
 * @param {string} screenshotId
 * @param {number} longEdge - target longest edge.
 * @returns {{png:Buffer,width:number,height:number,scale:number}|null}
 */
export function pngForShot(screenshotId, longEdge) {
  const shot = getShot(screenshotId)
  if (!shot) return null
  const scaled = rescale(shot.rgba, shot.width, shot.height, longEdge)
  return { png: encodePng(scaled.rgba, scaled.width, scaled.height), width: scaled.width, height: scaled.height, scale: scaled.scale }
}

// ---------------------------------------------------------------- probes

/**
 * Parse "#rrggbb" / "rrggbb" into [r,g,b].
 * @param {string} color
 * @returns {number[]|null}
 */
export function parseColor(color) {
  if (typeof color !== 'string') return null
  const hex = color.startsWith('#') ? color.slice(1) : color
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

/**
 * pixel_matches: single physical pixel color within tolerance of target.
 * Reads directly from a captured frame (no GDI round-trip inside the poll
 * loop's comparison step — the loop captures, this only compares).
 *
 * @param {object} frame - {rgba,width,height,rect}
 * @param {number} x - physical screen x.
 * @param {number} y - physical screen y.
 * @param {number[]} rgb - [r,g,b].
 * @param {number} tolerance - per-channel.
 * @returns {boolean}
 */
export function pixelMatches(frame, x, y, rgb, tolerance) {
  if (!frame) return false
  const { rgba, width, height, rect } = frame
  const px = Math.round(x) - rect.x
  const py = Math.round(y) - rect.y
  if (px < 0 || py < 0 || px >= width || py >= height) return false
  const i = (py * width + px) * 4
  const t = Number.isFinite(tolerance) ? Math.abs(tolerance) : 0
  return (
    Math.abs(rgba[i] - rgb[0]) <= t
    && Math.abs(rgba[i + 1] - rgb[1]) <= t
    && Math.abs(rgba[i + 2] - rgb[2]) <= t
  )
}

/**
 * region_ratio: share of pixels in a rect within tolerance of the color.
 * @param {object} frame - full-frame or rect-frame with .rect.
 * @param {number[]} region - [x,y,w,h] physical.
 * @param {number[]} rgb
 * @param {number} tolerance
 * @returns {number} ratio in [0,1]; -1 when the region misses the frame.
 */
export function regionRatio(frame, region, rgb, tolerance) {
  if (!frame) return -1
  const { rgba, width, height, rect } = frame
  const [rx, ry, rw, rh] = region
  const x1 = Math.max(0, Math.round(rx) - rect.x)
  const y1 = Math.max(0, Math.round(ry) - rect.y)
  const x2 = Math.min(width, Math.round(rx + rw) - rect.x)
  const y2 = Math.min(height, Math.round(ry + rh) - rect.y)
  if (x2 <= x1 || y2 <= y1) return -1
  const t = Number.isFinite(tolerance) ? Math.abs(tolerance) : 0
  let hits = 0
  const total = (x2 - x1) * (y2 - y1)
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const i = (y * width + x) * 4
      if (
        Math.abs(rgba[i] - rgb[0]) <= t
        && Math.abs(rgba[i + 1] - rgb[1]) <= t
        && Math.abs(rgba[i + 2] - rgb[2]) <= t
      ) hits += 1
    }
  }
  return hits / total
}

/**
 * image_changed: fraction of differing pixels vs a baseline shot, clipped to
 * a rect when given.
 * @param {object} frame - current.
 * @param {object} baseline - stored shot.
 * @param {number[]|undefined} region - [x,y,w,h] physical.
 * @returns {number} change ratio in [0,1]; -1 when not comparable.
 */
export function imageChangeRatio(frame, baseline, region) {
  if (!frame || !baseline) return -1
  const { rgba, width, height, rect } = frame
  const b = baseline
  if (b.width !== width || b.height !== height) return -1
  const x1 = Math.max(0, region ? Math.round(region[0]) - rect.x : 0)
  const y1 = Math.max(0, region ? Math.round(region[1]) - rect.y : 0)
  const x2 = Math.min(width, region ? Math.round(region[0] + region[2]) - rect.x : width)
  const y2 = Math.min(height, region ? Math.round(region[1] + region[3]) - rect.y : height)
  if (x2 <= x1 || y2 <= y1) return -1
  let diff = 0
  const total = (x2 - x1) * (y2 - y1)
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const i = (y * width + x) * 4
      if (
        rgba[i] !== b.rgba[i] || rgba[i + 1] !== b.rgba[i + 1] || rgba[i + 2] !== b.rgba[i + 2]
      ) diff += 1
    }
  }
  return diff / total
}

/** Save a PNG to disk, creating the directory. Returns the absolute path. */
export function savePng(path, png) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png)
  return path
}
