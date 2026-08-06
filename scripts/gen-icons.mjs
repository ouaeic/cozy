// Generates the app and tray icons as real PNGs, from code.
//
// Committing generated binaries is fine, but committing a *generator* means the
// mark can be tweaked without a design tool in the loop. Run: node scripts/gen-icons.mjs
//
// The mark: two overlapping rounded shapes on a warm dark field — two people
// sharing one frame. Ember on charcoal, matching the app's palette.

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** rgba: Uint8ClampedArray of w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------ drawing

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** Anti-aliased coverage for a signed distance (negative = inside). */
const cov = (d, aa) => clamp01(0.5 - d / aa)

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

function blend(dst, i, r, g, b, a) {
  if (a <= 0) return
  const ia = dst[i + 3] / 255
  const oa = a + ia * (1 - a)
  if (oa <= 0) return
  dst[i] = (r * a + dst[i] * ia * (1 - a)) / oa
  dst[i + 1] = (g * a + dst[i + 1] * ia * (1 - a)) / oa
  dst[i + 2] = (b * a + dst[i + 2] * ia * (1 - a)) / oa
  dst[i + 3] = oa * 255
}

/** The full-colour app icon. */
function appIcon(size) {
  const px = new Uint8ClampedArray(size * size * 4)
  const s = size / 512 // design at 512
  const aa = 1.5

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const cx = x + 0.5
      const cy = y + 0.5

      // Field: a superellipse-ish rounded square, macOS-friendly proportions.
      const field = sdRoundRect(cx, cy, size / 2, size / 2, 232 * s, 232 * s, 108 * s)
      const fieldA = cov(field, aa)
      if (fieldA > 0) {
        // Subtle vertical warm gradient so it doesn't read as flat.
        const t = clamp01((cy / size - 0.1) / 0.9)
        blend(px, i, 34 - 8 * t, 30 - 7 * t, 28 - 6 * t, fieldA)
      }

      // Back shape — the person further away, dimmer and offset up-left.
      const back = sdCircle(cx, cy, 200 * s, 216 * s, 88 * s)
      blend(px, i, 122, 96, 88, cov(back, aa) * fieldA * 0.95)

      // Front shape — ember, overlapping, down-right.
      const front = sdCircle(cx, cy, 306 * s, 292 * s, 104 * s)
      blend(px, i, 217, 101, 78, cov(front, aa) * fieldA)

      // A warm rim on the front shape's upper-left, so the two read as separate.
      const rim = Math.abs(sdCircle(cx, cy, 306 * s, 292 * s, 104 * s + 5 * s)) - 3 * s
      const rimSide = clamp01((292 * s - cy) / (60 * s) + (306 * s - cx) / (90 * s))
      blend(px, i, 246, 196, 168, cov(rim, aa) * fieldA * rimSide * 0.6)
    }
  }
  return encodePng(size, size, px)
}

/** Monochrome tray mark. On macOS this is a "template" image: black + alpha,
 *  which the OS inverts to suit a light or dark menu bar by itself.
 *
 *  Windows has no such concept — setTemplateImage is a compiled no-op there and
 *  the pixels are drawn literally, so a black glyph on the default dark taskbar
 *  is a black square on black. Windows therefore needs its own pre-coloured
 *  pair, picked at runtime from the *system* theme (see main/tray.ts). */
function trayIcon(size, rgb = [0, 0, 0]) {
  const px = new Uint8ClampedArray(size * size * 4)
  const s = size / 22 // design at 22pt
  const aa = 1.1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const cx = x + 0.5
      const cy = y + 0.5
      // Two overlapping rings — legible down to 16px.
      const a = Math.abs(sdCircle(cx, cy, 8.4 * s, 9.2 * s, 4.4 * s)) - 1.05 * s
      const b = Math.abs(sdCircle(cx, cy, 13.6 * s, 12.6 * s, 4.4 * s)) - 1.05 * s
      const alpha = Math.max(cov(a, aa), cov(b, aa))
      blend(px, i, rgb[0], rgb[1], rgb[2], alpha)
    }
  }
  return encodePng(size, size, px)
}

// ------------------------------------------------------------------ emit

mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'resources'), { recursive: true })

// ------------------------------------------------------------------ ICO
//
// Windows ignores the size you ask for unless the file is a real .ico: Electron
// takes a dedicated LoadImage() path for .ico and picks the best frame, whereas
// a .png is converted from its 1x representation only and then stretched by the
// shell. Hence a multi-size .ico, and hence the blurry tray icons in apps that
// ship a single PNG.
//
// Vista and later accept PNG-compressed frames inside an .ico, so each entry is
// just one of the PNGs above.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64]

function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = Buffer.alloc(16 * pngs.length)
  let offset = header.length + entries.length
  pngs.forEach(({ size, data }, i) => {
    const at = i * 16
    entries[at] = size >= 256 ? 0 : size // 0 means 256
    entries[at + 1] = size >= 256 ? 0 : size
    entries[at + 2] = 0 // palette count
    entries[at + 3] = 0 // reserved
    entries.writeUInt16LE(1, at + 4) // colour planes
    entries.writeUInt16LE(32, at + 6) // bits per pixel
    entries.writeUInt32LE(data.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, entries, ...pngs.map((p) => p.data)])
}

const icoFor = (rgb) =>
  encodeIco(ICO_SIZES.map((size) => ({ size, data: trayIcon(size, rgb) })))

writeFileSync(join(ROOT, 'build', 'icon.png'), appIcon(1024))
writeFileSync(join(ROOT, 'resources', 'trayTemplate.png'), trayIcon(22))
writeFileSync(join(ROOT, 'resources', 'trayTemplate@2x.png'), trayIcon(44))

// Named for the taskbar they belong on: a light glyph reads on a dark taskbar.
writeFileSync(join(ROOT, 'resources', 'tray-light-glyph.ico'), icoFor([242, 237, 231]))
writeFileSync(join(ROOT, 'resources', 'tray-dark-glyph.ico'), icoFor([32, 30, 28]))
// Linux has no template concept either, and no reliable theme signal, so it
// gets the same pre-coloured pair as PNGs.
writeFileSync(join(ROOT, 'resources', 'tray-light-glyph.png'), trayIcon(24, [242, 237, 231]))
writeFileSync(join(ROOT, 'resources', 'tray-dark-glyph.png'), trayIcon(24, [32, 30, 28]))

console.log('wrote app icon, macOS template PNGs, Windows .ico pair, Linux PNG pair')
