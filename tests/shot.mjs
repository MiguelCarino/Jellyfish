/*  tests/shot.mjs — render the real page in headless Chrome and measure it.

    The renderer's look is a physical claim: at 14 m of clear water the frame
    should be dim and the red channel should be almost gone. Both of those are
    measurable, so they are measured here rather than judged by eye. This drives
    Chrome over the DevTools protocol, which needs no dependency at all — Node 24
    ships a global WebSocket and Chrome speaks CDP over it.

    The canvas cannot be sampled directly: the context is created with
    preserveDrawingBuffer:false, so reading it outside a frame returns an empty
    buffer. Page.captureScreenshot goes through the compositor instead and gets
    the real pixels. The navbar is cropped off before any statistic is taken.

      node tests/shot.mjs [--t 12000] [--out shot.png] [--url ...] [--size 1440x900]

    Prints a JSON block of statistics and writes the PNG.                       */

import { spawn } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const WAIT = Number(arg('t', 12000))
const OUT  = arg('out', 'shot.png')
// The default carries ?hint=0. Every statistic below — maxLuminance, p99,
// dynamicRange, meanSrgb, redToBlueRatio, pureBlackPercent — is taken over
// every pixel from y = NAVBAR down, so the one line of #a3a3a3 text js/main.js
// draws along the bottom of the frame for a session's first 8.7 s (SPEC §9's
// second amendment) would be measured as though it were water: being grey in a
// frame whose red is almost gone it can only pull redToBlueRatio toward
// neutral, and landing on near-black it can only lower pureBlackPercent. The
// default --t of 12000 already clears the hint by 3.3 s, but --t is a flag and
// this baseline has to belong to the render rather than to the shutter delay.
// An explicit --url replaces the whole string, ?hint=0 and all.
const URL_ = arg('url', 'http://localhost:8823/index.html?hint=0')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const NAVBAR = 61                                  // the fleet navbar plus its border
const PORT = 9200 + (process.pid % 500)

/*  The browser, and the one platform-dependent line in this file. $CHROME wins,
    so a machine with Chrome anywhere unusual needs no edit; otherwise the first
    binary that exists is taken. ANGLE's Metal backend only exists on macOS, so
    the backend flag is chosen alongside the binary rather than hard-coded — on
    Linux that is ANGLE over the desktop GL driver, with SwiftShader still armed
    behind it for a box with no GPU at all.                                     */
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser', '/usr/bin/chromium',
].find(p => existsSync(p))
if (!CHROME) {
  console.error('no Chrome found; set $CHROME to its path')
  process.exit(1)
}
const ANGLE = process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=gl'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`,
  '--use-gl=angle', ANGLE, '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=/tmp/cdp-jelly-${process.pid}`, 'about:blank',
], { stdio: 'ignore' })

let target
for (let i = 0; i < 80; i++) {
  await sleep(250)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = list.find(t => t.type === 'page')
    if (target) break
  } catch {}
}
if (!target) { console.error('chrome did not start'); chrome.kill(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  const p = m.params
  if (m.method === 'Runtime.consoleAPICalled')
    logs.push(`[${p.type}] ` + p.args.map(a => a.value ?? a.description ?? '').join(' '))
  if (m.method === 'Runtime.exceptionThrown')
    logs.push('[EXCEPTION] ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text))
  if (m.method === 'Log.entryAdded' && p.entry.level !== 'verbose')
    logs.push(`[${p.entry.level}] ${p.entry.text}`)
})
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
})

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL_ })
await sleep(WAIT)

const shot = await send('Page.captureScreenshot', { format: 'png' })
const png = Buffer.from(shot.result.data, 'base64')
writeFileSync(OUT, png)

// Decode the PNG in-process: zlib is built in, and the compositor always hands
// back 8-bit non-interlaced RGBA, so a minimal reader is enough and keeps this
// script dependency-free like everything else in the repo.
const { inflateSync } = await import('node:zlib')
function decodePng (buf) {
  let off = 8, w = 0, h = 0, bitDepth = 8, colour = 6
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colour = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported')
  const ch = colour === 6 ? 4 : colour === 2 ? 3 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride); pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev ? prev[x] : 0
      const c = (prev && x >= ch) ? prev[x - ch] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 255
    }
  }
  return { w, h, ch, data: out }
}

const img = decodePng(png)
const srgbToLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }

let n = 0, sumL = 0, minL = 2, maxL = -1, black = 0
let sr = 0, sg = 0, sb = 0
const lums = []
for (let y = NAVBAR; y < img.h; y++) {
  for (let x = 0; x < img.w; x++) {
    const i = y * img.w * img.ch + x * img.ch
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
    const L = 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b)
    sumL += L; n++; if (L < minL) minL = L; if (L > maxL) maxL = L
    sr += r / 255; sg += g / 255; sb += b / 255
    if (r === 0 && g === 0 && b === 0) black++
    if (((x + y) & 7) === 0) lums.push(L)
  }
}
lums.sort((a, b) => a - b)
const pct = q => lums[Math.min(lums.length - 1, Math.floor(q * lums.length))]
const r3 = v => Math.round(v * 1e4) / 1e4

console.log(JSON.stringify({
  file: OUT, waitedMs: WAIT, pixels: n,
  meanLuminance: r3(sumL / n),
  minLuminance: r3(minL), maxLuminance: r3(maxL),
  p01: r3(pct(0.01)), p50: r3(pct(0.50)), p99: r3(pct(0.99)),
  dynamicRange: r3(pct(0.99) / Math.max(pct(0.01), 1e-6)),
  meanSrgb: { r: r3(sr / n), g: r3(sg / n), b: r3(sb / n) },
  redToBlueRatio: r3((sr / n) / Math.max(sb / n, 1e-6)),
  pureBlackPercent: r3(100 * black / n),
  consoleMessages: logs.length,
  console: logs.slice(0, 40),
}, null, 2))

chrome.kill(); process.exit(0)
