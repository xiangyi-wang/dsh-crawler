/**
 * @dsh-external/dsh-crawler — client 半边。
 *
 * 原作（daily.xyz/exhibition/crawlers-by-slava-rybin）：一只在维基正文上爬的虫子，
 * 腿由各自的振荡器驱动、相邻腿互相牵引；鼠标就是它的方向；它吃过的词会重新织成新段落。
 *
 * 这里把它搬进 dsh：引擎原样跑在界面上（透明 canvas、pointer-events:none），
 * 但引擎的自主模式需要「指针」才能激活——所以由一只**幽灵指针**在界面文字/图标/按钮上
 * 巡游，虫子跟着它走；鼠标真的动了，它就来追你的鼠标，几秒后再自己接着逛。
 *
 * 三个形态同时存在，随机出生、随机死亡、随机换形态；不过界面上不留调试 HUD。
 *
 * 本文件由 scripts/build-client.cjs 内联成 lib/client.js（module/exports 由外层注入），
 * 因此这里用 CommonJS 的写法，不要写 import/export。
 */
const ENGINE_B64 = '__ENGINE_B64__'
const SEEDS_GZ_B64 = '__SEEDS_GZ_B64__'
const AUDIO_POOL = __AUDIO_POOL__
const AUDIO_MAP_GZ_B64 = '__AUDIO_MAP_GZ_B64__'

const Z_BASE = 2147483600
// 每只虫一张「跟随相机的小画布」：只覆盖虫子周围一块，而不是整屏。
// 画布位置 = 引擎相机（世界坐标里画布左上角），所以虫子永远画在画布中央，
// 屏幕坐标 == 世界坐标；显存从每只 5.7MB 降到 ~1.1MB。
const PET_W = 560
const PET_H = 500
const BUILD_TAG = '__BUILD_TAG__'
const BUILD_VER = '__BUILD_VER__'
try { window.__dshCrawlerRev = BUILD_TAG } catch (err) { /* ignore */ }
// 引擎在它自己的帧里调用这个钩子（物理步进之后、绘制之前）：
// 把相机对准虫子，并把画布挪到相机位置。相机和画布永远同帧同值，不会有错相抖动。
try {
  window.__crawlerCamHook = (cam) => {
    if (!cam) return
    const pet = cam.__pet
    const el = cam.__canvas
    if (!pet || !el) return
    const p = pet.api && pet.api.spider && pet.api.spider.position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    const cx = p.x - PET_W / 2
    const cy = p.y - PET_H / 2
    cam.x = cx
    cam.y = cy
    const tx = Math.round(cx)
    const ty = Math.round(cy)
    if (pet.tx !== tx || pet.ty !== ty) {
      pet.tx = tx
      pet.ty = ty
      el.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0)'
    }
  }
} catch (err) { /* ignore */ }
const LS_KEY = 'dsh-crawler.v2'
const SHY_RADIUS = 170 // 光标"别靠近"半径（px）：全自主模式下虫子主动绕开干活的人
const DEBUG = (typeof location !== 'undefined' && /crawler-debug/.test(location.hash || ''))

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const rnd = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => arr[(Math.random() * arr.length) | 0]
const now = () => performance.now()

// 轻量启动/销毁打点：window.__crawlerPerf 可读，用来排查卡顿（保留最近 60 条）
const perfLog = []
try { window.__crawlerPerf = perfLog } catch (err) { /* ignore */ }
function perf(name, ms, extra) {
  try {
    perfLog.push([name, Math.round(ms), extra === undefined ? 0 : extra, Math.round(now())])
    if (perfLog.length > 60) perfLog.shift()
  } catch (err) { /* ignore */ }
}

// 虫子画布的渲染倍率：跟随显示器缩放（上限 2x）。固定 1x 时，125%/150% 缩放的显示器
// 会把画布放大显示——虫子看起来就是"糊"的。
const DPR_CAP = (() => {
  try { return Math.max(1, Math.min(window.devicePixelRatio || 1, 2)) } catch (err) { return 1 }
})()
try { window.__crawlerDprCap = DPR_CAP } catch (err) { /* ignore */ }

let engineSrc = ''
function engineText() {
  if (!engineSrc) engineSrc = atob(ENGINE_B64)
  return engineSrc
}

// —— 持久化：只存配置（这个插件只做视觉特效，不存词库/词条） ——
const store = (() => {
  try { return Object.assign({ sound: false }, JSON.parse(localStorage.getItem(LS_KEY) || '{}')) } catch (err) { return { sound: false } }
})()
let persistAt = 0

// —— 用户可调项（设置面板读写；overlay 订阅后实时生效） ——
// mode: 'follow' 跟着鼠标走 / 'auto' 完全自主探索
// 默认把所有视觉特效打开（吃字消失 / 感染界面 / 吃字特效 / 词链 / 织丝）；
// 词条生成（会写 localStorage）与声音默认关，需要时在设置里单独开。
const DEFAULTS = { enabled: true, mode: 'auto', count: 3, size: 'm', speed: 1, eat: true, lexicon: false, birth: true, stagger: true, shy: true, sound: false, silk: true, textFx: true, links: true, eatWords: true, infect: true }
const CONFIG_REV = 2
const cfg = Object.assign({}, DEFAULTS, store.config || {})
// 旧存档迁移（0.1.6）：早期版本把「吃字消失」「感染界面」默认关着，
// 升级后补开一次；其余用户选择（数量/体型/模式…）原样保留。
if (!(Number(store.configRev) >= CONFIG_REV)) {
  cfg.eatWords = true
  cfg.infect = true
}
if (cfg.mode !== 'follow' && cfg.mode !== 'auto') cfg.mode = 'auto'
if (!store.config && store.sound === true) cfg.sound = true

// —— 设置页 ↔ 页内小坞 的共享配置通道 ——
// 设置页是独立挂载的（比 overlay 活得久），所以它读 localStorage，写的时候如果 overlay
// 活着就顺带调它的 setConfig，保证两边永远同一个开关。
function readCrawlerConfig() {
  try {
    const ctl = typeof window !== 'undefined' ? window.__dshCrawlerCtl : null
    if (ctl && typeof ctl.get === 'function') return Object.assign({}, DEFAULTS, ctl.get() || {})
    const st = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return Object.assign({}, DEFAULTS, st.config || {})
  } catch (err) { return Object.assign({}, DEFAULTS) }
}

function writeCrawlerConfig(patch) {
  const next = Object.assign({}, readCrawlerConfig(), patch || {})
  try {
    const st = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    st.config = next
    localStorage.setItem(LS_KEY, JSON.stringify(st))
  } catch (err) { /* ignore */ }
  try {
    const ctl = typeof window !== 'undefined' ? window.__dshCrawlerCtl : null
    if (ctl && typeof ctl.set === 'function') ctl.set(patch || {})
  } catch (err) { /* ignore */ }
  return next
}
const SIZE_RANGE = { s: [9, 13], m: [13, 19], l: [19, 28] }
const listeners = new Set()
function setConfig(patch) {
  Object.assign(cfg, patch)
  persist(true)
  for (const fn of listeners) { try { fn(cfg) } catch (err) { /* ignore */ } }
}
function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
// 设置页 ↔ overlay 的常驻桥：不随 overlay 生死（关闭后仍能把虫子重新打开）
try {
  window.__dshCrawlerCtl = {
    get: () => Object.assign({}, cfg),
    set: (patch) => { try { setConfig(patch || {}) } catch (err) { /* ignore */ } },
    subscribe: (fn) => subscribe(fn),
  }
} catch (err) { /* ignore */ }

// —— 可选的「马尔可夫词条」数据（默认不积累；只有 cfg.lexicon 打开时才写） ——
const LORE_MAX = 8
const LORE_TTL = 24 * 60 * 60 * 1000
const lexicon = new Map(Object.entries(store.lexicon || {}))
let lore = Array.isArray(store.lore) ? store.lore.filter((e) => e && Date.now() - Number(e.at) < LORE_TTL).slice(-LORE_MAX) : []

function persist(force) {
  const t = Date.now()
  if (!force && t - persistAt < 1500) return
  persistAt = t
  try {
    const payload = { sound: store.sound, config: cfg, configRev: CONFIG_REV }
    if (cfg.lexicon) {
      const lex = {}
      for (const [k, v] of [...lexicon.entries()].sort((a, b) => b[1] - a[1]).slice(0, 180)) lex[k] = v
      payload.lexicon = lex
      payload.lore = lore.slice(-LORE_MAX)
    }
    localStorage.setItem(LS_KEY, JSON.stringify(payload))
  } catch (err) { /* ignore */ }
}

let seedsPromise = null // 主线程解析（Worker 不可用时的兜底）
let audioMap = {}
let audioPromise = null
let seedWorkerPromise = null
let seedWorkerRef = null
let seedWorkerStopTimer = 0
let seedReqId = 0
const seedWaiting = new Map()
const seedPool = []
async function gunzipB64(b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

/** 音色映射只有 1.5MB，主线程解析一次即可（几十 ms 以内）。 */
function loadAudio() {
  if (!audioPromise) {
    audioPromise = (async () => {
      const t0 = now()
      try {
        const text = await gunzipB64(AUDIO_MAP_GZ_B64)
        audioMap = JSON.parse(text) || {}
      } catch (err) { audioMap = {} }
      perf('audio-map', now() - t0)
      return audioMap
    })()
  }
  return audioPromise
}

/** 兜底：Worker 不可用时才在主线程解压解析 10MB 形态（约 670ms）。 */
function loadSeeds() {
  if (!seedsPromise) {
    seedsPromise = (async () => {
      const t0 = now()
      const seedText = await gunzipB64(SEEDS_GZ_B64)
      const all = JSON.parse(seedText)
      perf('seeds-parse-fallback', now() - t0)
      return Array.isArray(all) ? all : Object.values(all)
    })()
  }
  return seedsPromise
}

// Worker：10MB 形态数据的解压 + JSON.parse 全部放到后台线程；主线程只按需取几只虫的形态。
// 启动时主线程原本要阻塞 ~670ms，现在是 ~0（只传一个 2.4MB 的 base64 字符串进 worker）。
const SEED_WORKER_SRC = [
  "let seeds = null",
  "self.onmessage = async (e) => {",
  "  const d = e.data || {}",
  "  if (d.type === 'init') {",
  "    try {",
  "      const bin = Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0))",
  "      const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text()",
  "      const parsed = JSON.parse(text)",
  "      seeds = Array.isArray(parsed) ? parsed : Object.values(parsed)",
  "      self.postMessage({ type: 'ready', n: seeds.length })",
  "    } catch (err) { self.postMessage({ type: 'error', message: String(err) }) }",
  "    return",
  "  }",
  "  if (d.type === 'pick') {",
  "    if (!seeds) { self.postMessage({ type: 'seeds', id: d.id, seeds: [] }); return }",
  "    const n = Math.max(1, Math.min(16, d.n | 0))",
  "    const out = []",
  "    for (let i = 0; i < n; i++) out.push(seeds[(Math.random() * seeds.length) | 0])",
  "    self.postMessage({ type: 'seeds', id: d.id, seeds: out })",
  "  }",
  "}",
].join('\n')

function startSeedWorker() {
  if (seedWorkerPromise) return seedWorkerPromise
  seedWorkerPromise = new Promise((resolve) => {
    let done = false
    const finish = (w) => { if (done) return; done = true; resolve(w) }
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' ||
          !URL.createObjectURL || typeof DecompressionStream === 'undefined') { finish(null); return }
      const url = URL.createObjectURL(new Blob([SEED_WORKER_SRC], { type: 'text/javascript' }))
      const w = new Worker(url)
      const fail = () => {
        try { w.terminate() } catch (err) { /* ignore */ }
        finish(null)
      }
      w.onmessage = (e) => {
        const d = e.data || {}
        if (d.type === 'ready') { seedWorkerRef = w; finish(w); return }
        if (d.type === 'error') { fail(); return }
        if (d.type === 'seeds') {
          const fn = seedWaiting.get(d.id)
          if (fn) { seedWaiting.delete(d.id); fn(d.seeds) }
        }
      }
      w.onerror = fail
      w.postMessage({ type: 'init', b64: SEEDS_GZ_B64 })
      setTimeout(() => { if (!done) fail() }, 4000)
    } catch (err) { finish(null) }
  }).then((w) => {
    if (!w) console.warn('[crawler] seed worker unavailable — parsing on main thread')
    return w
  })
  return seedWorkerPromise
}

function cancelSeedWorkerStop() {
  if (seedWorkerStopTimer) { try { clearTimeout(seedWorkerStopTimer) } catch (err) { /* ignore */ } ; seedWorkerStopTimer = 0 }
}
function scheduleSeedWorkerStop() {
  cancelSeedWorkerStop()
  seedWorkerStopTimer = setTimeout(() => {
    seedWorkerStopTimer = 0
    if (cfg.enabled) return
    const w = seedWorkerRef
    seedWorkerRef = null
    seedWorkerPromise = null
    seedPool.length = 0
    try { w && w.terminate() } catch (err) { /* ignore */ }
    perf('seed-worker-stop', 0)
  }, 60000)
}

function requestSeeds(n) {
  return startSeedWorker().then((w) => {
    if (!w) return null
    return new Promise((resolve) => {
      const id = ++seedReqId
      seedWaiting.set(id, resolve)
      try { w.postMessage({ type: 'pick', id, n }) } catch (err) { seedWaiting.delete(id); resolve(null) }
      setTimeout(() => {
        if (seedWaiting.has(id)) { seedWaiting.delete(id); resolve(null) }
      }, 2500)
    })
  })
}

/** 取一个形态：优先从 worker 的小池子里拿，必要时补一批；worker 不可用才退回主线程。 */
async function takeSeed() {
  await loadAudio()
  if (seedPool.length) return seedPool.shift()
  const batch = await requestSeeds(6)
  if (batch && batch.length) {
    seedPool.push(...batch)
    return seedPool.shift()
  }
  const all = await loadSeeds()
  return pick(all)
}

function buildData(seed, scaleOverride) {
  const s = Object.assign({}, seed.settings)
  // 界面里不要这么多副作用：不扫描 DOM 文字、不改宿主样式、不画连接线
  s.scan_enabled = false
  s.modify_css = false
  s.view_connections = false
  s.view_look = false
  s.max_connections = 0
  s.patch_debug = false
  const range = SIZE_RANGE[cfg.size] || SIZE_RANGE.m
  s.scale = Number(scaleOverride) || rnd(range[0], range[1])
  s.pointer_circle = { scale: 0, opacity: 0 }
  // 深色界面上别让某些形态糊成一片
  if (typeof s.body_alpha === 'number') s.body_alpha = clamp(s.body_alpha, 0.55, 1)
  if (typeof s.leg_alpha === 'number') s.leg_alpha = clamp(s.leg_alpha, 0.45, 1)
  if (typeof s.joint_alpha === 'number') s.joint_alpha = clamp(s.joint_alpha, 0.35, 1)
  return {
    version: 1,
    mode: seed.mode,
    name: seed.name,
    settings: s,
    page_theme: 'dark',
    follow_pointer: true,
    // 相机由客户端每帧手动对准虫子（引擎自带的 camera_follow 在指针贴近时会停住，
    // 小画布上就会把虫子画出去），这里关掉，避免两边抢相机。
    camera_follow: false,
    camera_lag: 0.15,
    camera_inside_fade: 0,
    user_attention: { click: 0, scroll: 0, motion: 0, proximity: 0, lag: 0.5, transition_min: 0.2, transition_max: 0.8 },
    pointer_circle: { scale: 0, opacity: 0 },
    sound: 'off',
    audio: (seed.slug && audioMap[seed.slug]) || pick(AUDIO_POOL),
  }
}

/** 界面上的锚点：文字行、按钮、图标——幽灵指针要去的地方 */
function collectAnchors() {
  const out = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n = 0
  let node = walker.nextNode()
  while (node && out.length < 140 && n < 4000) {
    n++
    const text = node.nodeValue || ''
    if (!text.trim() || text.length < 2) { node = walker.nextNode(); continue }
    if (n % 3 !== 0) { node = walker.nextNode(); continue }
    const el = node.parentElement
    node = walker.nextNode()
    if (!el || el.closest('[data-crawler-ui]')) continue
    if (el.closest('canvas')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 10) continue
    if (r.bottom < 60 || r.top > vh - 30) continue
    out.push({ x: clamp(r.left + rnd(10, Math.max(20, r.width - 10)), 20, vw - 20), y: clamp(r.top + r.height * rnd(0.35, 0.75), 50, vh - 20) })
  }
  const clickable = document.querySelectorAll('button, [role="button"], a, input, [data-testid]')
  for (const el of clickable) {
    if (out.length > 170) break
    if (el.closest('[data-crawler-ui]')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 14 || r.height < 12 || r.width > vw * 0.9) continue
    if (r.bottom < 60 || r.top > vh - 30) continue
    out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  return out
}

function caretRectAt(x, y) {
  try {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y)
      if (!p || !p.offsetNode) return null
      const node = p.offsetNode
      if (node.nodeType !== 3) return null
      const text = node.nodeValue || ''
      let a = p.offset
      let b = p.offset
      const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/
      if (CJK.test(text[p.offset] || text[p.offset - 1] || '')) {
        // 中文没有空格：取两字窗口当"词"
        a = Math.max(0, Math.min(text.length - 2, p.offset > 0 ? p.offset - 1 : 0))
        b = Math.min(text.length, a + 2)
      } else {
        while (a > 0 && /[\p{L}\p{N}_]/u.test(text[a - 1] || '')) a--
        while (b < text.length && /[\p{L}\p{N}_]/u.test(text[b] || '')) b++
        if (b <= a) { b = Math.min(text.length, a + 2) }
      }
      const range = document.createRange()
      range.setStart(node, a)
      range.setEnd(node, Math.min(text.length, b))
      const r = range.getBoundingClientRect()
      if (!r || r.width < 1 || r.height < 1) return null
      return { rect: r, word: text.slice(a, b), el: node.parentElement, range }
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y)
      if (!range) return null
      const r = range.getBoundingClientRect()
      if (!r || r.width < 1) return null
      return { rect: r, word: '' }
    }
  } catch (err) { /* ignore */ }
  return null
}

function elementBoxAt(x, y) {
  try {
    const el = document.elementFromPoint(x, y)
    if (!el || el.closest('[data-crawler-ui]') || el.tagName === 'CANVAS') return null
    const target = el.closest('button, a, [role="button"], input, li, h1, h2, h3, p, code, td') || el
    const r = target.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return null
    // 太小的图标点、太大的容器都不要框（框住整个侧栏很难看）
    if (r.width > Math.min(560, window.innerWidth * 0.5) || r.height > 220) return null
    return { rect: r, el: target }
  } catch (err) { return null }
}

/** 清掉旧代 client 留下的调试节点（旧 bundle 的 dispose 没带走它们）。 */
function sweepLegacy() {
  try {
    const kill = (el) => { try { el && el.remove() } catch (err) { /* ignore */ } }
    // 旧代残留：可能还有上一代 overlay 的 canvas/坞在跑（热换模块时 dispose 没走干净），
    // 必须全清，否则会出现「关掉显示爬虫后还有几只旧的继续爬」。
    for (const el of document.querySelectorAll('canvas[data-crawler-ui], [data-crawler-ui]')) kill(el)
    for (const el of document.querySelectorAll('canvas[id^="crawler-canvas"]')) kill(el)
    kill(document.getElementById('crawler-canvas'))
    kill(document.getElementById('crawler-data'))
    for (const el of document.querySelectorAll('body > div')) {
      if (el.dataset && el.dataset.crawlerUi !== undefined) continue
      const t = (el.textContent || '').trim()
      if (t === 'CRAWLER-V2-PROBE' || /^fr=\d/.test(t) || t === 'ᨓ') kill(el)
    }
  } catch (err) { /* ignore */ }
}

/** 小坞挂载：挂到 <html>，并按「视觉视口」显式算 left/top（桌面端布局视口可能比可见区高，bottom 会飘出去）。 */
function mountDock(chip) {
  window.__dshCrawlerDock = chip
  chip.style.position = 'fixed'
  document.documentElement.append(chip)
  placeDock(chip)
}

function placeDock(chip) {
  try {
    const vv = window.visualViewport
    const w = vv ? vv.width : window.innerWidth
    const h = vv ? vv.height : window.innerHeight
    const ox = vv ? vv.offsetLeft : 0
    const oy = vv ? vv.offsetTop : 0
    const cw = chip.getBoundingClientRect().width || 90
    chip.style.right = 'auto'
    chip.style.bottom = 'auto'
    chip.style.left = Math.round(ox + w - 14 - cw) + 'px'
    chip.style.top = Math.round(oy + h - 14 - 24) + 'px'
  } catch (err) { /* ignore */ }
}

function createApp() {
  let disposed = false
  let started = false
  let spawning = false
  const cleanups = []
  const pets = []
  let anchors = []
  let infections = []
  let links = []
  let silks = []
  let crumbs = []
  let eatenWords = []
  let frames = []
  let eatenHighlights = []
  let highlightSeq = 0
  let highlightStyle = null
  let raf = 0
  let inkCtx = null
  let anchorsAt = 0
  let mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, at: -1e9, seen: false }
  let claimed = []
  let ink = null
  let inkDirty = false


  function makeInk() {
    ink = document.createElement('canvas')
    ink.dataset.crawlerUi = ''
    ink.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${Z_BASE + 1}`
    document.body.append(ink)
    resizeInk()
    inkCtx = ink.getContext('2d')
  }
  function resizeInk() {
    if (!ink) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    ink.width = Math.round(window.innerWidth * dpr)
    ink.height = Math.round(window.innerHeight * dpr)
    const ctx = ink.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function drawInk(t) {
    if (!inkCtx) return
    // 空闲时（没有框、词链、丝线、碎屑）不要每帧清一张全屏画布：
    // 上一帧有内容才需要再清一次，之后就一直跳过，直到又有东西要画。
    const busy = frames.length || eatenWords.length || links.length || silks.length || crumbs.length
    if (!busy && !inkDirty) return
    inkDirty = busy
    inkCtx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    frames = frames.filter((f) => t - f.at < (f.life || 1200))
    for (const f of frames) {
      const age = (t - f.at) / (f.life || 1200)
      const a = Math.max(0, 1 - age) ** 1.4
      const r = f.rect
      if (r.width < 2) continue
      const pad = 3
      const x = r.left - pad, y = r.top - pad, w = r.width + pad * 2, h = r.height + pad * 2
      inkCtx.save()
      inkCtx.globalAlpha = a * 0.9
      inkCtx.strokeStyle = f.color
      inkCtx.lineWidth = 1
      inkCtx.setLineDash([3, 3])
      inkCtx.beginPath()
      const rad = Math.min(6, h / 3)
      inkCtx.roundRect(x, y, w, h, rad)
      inkCtx.stroke()
      inkCtx.setLineDash([])
      // 四角小刻度，像标本框
      const tick = Math.min(7, w / 4, h / 3)
      inkCtx.beginPath()
      inkCtx.moveTo(x, y + tick); inkCtx.lineTo(x, y); inkCtx.lineTo(x + tick, y)
      inkCtx.moveTo(x + w - tick, y); inkCtx.lineTo(x + w, y); inkCtx.lineTo(x + w, y + tick)
      inkCtx.moveTo(x, y + h - tick); inkCtx.lineTo(x, y + h); inkCtx.lineTo(x + tick, y + h)
      inkCtx.moveTo(x + w - tick, y + h); inkCtx.lineTo(x + w, y + h); inkCtx.lineTo(x + w, y + h - tick)
      inkCtx.stroke()
      inkCtx.restore()
    }
    // 被吞掉的词：从原位飞向虫子，缩小消失
    eatenWords = eatenWords.filter((p2) => t - p2.at < 1000)
    for (const p2 of eatenWords) {
      const k = Math.min(1, (t - p2.at) / 1000)
      const e = 1 - (1 - k) ** 3
      const gx = p2.ghost ? p2.ghost.x : p2.x0
      const gy = p2.ghost ? p2.ghost.y : p2.y0
      const x = p2.x0 + (gx - p2.x0) * e
      const y = p2.y0 + (gy - p2.y0) * e - Math.sin(k * Math.PI) * 16
      inkCtx.save()
      inkCtx.globalAlpha = Math.max(0, 1 - k ** 2) * 0.95
      inkCtx.translate(x, y)
      inkCtx.rotate(p2.rot * e)
      inkCtx.font = `${Math.max(8, p2.size * (1 - 0.55 * e))}px ${p2.family}`
      inkCtx.fillStyle = p2.color
      inkCtx.textAlign = 'center'
      inkCtx.textBaseline = 'middle'
      inkCtx.fillText(p2.text, 0, 0)
      inkCtx.restore()
    }
    // 词链：从虫子牵到附近的词，随虫子移动重新生成
    links = links.filter((k) => t - k.at < 1200)
    for (const k of links) {
      const age = (t - k.at) / 1400
      const a = Math.max(0, 1 - age) ** 1.6
      inkCtx.save()
      inkCtx.globalAlpha = a * 0.5
      inkCtx.strokeStyle = k.color
      inkCtx.lineWidth = 0.8
      const mx = (k.x1 + k.x2) / 2 + (k.y2 - k.y1) * 0.08
      const my = (k.y1 + k.y2) / 2 - (k.x2 - k.x1) * 0.08
      inkCtx.beginPath()
      inkCtx.moveTo(k.x1, k.y1)
      inkCtx.quadraticCurveTo(mx, my, k.x2, k.y2)
      inkCtx.stroke()
      inkCtx.globalAlpha = a * 0.85
      inkCtx.fillStyle = k.color
      inkCtx.beginPath()
      inkCtx.arc(k.x2, k.y2, 1.7, 0, Math.PI * 2)
      inkCtx.fill()
      inkCtx.restore()
    }
    // 走过的丝线：慢慢淡出
    silks = silks.filter((k) => t - k.at < 9000)
    for (const k of silks) {
      const age = (t - k.at) / 9000
      inkCtx.save()
      inkCtx.globalAlpha = Math.max(0, 1 - age) ** 1.5 * 0.3
      inkCtx.strokeStyle = k.color
      inkCtx.lineWidth = 0.9
      inkCtx.beginPath()
      inkCtx.moveTo(k.x1, k.y1)
      inkCtx.lineTo(k.x2, k.y2)
      inkCtx.stroke()
      inkCtx.restore()
    }
    // 被吃掉的词变成小碎屑，飞向虫子
    crumbs = crumbs.filter((c) => t - c.at < 720)
    for (const c of crumbs) {
      const age = (t - c.at) / 720
      const e = 1 - (1 - age) ** 2
      const x = c.x0 + (c.x1 - c.x0) * e
      const y = c.y0 + (c.y1 - c.y0) * e
      inkCtx.save()
      inkCtx.globalAlpha = Math.max(0, 1 - age) * 0.9
      inkCtx.fillStyle = c.color
      inkCtx.beginPath()
      inkCtx.arc(x, y, Math.max(0.6, 2.4 * (1 - age)), 0, Math.PI * 2)
      inkCtx.fill()
      inkCtx.restore()
    }
  }

  let lastFrameAt = 0
  function loop() {
    if (disposed) return
    raf = requestAnimationFrame(loop)
    const t = now()
    if (t - lastFrameAt < 33) return
    lastFrameAt = t
    tickInfections(t)
    tickEaten(t)
    tickGrowth()
    drawInk(t)
  }

  const INK_COLORS = ['#67e8f9', '#a5b4fc', '#f9a8d4', '#fcd34d', '#86efac']

  function markAt(x, y, ghost) {
    const caret = caretRectAt(x, y)
    const t = now()
    // 框字是"标本框"点缀，不需要每次吃词都画：同一只虫 900ms 内只画一个
    const showBox = !ghost || !ghost.boxAt || t - ghost.boxAt > 900
    const color = (ghost && ghost.pet && ghost.pet.linkColor) || pick(INK_COLORS)
    if (caret) {
      if (showBox) {
        frames.push({ rect: caret.rect, at: t, color, life: 520 })
        if (frames.length > 24) frames.shift()
        if (ghost) ghost.boxAt = t
      }
      if (caret.word && cfg.eat) eat(caret.word, caret.rect, ghost, caret.el, caret.range)
      return
    }
    const box = elementBoxAt(x, y)
    if (box && showBox) {
      frames.push({ rect: box.rect, at: t, color, life: 520 })
      if (frames.length > 24) frames.shift()
      if (ghost) ghost.boxAt = t
    }
  }

  /** 吃词：只做视觉——飞到虫子身上的碎屑 + 可选的字形消失/飞走 */
  // —— 可选：把吃过的词拼成「伪维基条目」（默认关；打开后才积累词库/生成） ——
  const FILLER_WORDS = ['丝线', '触角', '苔藓', '夜行', '复眼', '静水', '洞穴', '蜕壳']
  const TEMPLATES = [
    (w) => '「' + w[0] + '」通常栖息在「' + w[1] + '」附近；若遇到「' + w[2] + '」，它会把丝线收紧。',
    (w) => '记录：' + w[0] + ' 与 ' + w[1] + ' 在 ' + w[2] + ' 处相遇，产下的卵呈 ' + w[3] + ' 状。',
    (w) => w[0] + ' 是 ' + w[1] + ' 的一种，以 ' + w[2] + ' 为食，靠 ' + w[3] + ' 辨认方向。',
    (w) => '沿 ' + w[0] + ' 向下三寸可以找到 ' + w[1] + '；再往 ' + w[2] + ' 走，就是 ' + w[3] + '。',
    (w) => '它把 ' + w[0] + '、' + w[1] + '、' + w[2] + ' 依次吞下，然后吐出一段新的 ' + w[3] + '。',
    (w) => '标本记录：' + w[0] + '／' + w[1] + '／' + w[2] + '；步态与 ' + w[3] + ' 一致，触角先动。',
  ]

  function pickWords(n) {
    const pool = [...lexicon.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map((e) => e[0])
    const out = []
    while (out.length < n) {
      if (pool.length) out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0])
      else out.push(pick(FILLER_WORDS))
    }
    return out
  }

  function showLoreNote(entry) {
    const box = document.createElement('div')
    box.dataset.crawlerUi = ''
    box.style.cssText = 'position:fixed;right:14px;bottom:64px;width:250px;z-index:' + (Z_BASE + 3) + ';background:rgba(10,14,20,.95);border:1px solid rgba(148,163,184,.3);border-radius:10px;padding:10px 12px;box-shadow:0 8px 28px rgba(0,0,0,.45);font:12px/1.65 ui-monospace,Consolas,monospace;color:#dbe4ee;cursor:pointer'
    const head = document.createElement('div')
    head.textContent = '🕸 新词条 · ' + (entry.name || 'crawler')
    head.style.cssText = 'font-size:10px;letter-spacing:.06em;color:#67e8f9;opacity:.75;margin-bottom:4px'
    const body = document.createElement('div')
    body.textContent = entry.text
    box.append(head, body)
    box.onclick = () => box.remove()
    document.documentElement.append(box)
    setTimeout(() => { try { box.remove() } catch (err) { /* ignore */ } }, 20000)
  }

  let loreTimer = 0
  function stopLoreCycle() { if (loreTimer) { try { clearTimeout(loreTimer) } catch (err) { /* ignore */ } loreTimer = 0 } }
  function startLoreCycle() {
    if (loreTimer || !cfg.lexicon) return
    const tick = () => {
      if (disposed) return
      loreTimer = 0
      if (!cfg.lexicon || !cfg.enabled) return
      if (lexicon.size >= 6) {
        try {
          const words = pickWords(4)
          const pet = pick(pets)
          lore.push({ text: pick(TEMPLATES)(words), at: Date.now(), words, name: pet && pet.seed ? pet.seed.name : 'crawler' })
          while (lore.length > LORE_MAX) lore.shift()
          persist(true)
          showLoreNote(lore[lore.length - 1])
        } catch (err) { /* ignore */ }
      }
      if (cfg.lexicon && cfg.enabled) loreTimer = setTimeout(tick, rnd(30000, 55000))
    }
    loreTimer = setTimeout(tick, rnd(10000, 18000))
  }

  // 计算样式缓存：WeakMap 不阻止元素回收；3 秒内复用同一元素的字体信息
  const styleCache = new WeakMap()
  function styleOf(el) {
    const root = el || document.body
    const t = now()
    const hit = styleCache.get(root)
    if (hit && t - hit.at < 3000) return hit
    let family = 'sans-serif'
    let color = '#e6edf5'
    let fontSize = 0
    try {
      const cs = window.getComputedStyle(root)
      if (cs.fontFamily) family = cs.fontFamily
      if (cs.color) color = cs.color
      const f = parseFloat(cs.fontSize)
      if (f > 0) fontSize = f
    } catch (err) { /* ignore */ }
    const rec = { family, color, fontSize, at: t }
    try { styleCache.set(root, rec) } catch (err) { /* ignore */ }
    return rec
  }

  function eat(word, rect, ghost, el, range) {
    const w = String(word || '').replace(/^[\s"'“”「」()（）·]+|[\s"'“”「」()（）·]+$/g, '')
    if (w.length < 2 || w.length > 6) return
    if (/^[\d\s.,;:!?()[\]{}<>/\\|@#$%^&*+=~`'"\-–—_]+$/.test(w)) return
    if (cfg.lexicon) {
      lexicon.set(w, (lexicon.get(w) || 0) + 1)
      if (lexicon.size > 400) { const k = lexicon.keys().next().value; lexicon.delete(k) }
      persist(false)
    }
    const pet = ghost && ghost.pet
    if (pet) {
      pet.eaten = (pet.eaten || 0) + 1
      maybeGrow(pet)
    }
    if (rect && ghost) {
      // 字体/颜色按元素缓存 3 秒：吃词很频繁，每次都 getComputedStyle 会反复触发布局
      const st = styleOf(el)
      const family = st.family
      const color = st.color
      let size = Math.min(rect.height * 0.92, 26)
      if (st.fontSize > 0) size = Math.min(st.fontSize, 26)
      if (cfg.eatWords && cfg.eat && range) { try { hideWord(range) } catch (err) { /* ignore */ } }
      if (cfg.textFx) {
        eatenWords.push({
          text: w,
          x0: rect.left + rect.width / 2,
          y0: rect.top + rect.height / 2,
          at: now(),
          ghost,
          family,
          color,
          size,
          rot: (Math.random() - 0.5) * 0.6,
        })
        if (eatenWords.length > 24) eatenWords.shift()
      }
      crumbs.push({
        x0: rect.left + rect.width / 2,
        y0: rect.top + rect.height / 2,
        x1: ghost.x,
        y1: ghost.y,
        at: now(),
        color: pick(INK_COLORS),
      })
    }
  }

  function makeGhost(pet) {
    const g = {
      x: rnd(window.innerWidth * 0.2, window.innerWidth * 0.8),
      y: rnd(window.innerHeight * 0.35, window.innerHeight * 0.7),
      tx: 0, ty: 0,
      dwellUntil: 0,
      speed: rnd(90, 150) * (cfg.speed || 1),
      base: rnd(90, 150),
      pet,
      markAt: 0,
      timer: 0,
    }
    g.tx = g.x; g.ty = g.y
    pickTarget(g, true)
    if (running) g.timer = setInterval(() => stepGhost(g), 90)
    return g
  }

  function pickTarget(g, anywhere) {
    if (now() - anchorsAt > 8000 || !anchors.length) {
      anchors = collectAnchors()
      anchorsAt = now()
    }
    if (!anchors.length) { g.tx = rnd(60, window.innerWidth - 60); g.ty = rnd(120, window.innerHeight - 80); return }
    let best = null
    let bestD = Infinity
    for (const a of anchors) {
      const d = Math.hypot(a.x - g.x, a.y - g.y)
      if (d < 50) continue
      // 别去光标附近——那是人在干活的地方（跟随模式除外）
      if (cfg.shy !== false && cfg.mode !== 'follow' && mouse.seen && Math.hypot(a.x - mouse.x, a.y - mouse.y) < SHY_RADIUS) continue
      if (!anywhere && d > 560) continue
      // 别和别的虫子抢同一处，否则三只会叠成一团
      if (claimed.some((c) => c !== g && Math.hypot(c.tx - a.x, c.ty - a.y) < 140)) continue
      const score = d + Math.random() * 220
      if (score < bestD) { bestD = score; best = a }
    }
    if (!best) best = pick(anchors)
    g.tx = best.x
    g.ty = best.y
    if (!claimed.includes(g)) claimed.push(g)
    if (DEBUG) {
      const log = window.__crawlerLog || (window.__crawlerLog = [])
      log.push({ ev: 'pick', from: [Math.round(g.x), Math.round(g.y)], to: [Math.round(g.tx), Math.round(g.ty)], anchors: anchors.length })
      if (log.length > 200) log.shift()
    }
  }

  // —— 吃字消失：CSS Custom Highlight API（不改 DOM、不改文本节点；只给一段 Range 挂样式再移除） ——
  function ensureHighlightStyle() {
    if (highlightStyle && highlightStyle.isConnected) return highlightStyle
    highlightStyle = document.createElement('style')
    highlightStyle.setAttribute('data-crawler-ui', '')
    document.head.append(highlightStyle)
    return highlightStyle
  }

  function syncHighlightCss() {
    const el = ensureHighlightStyle()
    el.textContent = eatenHighlights.map((h) => '::highlight(' + h.name + '){color:transparent}').join('\n')
  }

  function hideWord(range) {
    try {
      if (!range || typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
      const name = 'crawler-eat-' + (++highlightSeq)
      CSS.highlights.set(name, new Highlight(range))
      eatenHighlights.push({ name, at: now() })
      syncHighlightCss()
    } catch (err) { /* ignore */ }
  }

  function tickEaten(t) {
    if (!eatenHighlights.length) return
    const keep = []
    let changed = false
    for (const rec of eatenHighlights) {
      if (t - rec.at > 700) {
        try { CSS.highlights.delete(rec.name) } catch (err) { /* ignore */ }
        changed = true
      } else keep.push(rec)
    }
    if (changed) { eatenHighlights = keep; syncHighlightCss() }
  }

  function clearEatenHighlights() {
    for (const rec of eatenHighlights) { try { CSS.highlights.delete(rec.name) } catch (err) { /* ignore */ } }
    eatenHighlights = []
    try { if (highlightStyle) { highlightStyle.remove(); highlightStyle = null } } catch (err) { /* ignore */ }
  }

  // —— 感染层（只改视觉属性，不碰结构/className/事件；到期原样还原） ——
  function withAlpha(hex, alpha) {
    try {
      const n = parseInt(String(hex).replace('#', ''), 16)
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')'
    } catch (err) { return 'rgba(103,232,249,' + alpha + ')' }
  }

  function infectionAllowed(el) {
    if (!el || !el.isConnected) return false
    if (el.closest('[data-crawler-ui]')) return false
    if (el.closest('[role="dialog"]')) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
    if (el.isContentEditable) return false
    if (el.closest('[contenteditable="true"], form, [role="textbox"]')) return false
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 12 || r.width > 420 || r.height > 160) return false
    if (!(el.textContent || '').trim()) return false
    return true
  }

  const FX_STYLE_ID = 'crawler-fx'
  function ensureFxStyle() {
    let el = document.getElementById(FX_STYLE_ID)
    if (el && el.isConnected) return el
    el = document.createElement('style')
    el.id = FX_STYLE_ID
    el.setAttribute('data-crawler-ui', '')
    el.textContent = '@keyframes crawler-wobble{from{transform:rotate(-1.1deg)}to{transform:rotate(1.1deg)}}'
    document.head.append(el)
    return el
  }

  /** 按这只虫子自己的概率表抽一种效果（原作 settings 里的 color/size/background/border/rotation/oscillation/image/link 概率）。 */
  function pickEffect(pet, el) {
    const st = (pet && pet.seed && pet.seed.settings) || {}
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const isLink = el.tagName === 'A'
    const isImg = el.tagName === 'IMG'
    const entries = []
    const add = (k, w) => { if (w > 0) entries.push([k, w]) }
    add('color', num(st.color_probability, 0.5))
    add('size', num(st.size_probability, 0.5))
    add('bg', num(st.background_probability, 0.2))
    add('border', num(st.border_probability, 0.2))
    add('rotate', num(st.rotation_probability, 0.1))
    add('osc', num(st.oscillation_probability, 0.1))
    if (isLink) add('link', 0.6)
    if (isImg) add('filter', num(st.image_effect_probability, 1))
    if (!entries.length) return 'color'
    const total = entries.reduce((acc, e) => acc + e[1], 0)
    let r = Math.random() * total
    for (const e of entries) { r -= e[1]; if (r <= 0) return e[0] }
    return entries[0][0]
  }

  function applyInfection(el, pet) {
    if (!cfg.infect || infections.some((x) => x.el === el)) return
    const st = (pet && pet.seed && pet.seed.settings) || {}
    const color = (pet && pet.linkColor) || '#67e8f9'
    const before = {
      color: el.style.color,
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      filter: el.style.filter,
      backgroundColor: el.style.backgroundColor,
      transform: el.style.transform,
      animation: el.style.animation,
      fontFamily: el.style.fontFamily,
      fontSize: el.style.fontSize,
      border: el.style.border,
    }
    try {
      const kind0 = pickEffect(pet, el)
      // 安全阀：有子元素的容器不施加 filter/transform/animation——
      // 它们会创建包含块，可能让内部的 fixed/absolute 元素（弹层、工具栏）错位。
      const hasKids = (el.children && el.children.length > 0)
      const kind = (hasKids && (kind0 === 'filter' || kind0 === 'rotate' || kind0 === 'osc' || kind0 === 'link'))
        ? pick(['color', 'bg', 'border'])
        : kind0
      if (kind === 'color') {
        el.style.color = color
      } else if (kind === 'size') {
        const cs = window.getComputedStyle(el)
        const base = parseFloat(cs.fontSize) || 14
        const factor = rnd(0.85, 1.3)
        el.style.fontSize = Math.round(base * factor) + 'px'
      } else if (kind === 'bg') {
        el.style.backgroundColor = withAlpha(color, 0.14)
      } else if (kind === 'border') {
        el.style.outline = '1px solid ' + color
        el.style.outlineOffset = '2px'
      } else if (kind === 'rotate') {
        el.style.transform = 'rotate(' + rnd(-1.4, 1.4).toFixed(2) + 'deg)'
      } else if (kind === 'osc') {
        ensureFxStyle()
        el.style.animation = 'crawler-wobble ' + rnd(0.45, 0.75).toFixed(2) + 's ease-in-out infinite alternate'
      } else if (kind === 'filter') {
        const pool = Array.isArray(st.image_effects) && st.image_effects.length ? st.image_effects : ['grayscale(.6)', 'sepia(.5)', 'invert(.15)', 'hue-rotate(120deg)', 'saturate(1.8)', 'contrast(1.25)']
        el.style.filter = pick(pool)
      } else if (kind === 'link') {
        const fonts = Array.isArray(st.link_fonts) && st.link_fonts.length ? st.link_fonts : ['Georgia, serif']
        const cs2 = window.getComputedStyle(el)
        const baseSize = parseFloat(cs2.fontSize) || 14
        const lo = Number.isFinite(Number(st.link_scale_min)) ? Number(st.link_scale_min) : 0.8
        const hi = Number.isFinite(Number(st.link_scale_max)) ? Number(st.link_scale_max) : 1.4
        const scale = clamp(rnd(lo, hi), 0.6, 1.8)
        el.style.fontFamily = pick(fonts)
        el.style.fontSize = Math.max(9, Math.round(baseSize * scale)) + 'px'
        el.style.border = (st.link_border_width || '1px') + ' ' + (st.link_border_style || 'solid') + ' ' + withAlpha(color, 0.5)
      }
    } catch (err) { return }
    infections.push({
      el,
      before,
      at: now(),
      undo() { try { Object.assign(el.style, before) } catch (err) { /* ignore */ } },
    })
    if (infections.length > 14) { const old = infections.shift(); try { old.undo() } catch (err) { /* ignore */ } }
  }

  function tickInfections(t) {
    infections = infections.filter((rec) => {
      if (t - rec.at > 12000) { try { rec.undo() } catch (err) { /* ignore */ } return false }
      return true
    })
  }

  function clearInfections() {
    for (const rec of infections) { try { rec.undo() } catch (err) { /* ignore */ } }
    infections = []
    try { const el = document.getElementById(FX_STYLE_ID); if (el) el.remove() } catch (err) { /* ignore */ }
  }

  /** 虫子的真实屏幕坐标：小画布模式下世界坐标就是屏幕坐标（相机把画布挪到虫子上）。 */
  function spiderScreen(pet) {
    try {
      const sp = pet && pet.api && pet.api.spider
      if (!sp || !sp.position) return null
      const x = sp.position.x
      const y = sp.position.y
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return { x, y }
    } catch (err) { return null }
  }

  /** 词链：从虫子身上牵细线到附近的词，颜色用这只虫子自己的腿色。 */
  function spawnLinks(g, anchor) {
    try {
      const t0 = now()
      if (t0 - anchorsAt > 8000 || !anchors.length) { anchors = collectAnchors(); anchorsAt = t0 }
      const cands = []
      for (const a of anchors) {
        const d = Math.hypot(a.x - anchor.x, a.y - anchor.y)
        if (d < 46 || d > 230) continue
        cands.push({ a, d })
      }
      if (!cands.length) return
      cands.sort((p1, p2) => p1.d - p2.d)
      const take = cands.slice(0, 7)
      const want = Math.min(1, take.length)
      for (let i = 0; i < want; i++) {
        const one = take.splice((Math.random() * take.length) | 0, 1)[0]
        const caret = caretRectAt(one.a.x, one.a.y)
        const tx = caret ? caret.rect.left + caret.rect.width / 2 : one.a.x
        const ty = caret ? caret.rect.top + caret.rect.height / 2 : one.a.y
        links.push({ x1: anchor.x, y1: anchor.y, x2: tx, y2: ty, at: t0, color: g.pet.linkColor })
      }
      if (links.length > 80) links.splice(0, links.length - 80)
    } catch (err) { /* ignore */ }
  }

  function stepGhost(g) {
    if (typeof document !== 'undefined' && document.hidden) return
    if (disposed || !g.pet.api) return
    g.ticks = (g.ticks || 0) + 1
    const t = now()
    const follow = cfg.mode === 'follow' && mouse.seen
    if (follow) {
      // 跟着鼠标：偏一点，别把光标盖住
      g.tx = clamp(mouse.x + 26, 8, window.innerWidth - 8)
      g.ty = clamp(mouse.y + 22, 8, window.innerHeight - 8)
      g.dwellUntil = t + 200
      g.fleeing = false
      g.fleeSide = 0
    } else {
      // 躲鼠标：光标一靠近就主动走开，别挡在人正在读/点的字上（跟随模式除外）
      const anchor = spiderScreen(g.pet) || { x: g.x, y: g.y }
      const md = cfg.shy !== false && mouse.seen ? Math.hypot(mouse.x - anchor.x, mouse.y - anchor.y) : Infinity
      if (md < SHY_RADIUS) {
        // 光标正好压在虫子身上时 md→0，方向退化，这时候随便挑个方向跑
        const ux = md > 1 ? (anchor.x - mouse.x) / md : Math.cos((g.ticks || 0) * 2.4)
        const uy = md > 1 ? (anchor.y - mouse.y) / md : Math.sin((g.ticks || 0) * 2.4)
        const push = SHY_RADIUS * 2 - md
        let fx = clamp(anchor.x + ux * push, 30, window.innerWidth - 30)
        let fy = clamp(anchor.y + uy * push, 60, window.innerHeight - 40)
        if (Math.hypot(fx - mouse.x, fy - mouse.y) < SHY_RADIUS * 0.9) {
          // 被屏幕边缘夹住了（光标贴边/贴角）：改沿切线跑，左右方向一次定死，别来回抖
          if (!g.fleeSide) g.fleeSide = Math.random() < 0.5 ? 1 : -1
          fx = clamp(anchor.x - uy * g.fleeSide * push, 30, window.innerWidth - 30)
          fy = clamp(anchor.y + ux * g.fleeSide * push, 60, window.innerHeight - 40)
        }
        g.tx = fx
        g.ty = fy
        g.fleeing = true
        g.dwellUntil = t + 700
      } else {
        g.fleeing = false
        g.fleeSide = 0
        const dx = g.tx - g.x
        const dy = g.ty - g.y
        const d = Math.hypot(dx, dy)
        if (d < 8 && t > g.dwellUntil) {
          g.dwellUntil = t + rnd(450, 1700)
          pickTarget(g)
          if (Math.hypot(g.tx - g.x, g.ty - g.y) < 60) {
            // 兜底：全场都被别的虫子占了，就自己去一个随机远点
            g.tx = clamp(g.x + rnd(-420, 420), 40, window.innerWidth - 40)
            g.ty = clamp(g.y + rnd(-260, 260), 80, window.innerHeight - 40)
          }
        }
      }
    }
    const dx = g.tx - g.x
    const dy = g.ty - g.y
    const d = Math.hypot(dx, dy)
    if (d > 1) {
      const step = Math.min(d, g.speed * 0.09 * (g.fleeing ? 2.4 : 1))
      g.x += (dx / d) * step
      g.y += (dy / d) * step
    }
    if (cfg.silk) {
      const pet = g.pet
      if (!pet.silkLast) pet.silkLast = { x: g.x, y: g.y }
      const silkD = Math.hypot(g.x - pet.silkLast.x, g.y - pet.silkLast.y)
      if (silkD > 72) {
        silks.push({ x1: pet.silkLast.x, y1: pet.silkLast.y, x2: g.x, y2: g.y, at: t, color: pet.silkColor })
        pet.silkLast = { x: g.x, y: g.y }
        if (silks.length > 90) silks.shift()
      }
    }
    g.pet.steer(g.x, g.y)
    if (cfg.links && (g.ticks % 16) === 0) {
      const sp = spiderScreen(g.pet)
      if (sp) spawnLinks(g, sp)
    }
    if (cfg.infect && cfg.enabled && (g.ticks % 10) === 0) {
      const sp = spiderScreen(g.pet) || { x: g.x, y: g.y }
      const probes = [[0, 0], [18, 0], [-18, 0], [0, 18], [0, -18], [26, 26], [-26, -26]]
      for (const d of probes) {
        const el = document.elementFromPoint(sp.x + d[0], sp.y + d[1])
        const target = el && el.closest('button, a, [role="button"], li, p, h1, h2, h3, code, span')
        if (target && infectionAllowed(target)) { applyInfection(target, g.pet); break }
      }
    }
    if (t - g.markAt > 320) {
      g.markAt = t
      markAt(g.x, g.y, g)
    }
  }

  function createPet(seed, index, opts) {
    const canvas = document.createElement('canvas')
    // 每只虫一张画布：id 必须唯一，否则引擎的 #crawler-canvas 查询会命中第一张，
    // 三只引擎就都画到同一张上（互相覆盖、看起来只有一只、动作还同步）。
    canvas.id = 'crawler-canvas-' + index
    canvas.dataset.crawlerUi = ''
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${PET_W}px;height:${PET_H}px;pointer-events:none;background:transparent;z-index:${Z_BASE - 1};opacity:0;transition:opacity 900ms ease`
    const dataEl = document.createElement('script')
    dataEl.type = 'application/json'
    dataEl.id = 'crawler-data'
    dataEl.hidden = true
    const opt = opts || {}
    const sizeRange = SIZE_RANGE[cfg.size] || SIZE_RANGE.m
    const baseScale = opt.base || rnd(sizeRange[0], sizeRange[1])
    const maxScale = Math.max(baseScale, Number(seed.settings && seed.settings.scale) || baseScale)
    // 发育相位：让同批虫子不同步——开局落在生长曲线的随机位置（0~28%），每只生长速度再叠 ±18% 抖动。
    // 关掉「错开生长」时 phase=0、growthRate=1，行为与旧版完全一致。
    const staggered = cfg.stagger !== false
    const phase = opt.phase !== undefined ? Number(opt.phase) : (staggered && !opt.scale ? rnd(0, 0.28) : 0)
    const growthRate = opt.growthRate !== undefined ? Number(opt.growthRate) : (staggered ? rnd(0.82, 1.18) : 1)
    const startScale = opt.scale || Math.round(baseScale + (maxScale - baseScale) * Math.pow(phase, 0.85))
    dataEl.textContent = JSON.stringify(buildData(seed, startScale))
    document.body.append(canvas, dataEl)

    // 出生点：成虫在屏幕坐标里的位置（respawn 时沿用旧位置）
    const spawn = Array.isArray(opt.spawn) ? opt.spawn : null
    const spawnX = spawn ? Number(spawn[0]) : rnd(window.innerWidth * 0.12, window.innerWidth * 0.88)
    const spawnY = spawn ? Number(spawn[1]) : rnd(window.innerHeight * 0.18, window.innerHeight * 0.82)

    let api = null
    // 引擎按 id 找画布/数据脚本，这里把「这一次 eval 该用哪张」放进槽位（patch 见 build-client.cjs）
    window.__crawlerCanvasSlot = canvas
    window.__crawlerDataSlot = dataEl
    const __te = now()
    try {
      ;(0, eval)(engineText())
      api = window.__crawler_api || null
      window.__crawler_api = null
    } catch (err) {
      console.warn('[crawler] engine failed', err)
    } finally {
      perf('engine-eval', now() - __te)
      window.__crawlerCanvasSlot = null
      window.__crawlerDataSlot = null
    }
    // 引擎没接管这张画布（eval 失败）：清掉，交给 spawnPet 换一个形态重试。
    // 注意：画布尺寸要到引擎第一帧绘制时才设置（此前是 300×150 默认值），这里不能按尺寸判断。
    if (!api) {
      try { api && api.stop && api.stop() } catch (err) { /* ignore */ }
      try { canvas.remove() } catch (err) { /* ignore */ }
      try { dataEl.remove() } catch (err) { /* ignore */ }
      return null
    }
    // 把虫子的世界坐标挪到出生点，再把相机对准它（画布左上角 = 相机 = 出生点 - 半屏）
    try {
      if (api && api.spider && api.spider.position && typeof api.spider.shift === 'function') {
        api.spider.shift(spawnX - api.spider.position.x, spawnY - api.spider.position.y)
      }
    } catch (err) { /* ignore */ }
    try {
      if (api && api.camera) {
        api.camera.x = spawnX - PET_W / 2
        api.camera.y = spawnY - PET_H / 2
      }
      canvas.style.transform = 'translate3d(' + Math.round(spawnX - PET_W / 2) + 'px,' + Math.round(spawnY - PET_H / 2) + 'px,0)'
    } catch (err) { /* ignore */ }
    dataEl.id = `crawler-data-${index}`
    dataEl.remove()

    const pet = {
      index,
      seed,
      canvas,
      api,
      ghost: null,
      base: baseScale,
      max: maxScale,
      scale: startScale,
      eaten: Number(opt.eaten) || 0,
      respawns: Number(opt.respawns) || 0,
      phase,
      growthRate,
      bornAt: (() => Number(opt.bornAt) || Date.now())(),
      // 独立寿命：3–7 分钟随机到期（换体不重置年龄，否则会长的一直不老、同龄的一起死）
      dieAt: (() => Number(opt.dieAt) || (Number(opt.bornAt) || Date.now()) + rnd(180000, 420000))(),
      // 首次生长时钟随机错开，避免三只同拍换体（看起来像一起死亡/出生）
      lastGrow: opt.lastGrow !== undefined ? Number(opt.lastGrow) : (now() - rnd(0, 9000)),
      silkColor: pick(['#cbd5e1', '#a5b4fc', '#67e8f9', '#f9a8d4', '#fcd34d']),
      linkColor: (seed.settings && (seed.settings.leg_color || seed.settings.body_color)) || '#67e8f9',
      silkLast: null,
      steer(x, y) {
        if (!api) return
        try {
          // 小画布模式下 camera = 画布左上角的世界坐标；引擎把 clientX 当世界坐标的起点（world = clientX + camera），
          // 所以这里要减掉相机偏移，虫子的目标才落在屏幕坐标 (x, y) 上。
          const cam = api.camera || { x: 0, y: 0 }
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x - cam.x, clientY: y - cam.y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
        } catch (err) { /* ignore */ }
      },
      dispose() {
        try { api && api.stop && api.stop() } catch (err) { /* ignore */ }
        try { if (pet.ghost && pet.ghost.timer) { clearInterval(pet.ghost.timer); pet.ghost.timer = 0 } } catch (err) { /* ignore */ }
        try { canvas.width = 0; canvas.height = 0 } catch (err) { /* ignore */ }
        try { canvas.remove() } catch (err) { /* ignore */ }
        api = null
      },
    }
    // 给引擎帧里的相机钩子用：拿到这只虫的相机、画布、api
    try {
      if (api && api.camera) {
        api.camera.__pet = pet
        api.camera.__canvas = canvas
      }
    } catch (err) { /* ignore */ }
    requestAnimationFrame(() => { canvas.style.opacity = running ? '1' : '0' })
    try {
      canvas.dispatchEvent(new PointerEvent('pointerenter', { clientX: pet.canvas.clientWidth / 2, clientY: 10, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: pet.canvas.clientWidth / 2, clientY: 10, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    } catch (err) { /* ignore */ }
    pet.ghost = makeGhost(pet)
    try {
      pet.ghost.x = spawnX
      pet.ghost.y = spawnY
      pet.ghost.tx = spawnX
      pet.ghost.ty = spawnY
      pet.ghost.dwellUntil = now() + 600
    } catch (err) { /* ignore */ }
    if (!running) { try { pet.api && pet.api.set_active && pet.api.set_active(false) } catch (err) { /* ignore */ } }
    return pet
  }

  /** 建一只虫：引擎没接住画布时自动换形态重试（最多 3 次），并在 1.8s 后检查画布是否真的着墨。 */
  async function spawnPet(index, opts) {
    const reason = (opts && opts.reason) || 'spawn'
    // 非初始创建一律不能超过当前数量目标：避免「补员」和「初始创建」并发时多出一只再被裁掉
    if (reason !== 'start') {
      const cap = clamp(Number(cfg.count) || 3, 1, 5)
      if (pets.length >= cap) return null
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (disposed) return null
      const seed = await takeSeed()
      if (!seed) return null
      const pet = createPet(seed, index, opts)
      if (!pet) { perf('engine-retry', 0, attempt + 1); continue }
      perf('spawn', index, reason)
      scheduleBlankCheck(pet)
      return pet
    }
    return null
  }

  /** 一次性的空白画布诊断：只记录，不干预；有 value 时写进 window.__crawlerWarnings。 */
  function scheduleBlankCheck(pet) {
    setTimeout(() => {
      try {
        if (disposed || !pet.api || !pet.canvas) return
        const c = pet.canvas
        if (!c.width || !c.height) return
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) n++
        if (n > 0) return
        const w = window.__crawlerWarnings || (window.__crawlerWarnings = [])
        w.push({ ev: 'blank-canvas', id: c.id, w: c.width, h: c.height, at: Date.now() })
        if (w.length > 20) w.shift()
      } catch (err) { /* ignore */ }
    }, 1800)
  }

  function removePet(index, reason) {
    const i = pets.findIndex((p) => p.index === index)
    if (i < 0) return
    perf('remove', index, reason || 'remove')
    const [pet] = pets.splice(i, 1)
    claimed = claimed.filter((c) => c !== (pet.ghost || null))
    if (pet.ghost && pet.ghost.timer) { clearInterval(pet.ghost.timer); pet.ghost.timer = 0 }
    pet.canvas.style.opacity = '0'
    setTimeout(() => pet.dispose(), 900)
  }

  /** 吃得越多，体型越接近这个形态的原作默认大小（seed.settings.scale）。 */
  function maybeGrow(pet) {
    if (!pet || disposed) return
    const span = Math.max(0, pet.max - pet.base)
    if (span < 2) return
    const t = Math.min(1, ((pet.eaten || 0) / 150) * (pet.growthRate || 1) + (pet.phase || 0))
    const desired = Math.round(pet.base + span * Math.pow(t, 0.85))
    // 最后一步：就算只差 1–2，也让它长到真正的 max（否则会永远停在 max-1）
    if (desired - pet.scale < 3 && desired < pet.max) return
    if (now() - (pet.lastGrow || 0) < 9000) return
    if ((pet.respawns || 0) >= 64) return
    pet.lastGrow = now()
    pet.respawns = (pet.respawns || 0) + 1
    growTo(pet, desired)
  }

  /**
   * 长大 = 原地缩放同一个引擎实例（不重建）。
   * 以前是「新建一个更大的引擎 + 淡出旧的」：新引擎的朝向/腿相是初始姿态，
   * 所以画面里虫子正往前走时会突然「方向回正」——看起来像瞬移/变形。
   * 现在只改 spider.settings.scale，姿态、方向、腿部状态全部延续，再 shift 把头部钉回原位。
   */
  function growTo(pet, scale) {
    if (!pet || !pet.api || !pet.api.spider) return
    pet.scaleTarget = clamp(Number(scale) || pet.scale, 4, 200)
  }

  /** 每帧朝目标体型插值（30fps 下约 0.5–1 秒长大一档），看起来是「长大」而不是「跳变」。 */
  function tickGrowth() {
    for (const pet of pets) {
      const target = pet.scaleTarget
      if (!(target > 0)) continue
      const sp = pet.api && pet.api.spider
      if (!sp || !sp.settings) { pet.scaleTarget = 0; continue }
      const cur = Number(sp.settings.scale) || pet.scale
      const diff = target - cur
      const next = Math.abs(diff) < 0.8 ? target : cur + diff * 0.18
      const before = sp.position ? { x: sp.position.x, y: sp.position.y } : null
      sp.settings.scale = next
      try { sp.sync && sp.sync() } catch (err) { /* ignore */ }
      if (before && sp.position) {
        try { sp.shift(before.x - sp.position.x, before.y - sp.position.y) } catch (err) { /* ignore */ }
      }
      pet.scale = next
      if (next === target) pet.scaleTarget = 0
    }
  }

  async function start() {
    if (started || disposed) return
    started = true
    makeInk()
    // 形态数据在 Worker 里解析；这里逐只取，每只之间让出一帧，避免连续 eval 引擎卡住界面
    const target = clamp(Number(cfg.count) || 3, 1, 5)
    const __ts = now()
    spawning = true
    for (let i = 0; i < target; i++) {
      if (disposed) return
      const pet = await spawnPet(i, { reason: 'start' })
      if (!pet || disposed) return
      pets.push(pet)
      if (i < target - 1) await new Promise((r) => requestAnimationFrame(r))
    }
    spawning = false
    perf('start-pets', now() - __ts, target)
    raf = requestAnimationFrame(loop)
    // 把存档里的配置一次性落到刚建好的个体上（隐藏/数量/声音/速度）
    applyConfig()
    // 随机生死：每个个体有自己的「到期时间」（bornAt + 3–7 分钟随机寿命），
    // 不是所有人同一刻变老、同一刻死。缺员时按概率慢慢补位。
    const cycle = () => {
      if (disposed) return
      const t = setTimeout(() => {
        if (disposed) return
        if (cfg.birth && cfg.enabled) {
          const maxPets = clamp(Number(cfg.count) || 3, 1, 5)
          const nowMs = Date.now()
          const due = pets.filter((p) => nowMs >= (p.dieAt || Infinity))
          if (pets.length > maxPets) {
            removePet(pick(pets).index, 'trim')
          } else if (due.length) {
            removePet(due[0].index, 'death')
          } else if (pets.length < maxPets && Math.random() < 0.5) {
            // 随机繁殖：少了才补，不会死一只马上生一只
            const newIndex = (pets.reduce((m, p) => Math.max(m, p.index), 0) || 0) + 1
            spawnPet(newIndex, { reason: 'birth' }).then((pet) => {
              if (!pet || disposed || pets.length >= maxPets) return
              pets.push(pet)
            }).catch(() => { /* ignore */ })
          }
        }
        cycle()
      }, rnd(20000, 35000))
      cleanups.push(() => clearTimeout(t))
    }
    cycle()
    if (cfg.lexicon) startLoreCycle()
    cleanups.push(stopLoreCycle)
  }

  // 真实鼠标：它来追你（合成的 pointermove 会冒泡上来，必须过滤掉，否则三只会互相追）
  const onMove = (e) => { if (!e.isTrusted) return; mouse = { x: e.clientX, y: e.clientY, at: now(), seen: true } }
  window.addEventListener('pointermove', onMove, { passive: true })
  cleanups.push(() => window.removeEventListener('pointermove', onMove))
  const onResize = () => resizeInk()
  window.addEventListener('resize', onResize)
  cleanups.push(() => window.removeEventListener('resize', onResize))

  // 右下角爬虫坞：词数 + 设置 + 蜘蛛菜单，都从这一角展开
  const chip = document.createElement('div')
  chip.dataset.crawlerUi = ''
  chip.style.cssText = `position:fixed;right:14px;bottom:14px;z-index:${Z_BASE + 3};display:flex;align-items:center;gap:6px;font:11px/1.2 ui-monospace,Consolas,monospace;color:#9fb3c8`

  const iconBtn = (svg, title, size) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.title = title
    b.innerHTML = svg
    b.style.cssText = `display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;border:1px solid rgba(148,163,184,.45);background:rgba(10,14,20,.78);color:#a9b8c9;cursor:pointer;padding:0;opacity:.72;transition:opacity .2s`
    b.onmouseenter = () => { b.style.opacity = '.98' }
    b.onmouseleave = () => { b.style.opacity = '.72' }
    return b
  }
  const BUG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 8.9V5.2M12 15.1v3.7M8.9 12H5.2M15.1 12h3.7M9.7 9.7 7.1 7.1M14.3 9.7l2.6-2.6M9.7 14.3l-2.6 2.6M14.3 14.3l2.6 2.6"/></svg>'
  const SETTINGS_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>'


  const gearBtn = iconBtn(SETTINGS_SVG, '爬虫设置', 22)
  const btn = iconBtn(BUG_SVG, '爬虫菜单 · v' + BUILD_VER, 24)

  const menu = document.createElement('div')
  menu.style.cssText = 'display:none;position:absolute;right:0;bottom:36px;flex-direction:column;gap:2px;background:rgba(12,16,22,.94);border:1px solid rgba(148,163,184,.25);border-radius:9px;padding:4px;backdrop-filter:blur(6px)'

  const mkRow = (label, onClick) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.cssText = 'text-align:left;background:none;border:0;color:#cbd5e1;font:11px/1.4 ui-monospace,Consolas,monospace;padding:4px 8px;border-radius:5px;cursor:pointer;white-space:nowrap'
    b.onmouseenter = () => { b.style.background = 'rgba(148,163,184,.16)' }
    b.onmouseleave = () => { b.style.background = 'none' }
    b.onclick = (e) => { try { onClick(e) } finally { try { closeDockPanels() } catch (err) { /* ignore */ } } }
    return b
  }
  let running = true
  const modeRow = mkRow(cfg.mode === 'follow' ? '🎯 跟随鼠标' : '🧭 全自主探索', () => {
    setConfig({ mode: cfg.mode === 'follow' ? 'auto' : 'follow' })
  })
  const swapRow = mkRow('↻ 换一批形态', async () => {
    try {
      const idx = pets.map((p) => p.index)
      for (const i of idx) removePet(i, 'swap')
      await new Promise((r) => setTimeout(r, 800))
      if (disposed) return
      const n = Math.max(1, Number(cfg.count) || 3)
      for (let k = 0; k < n; k++) {
        if (disposed) return
        const pet = await spawnPet(k + 100 + k, { reason: 'swap' })
        if (!pet) break
        pets.push(pet)
      }
      applyConfig()
    } catch (err) { /* ignore */ }
  })
  /** 真正的暂停/继续：停步进定时器 + 用引擎自己的 set_active 暂停渲染（api.stop() 会关掉上下文，恢复不回来） */
  function setRunning(next) {
    running = !!next
    for (const p of pets) {
      try {
        p.canvas.style.opacity = running ? '1' : '0'
        const g = p.ghost
        if (g) {
          if (running) { if (!g.timer) g.timer = setInterval(() => stepGhost(g), 90) }
          else if (g.timer) { clearInterval(g.timer); g.timer = 0 }
        }
        if (p.api && typeof p.api.set_active === 'function') p.api.set_active(running)
        else if (!running && p.api && p.api.stop) p.api.stop()
      } catch (err) { /* ignore */ }
    }
  }

  const pauseRow = mkRow('‖ 暂停爬行', () => {
    setRunning(!running)
    pauseRow.textContent = running ? '‖ 暂停爬行' : '▶ 继续爬行'
  })
  menu.append(modeRow, swapRow, pauseRow)

  // —— 设置面板（右下角展开） ——
  const settings = document.createElement('div')
  settings.dataset.crawlerUi = ''
  settings.style.cssText = 'display:none;position:absolute;right:0;bottom:36px;width:292px;max-height:min(72vh,560px);overflow:auto;background:rgba(10,14,20,.96);border:1px solid rgba(148,163,184,.28);border-radius:12px;padding:12px 14px;backdrop-filter:blur(8px);box-shadow:0 12px 40px rgba(0,0,0,.45);color:#dbe4ee'

  const rowEl = (label, control, hint) => {
    const r = document.createElement('div')
    r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.14)'
    const l = document.createElement('div')
    l.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0'
    const t = document.createElement('div')
    t.textContent = label
    t.style.cssText = 'font-size:12px;color:#dbe4ee'
    l.append(t)
    if (hint) {
      const h = document.createElement('div')
      h.textContent = hint
      h.style.cssText = 'font-size:10px;color:#8b98a8;line-height:1.5'
      l.append(h)
    }
    r.append(l, control)
    return r
  }
  const segEl = (options, value, onPick) => {
    const w = document.createElement('div')
    w.style.cssText = 'display:flex;gap:2px;padding:2px;background:rgba(148,163,184,.12);border-radius:7px;flex-shrink:0'
    for (const [v, text] of options) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      const active = v === value
      b.style.cssText = `padding:4px 9px;border:0;border-radius:5px;cursor:pointer;font:11px/1.2 ui-monospace,Consolas,monospace;background:${active ? 'rgba(103,232,249,.18)' : 'transparent'};color:${active ? '#67e8f9' : '#cbd5e1'}`
      b.onclick = () => onPick(v)
      w.append(b)
    }
    return w
  }
  const checkEl = (on, onChange) => {
    const i = document.createElement('input')
    i.type = 'checkbox'
    i.checked = !!on
    i.style.cssText = 'width:15px;height:15px;accent-color:#67e8f9;cursor:pointer;flex-shrink:0'
    i.onchange = () => onChange(i.checked)
    return i
  }
  const btnEl = (text, onClick) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    b.style.cssText = 'background:rgba(148,163,184,.14);border:1px solid rgba(148,163,184,.22);color:inherit;padding:3px 9px;border-radius:6px;cursor:pointer;font:11px/1.4 ui-monospace,Consolas,monospace'
    b.onclick = onClick
    return b
  }

  function renderSettings() {
    settings.innerHTML = ''
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px'
    const title = document.createElement('div')
    title.textContent = '爬虫设置'
    title.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:.04em;color:#e6edf5'
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '×'
    close.style.cssText = 'background:none;border:0;color:#8b98a8;font-size:16px;line-height:1;cursor:pointer;padding:0 2px'
    close.onclick = () => { settings.style.display = 'none' }
    head.append(title, close)
    settings.append(head)

    settings.append(rowEl('显示爬虫', checkEl(cfg.enabled, (v) => setConfig({ enabled: v }))))
    settings.append(rowEl('行为模式', segEl([['auto', '全自主探索'], ['follow', '跟随鼠标']], cfg.mode, (v) => setConfig({ mode: v })),
      cfg.mode === 'follow' ? '跟着光标走，停在光标右下方' : '自己决定去哪，只在文字和按钮间巡游'))
    settings.append(rowEl('数量', segEl([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], String(cfg.count), (v) => setConfig({ count: Number(v) }))))
    settings.append(rowEl('体型', segEl([['s', '小'], ['m', '中'], ['l', '大']], cfg.size, (v) => setConfig({ size: v })), '之后出生的个体生效'))

    const speedWrap = document.createElement('div')
    speedWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0'
    const speed = document.createElement('input')
    speed.type = 'range'
    speed.min = '0.5'
    speed.max = '2'
    speed.step = '0.1'
    speed.value = String(cfg.speed)
    speed.style.cssText = 'width:110px;accent-color:#67e8f9'
    const speedVal = document.createElement('span')
    speedVal.textContent = `${Number(cfg.speed).toFixed(1)}×`
    speedVal.style.cssText = 'font-size:10px;opacity:.7;width:30px'
    speed.oninput = () => { speedVal.textContent = `${Number(speed.value).toFixed(1)}×`; setConfig({ speed: Number(speed.value) }) }
    speedWrap.append(speed, speedVal)
    settings.append(rowEl('速度', speedWrap))

    settings.append(rowEl('吃掉文字里的词', checkEl(cfg.eat, (v) => setConfig({ eat: v })), '吃掉词只做视觉（不存词库/不生成词条）'))
    settings.append(rowEl('词链', checkEl(cfg.links, (v) => setConfig({ links: v })), '从虫子身上牵细线到附近的词，用这只虫子自己的颜色'))
    settings.append(rowEl('吃字消失', checkEl(cfg.eatWords, (v) => setConfig({ eatWords: v })), '被吃掉的词在页面上渐隐 0.7 秒再回来（CSS 高亮，不改 DOM/文本）'))
    settings.append(rowEl('感染界面', checkEl(cfg.infect, (v) => setConfig({ infect: v })), '爬过的元素染色/描边/滤镜/摆动，12 秒后原样还原（只改内联视觉属性）'))
    settings.append(rowEl('吃字特效', checkEl(cfg.textFx, (v) => setConfig({ textFx: v })), '被吃掉的词从原位飞向虫子、缩小消失'))
    settings.append(rowEl('词条生成', checkEl(cfg.lexicon, (v) => setConfig({ lexicon: v })), '吃过的词攒成词库，每 30–55 秒拼一条伪维基条目（默认关）'))
    settings.append(rowEl('随机繁殖 / 死亡', checkEl(cfg.birth, (v) => setConfig({ birth: v })), '随机生出新形态，也随机有一只退场'))
    settings.append(rowEl('躲鼠标', checkEl(cfg.shy !== false, (v) => setConfig({ shy: v })), '光标靠近时虫子主动走开，不挡着你干活（只在全自主探索时）'))
    settings.append(rowEl('错开生长', checkEl(cfg.stagger !== false, (v) => setConfig({ stagger: v })), '开局随机相位 + 每只生长速度抖动；关掉则同批虫子一起长大'))
    settings.append(rowEl('织丝', checkEl(cfg.silk, (v) => setConfig({ silk: v })), '沿路留下丝线，9 秒内淡出'))
    settings.append(rowEl('声音', checkEl(cfg.sound, (v) => setConfig({ sound: v })), '每只虫子自带一套音色'))

    const verLine = document.createElement('div')
    verLine.textContent = '爬虫 v' + BUILD_VER + ' · build ' + String(BUILD_TAG).slice(-6)
    verLine.style.cssText = 'font-size:10px;color:#6b7a8c;text-align:right;padding-top:8px'
    settings.append(verLine)

  }

  function toggleSettings() {
    if (settings.style.display !== 'none') { settings.style.display = 'none'; return }
    menu.style.display = 'none'
    renderSettings()
    settings.style.display = 'block'
  }

  chip.append(gearBtn, btn, menu, settings)
  mountDock(chip)
  // 不再每秒轮询一次小坞位置（每秒一次 getBoundingClientRect）：挂载后自检一次，
  // 之后只在窗口 / 可视视口真的变化时重排。
  const settleDock = setTimeout(() => { try { placeDock() } catch (err) { /* ignore */ } }, 350)
  cleanups.push(() => clearTimeout(settleDock))
  const onViewportResize = () => { try { placeDock() } catch (err) { /* ignore */ } }
  try { window.visualViewport && window.visualViewport.addEventListener('resize', onViewportResize) } catch (err) { /* ignore */ }
  cleanups.push(() => { try { window.visualViewport && window.visualViewport.removeEventListener('resize', onViewportResize) } catch (err) { /* ignore */ } })
  // 点别处 / 按 Esc 时收起菜单和设置面板
  const closeDockPanels = () => {
    try { menu.style.display = 'none' } catch (err) { /* ignore */ }
    try { settings.style.display = 'none' } catch (err) { /* ignore */ }
  }
  const onDocPointerDown = (e) => {
    try {
      if (!chip.contains(e.target)) closeDockPanels()
    } catch (err) { /* ignore */ }
  }
  document.addEventListener('pointerdown', onDocPointerDown, true)
  cleanups.push(() => document.removeEventListener('pointerdown', onDocPointerDown, true))
  const onDocKey = (e) => { if (e && e.key === 'Escape') closeDockPanels() }
  document.addEventListener('keydown', onDocKey)
  cleanups.push(() => document.removeEventListener('keydown', onDocKey))

  btn.onclick = () => {
    const open = menu.style.display !== 'none'
    menu.style.display = open ? 'none' : 'flex'
    if (!open) settings.style.display = 'none'
  }
  gearBtn.onclick = () => { toggleSettings() }
  cleanups.push(() => chip.remove())
  /** 有些皮肤会 transform/zoom body，fixed 的 right/bottom 会跟着飘；自检一次，飘了就改 left/top。 */
  function placeDock() {
    if (!chip) return
    requestAnimationFrame(() => {
      try {
        const r = chip.getBoundingClientRect()
        if (r.bottom > window.innerHeight + 2 || r.top > window.innerHeight || r.right > window.innerWidth + 2) {
          chip.style.right = 'auto'
          chip.style.bottom = 'auto'
          chip.style.left = Math.max(0, window.innerWidth - 98) + 'px'
          chip.style.top = Math.max(0, window.innerHeight - 38) + 'px'
        }
      } catch (err) { /* ignore */ }
    })
  }
  placeDock()
  cleanups.push(() => window.removeEventListener('resize', placeDock))
  window.addEventListener('resize', placeDock)


  cleanups.push(subscribe(() => {
    modeRow.textContent = cfg.mode === 'follow' ? '🎯 跟随鼠标' : '🧭 全自主探索'
    if (settings.style.display !== 'none') renderSettings()
  }))


  if (DEBUG) {
    window.__dshCrawler = {
      get pets() {
        return pets.map((p) => ({
          ghost: p.ghost ? { x: Math.round(p.ghost.x), y: Math.round(p.ghost.y), tx: Math.round(p.ghost.tx), ty: Math.round(p.ghost.ty), ticks: p.ghost.ticks || 0 } : null,
          pos: p.api && p.api.spider ? p.api.spider.position : null,
          canvas: p.canvas && p.canvas.id,
          dir: p.api && p.api.spider ? p.api.spider.direction : null,
          speed: p.api && p.api.spider ? p.api.spider.current_speed : null,
          cam: p.api ? p.api.camera : null,
          mode: p.seed && p.seed.mode,
          name: p.seed && p.seed.name,
          scale: p.scale && Math.round(p.scale),
          bornAt: p.bornAt, dieAt: p.dieAt,
          base: p.base && Math.round(p.base),
          max: p.max && Math.round(p.max),
          eaten: p.eaten || 0,
          settingsScale: p.seed && p.seed.settings && Math.round(p.seed.settings.scale || 0),
        }))
      },
      eat: (w) => eat(w, null, null),
      liveScale: (i, v) => { const p = pets[i]; if (!p || !p.api || !p.api.spider) return 'no'; const sp = p.api.spider; const b = { x: sp.position.x, y: sp.position.y }; sp.settings.scale = clamp(Number(v) || 90, 4, 200); try { sp.sync && sp.sync() } catch (e) {} try { sp.shift(b.x - sp.position.x, b.y - sp.position.y) } catch (e) {} p.scale = sp.settings.scale; return JSON.stringify({ scale: sp.settings.scale, pos: [Math.round(sp.position.x), Math.round(sp.position.y)], was: [Math.round(b.x), Math.round(b.y)], keys: Object.keys(sp), stateKeys: sp.state ? Object.keys(sp.state) : null }) },
      // 调试：把第 i 只直接长到某个 scale（用来验证最大体型 / 画布是否裁切）
      setScale: (i, v) => { const p = pets[i]; if (p) growTo(p, clamp(Number(v) || 90, 4, 200)) },
    }
    const d = document.createElement('div')
    d.dataset.crawlerUi = ''
    d.id = 'crawler-debug'
    d.style.cssText = `position:fixed;left:14px;top:14px;z-index:${Z_BASE + 4};font:10px/1.4 ui-monospace,monospace;color:#67e8f9;background:rgba(0,0,0,.6);padding:3px 6px;border-radius:4px;pointer-events:none`
    document.body.append(d)
    cleanups.push(() => d.remove())
    const dbgTimer = setInterval(() => {
      const p = pets[0]
      d.textContent = p && p.api && p.api.spider
        ? `pets=${pets.length} x=${p.api.spider.position?.x?.toFixed(0)} y=${p.api.spider.position?.y?.toFixed(0)} spd=${p.api.spider.current_speed?.toFixed(1)}`
        : `pets=${pets.length} loading`
    }, 300)
    cleanups.push(() => clearInterval(dbgTimer))
  }

  // 设置面板改动 → 实时生效
  function applyConfig() {
    if (chip) chip.style.display = cfg.enabled ? 'flex' : 'none'
    if (ink) ink.style.display = cfg.enabled ? 'block' : 'none'
    if (cfg.enabled && cfg.lexicon) startLoreCycle()
    else stopLoreCycle()
    if (!cfg.enabled || !cfg.infect) clearInfections()
    if (!cfg.enabled || !cfg.eatWords) clearEatenHighlights()
    for (const p of pets) {
      p.canvas.style.display = cfg.enabled ? 'block' : 'none'
      if (p.ghost) p.ghost.speed = (p.ghost.base || 120) * (cfg.speed || 1)
      try {
        if (p.api && p.api.sound_enabled && p.api.sound_enabled() !== !!cfg.sound) p.api.toggle_sound()
        if (p.api && typeof p.api.set_active === 'function') p.api.set_active(!!cfg.enabled && running)
      } catch (err) { /* ignore */ }
    }
    if (!started || disposed || !cfg.enabled) return
    if (spawning) return
    const target = clamp(Number(cfg.count) || 3, 1, 5)
    while (pets.length > target) removePet(pets[pets.length - 1].index, 'trim')
    if (pets.length < target) {
      // 一次补齐到目标数量（以前每次配置变更只补 1 只，1→5 只会变成 2）
      const deficit = target - pets.length
      ;(async () => {
        for (let k = 0; k < deficit; k++) {
          if (disposed || pets.length >= target) break
          const idx = (pets.reduce((m, p) => Math.max(m, p.index), 0) || 0) + 1
          const np = await spawnPet(idx, { reason: 'topup' })
          if (!np) break
          pets.push(np)
        }
      })().catch(() => { /* ignore */ })
    }
  }
  cleanups.push(subscribe(applyConfig))


  // 启动失败时把原因挂到全局，方便在页面里取（不影响正常路径）
  try {
    const p = start()
    if (p && typeof p.catch === 'function') p.catch((err) => { window.__crawlerLastError = String((err && err.stack) || err) })
  } catch (err) {
    window.__crawlerLastError = String((err && err.stack) || err)
  }

  return {
    dispose() {
      disposed = true
      const __td = now()
      cancelAnimationFrame(raf)
      for (const c of cleanups) { try { c() } catch (err) { /* ignore */ } }
      for (const p of pets) { if (p.ghost && p.ghost.timer) clearInterval(p.ghost.timer); p.dispose() }
      pets.length = 0
      persist(true)
      clearInfections()
      clearEatenHighlights()
      if (ink) ink.remove()
      ink = null
      perf('dispose', now() - __td, pets.length)
      inkCtx = null
    },
  }
}

// —— 设置页里的「爬虫」面板 ——
// 页内小坞可能被关掉 / 被别的东西挡住，所以全局开关必须有第二个入口：设置 → 爬虫。
// 这里只做纯 DOM（不引任何 UI 依赖），改值走 writeCrawlerConfig，overlay 活着时实时生效。
function buildSettingsNodes(cfg, onChange) {
  const nodes = []
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;flex-direction:column;gap:0;font:12px/1.7 ui-monospace,Consolas,monospace;color:inherit;min-width:0'

  const row = (label, control, hint) => {
    const el = document.createElement('div')
    el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.16)'
    const left = document.createElement('div')
    left.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0'
    const l = document.createElement('div')
    l.textContent = label
    left.append(l)
    if (hint) {
      const h = document.createElement('div')
      h.textContent = hint
      h.style.cssText = 'font-size:10px;color:#8b98a8;line-height:1.5'
      left.append(h)
    }
    el.append(left, control)
    return el
  }
  const check = (on, cb) => {
    const i = document.createElement('input')
    i.type = 'checkbox'
    i.checked = !!on
    i.style.cssText = 'width:16px;height:16px;accent-color:#67e8f9;cursor:pointer;flex-shrink:0'
    i.onchange = () => cb(i.checked)
    return i
  }
  const seg = (opts, value, cb) => {
    const w = document.createElement('div')
    w.style.cssText = 'display:flex;gap:4px;flex-shrink:0'
    for (const [v, label] of opts) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      const active = String(v) === String(value)
      b.style.cssText = 'padding:3px 9px;border-radius:6px;border:1px solid rgba(148,163,184,.3);background:' +
        (active ? 'rgba(103,232,249,.18)' : 'transparent') + ';color:inherit;cursor:pointer;font:inherit'
      b.onclick = () => cb(v)
      w.append(b)
    }
    return w
  }

  const head = document.createElement('div')
  head.textContent = '爬虫'
  head.style.cssText = 'font-size:13px;letter-spacing:.04em;margin:2px 0 6px'
  const sub = document.createElement('div')
  sub.textContent = '在界面文字之间爬行、吃词、织丝、感染元素——纯视觉，不存任何词库/词条。关掉后小坞和虫子一起隐藏。'
  sub.style.cssText = 'font-size:10px;color:#8b98a8;line-height:1.6;margin-bottom:8px'

  box.append(
    head,
    sub,
    row('显示爬虫', check(cfg.enabled !== false, (v) => onChange({ enabled: v })), '全局开关；关掉后界面右下角的小坞也会消失'),
    row('数量', seg([[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], cfg.count, (v) => onChange({ count: Number(v) })), '1–5 只，虫口会在设定值附近漂移'),
    row('行为模式', seg([['auto', '全自主探索'], ['follow', '跟随鼠标']], cfg.mode, (v) => onChange({ mode: v })), '全自主会到处巡游；跟随会停在你光标右下方'),
    row('躲鼠标', check(cfg.shy !== false, (v) => onChange({ shy: v })), '光标靠近时虫子主动走开（只在全自主探索时）'),
    row('错开生长', check(cfg.stagger !== false, (v) => onChange({ stagger: v })), '开局随机相位 + 个体生长速度抖动，避免同批同步长大'),
    row('声音', check(!!cfg.sound, (v) => onChange({ sound: v })), '每只虫子自带一套音色'),
  )


  const speedRow = (() => {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0'
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0.5'
    range.max = '2'
    range.step = '0.1'
    range.value = String(cfg.speed != null ? cfg.speed : 1)
    range.style.cssText = 'width:120px;accent-color:#67e8f9'
    const val = document.createElement('span')
    val.textContent = Number(range.value).toFixed(1) + '×'
    val.style.cssText = 'font-size:10px;opacity:.7;width:30px'
    range.oninput = () => { val.textContent = Number(range.value).toFixed(1) + '×'; onChange({ speed: Number(range.value) }) }
    wrap.append(range, val)
    return wrap
  })()
  box.append(
    row('体型', seg([['s', '小'], ['m', '中'], ['l', '大']], cfg.size, (v) => onChange({ size: v })), '之后出生的个体生效'),
    row('速度', speedRow),
    row('吃字特效', check(cfg.textFx !== false, (v) => onChange({ textFx: v })), '被吃掉的词从原位飞向虫子、缩小消失'),
    row('词条生成', check(!!cfg.lexicon, (v) => onChange({ lexicon: v })), '吃过的词攒成词库，每 30–55 秒拼一条伪维基条目（默认关）'),
    row('词链', check(cfg.links !== false, (v) => onChange({ links: v })), '从虫子身上牵细线到附近的词，用它自己的颜色'),
    row('吃字消失', check(!!cfg.eatWords, (v) => onChange({ eatWords: v })), '被吃掉的词在页面上渐隐 0.7 秒再回来（CSS 高亮，不改 DOM/文本）'),
    row('感染界面', check(!!cfg.infect, (v) => onChange({ infect: v })), '爬过的元素染色/描边/滤镜/摆动，12 秒后原样还原'),
    row('织丝', check(cfg.silk !== false, (v) => onChange({ silk: v })), '沿路留下丝线，9 秒内淡出'),
  )
  if (cfg.lexicon) {
    const loreBox = document.createElement('div')
    loreBox.style.cssText = 'padding:9px 0;border-bottom:1px solid rgba(148,163,184,.16);font-size:11px;line-height:1.7;color:#9fb3c8'
    const title = document.createElement('div')
    title.textContent = '词条：' + lore.length + ' 条（最多 ' + LORE_MAX + '，保留 24 小时）'
    loreBox.append(title)
    for (const e of lore.slice(-3).reverse()) {
      const line = document.createElement('div')
      line.textContent = e.text
      line.style.cssText = 'padding:4px 0;border-top:1px solid rgba(148,163,184,.1)'
      loreBox.append(line)
    }
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.textContent = '清空词条'
    clear.style.cssText = 'margin-top:6px;background:rgba(148,163,184,.14);border:1px solid rgba(148,163,184,.22);color:inherit;padding:3px 9px;border-radius:6px;cursor:pointer;font:inherit'
    clear.onclick = () => { lexicon.clear(); lore = []; persist(true); onChange({}) }
    loreBox.append(clear)
    box.append(loreBox)
  }
  const foot = document.createElement('div')
  foot.textContent = '这里和页面右下角的小坞是同一份配置；任何一边改动都会同步。'
  const verLine = document.createElement('div')
  verLine.textContent = '爬虫 v' + BUILD_VER + ' · build ' + String(BUILD_TAG).slice(-6)
  verLine.style.cssText = 'font-size:10px;color:#6b7a8c;margin-top:6px'
  box.append(verLine)
  foot.style.cssText = 'font-size:10px;color:#8b98a8;line-height:1.6;margin-top:10px'
  box.append(foot)

  nodes.push(box)
  return nodes
}

function registerSettingsSection(ctx) {
  let React = null
  try { React = require('react') } catch (err) { React = null }
  if (!React || !ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
    console.warn('[crawler] 设置页不可用（缺少 react 或 slots 服务），跳过注册')
    return
  }

  function CrawlerSettingsSection() {
    const [snap, setSnap] = React.useState(() => readCrawlerConfig())
    const boxRef = React.useRef(null)
    // 与页内小坞双向同步：可以来自 ctl.subscribe，也可以靠 800ms 轮询兜底（overlay 换代后旧的订阅会失效）
    React.useEffect(() => {
      const pull = () => {
        const next = readCrawlerConfig()
        setSnap((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      }
      pull()
      const id = setInterval(pull, 800)
      let off = null
      try {
        const ctl = window.__dshCrawlerCtl
        if (ctl && typeof ctl.subscribe === 'function') off = ctl.subscribe(pull)
      } catch (err) { /* ignore */ }
      return () => { clearInterval(id); try { off && off() } catch (err) { /* ignore */ } }
    }, [])
    React.useEffect(() => {
      const node = boxRef.current
      if (!node) return
      node.textContent = ''
      for (const el of buildSettingsNodes(snap, (patch) => setSnap(writeCrawlerConfig(patch)))) node.append(el)
    }, [snap])
    return React.createElement('div', { ref: boxRef })
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-crawler', order: 520, label: () => '爬虫' },
    () => React.createElement(CrawlerSettingsSection),
  )), '@dsh-external/dsh-crawler: settings section')
}

/** 启动 overlay（可反复调用）：先停上一代（防引擎泄漏/OOM），再建新一代。 */
function startOverlay() {
  try {
    const prev = window.__dshCrawlerApp
    if (prev && typeof prev.dispose === 'function') prev.dispose()
  } catch (err) { /* ignore */ }
  window.__dshCrawlerApp = null
  sweepLegacy()
  const app = createApp()
  window.__dshCrawlerApp = app
  return () => {
    try { app.dispose() } catch (err) { /* ignore */ }
    if (window.__dshCrawlerApp === app) window.__dshCrawlerApp = null
  }
}
// 供 live.js 热替换用
try {
  window.__dshCrawlerHotStart = () => {
    try { overlayStop && overlayStop() } catch (err) { /* ignore */ }
    overlayStop = null
    if (cfg.enabled) { try { overlayStop = startOverlay() } catch (err) { console.warn('[crawler] hot start failed', err) } }
  }
} catch (err) { /* ignore */ }

/**
 * 自更新：每 2 秒拉一次 host 的 /dev/rev，构建号变了就加载 live.js 并热替换 overlay。
 * 不重启、不刷新页面；不动模块图（模块图那条路在桌面端不生效）。
 */
function startHotPoll() {
  if (startHotPoll.started) return
  startHotPoll.started = true
  // 热更新/重复 apply 时，上一代模块的轮询不会自己停：用全局句柄清掉
  try { if (window.__dshCrawlerPollTimer) { clearTimeout(window.__dshCrawlerPollTimer); window.__dshCrawlerPollTimer = 0 } } catch (err) { /* ignore */ }
  let busy = false
  let lastHotAt = 0
  let misses = 0
  let delay = 2000
  let timer = 0
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => { timer = 0; tick() }, delay)
    try { window.__dshCrawlerPollTimer = timer } catch (err) { /* ignore */ }
  }
  const backoff = () => {
    misses++
    // 正式包里没有 /dev/rev：退避到 60s 一次，而不是彻底停掉——
    // 之前一旦连续失败 5 次就永久停，页面就再也收不到热更新了。
    delay = Math.min(60000, 2000 * Math.pow(2, Math.min(misses, 5)))
  }
  const tick = async () => {
    if (busy) { schedule(); return }
    try {
      const res = await fetch('/@dsh-external/dsh-crawler/dev/rev', { cache: 'no-store' })
      if (!res.ok) { backoff(); schedule(); return }
      misses = 0
      delay = 2000
      const info = await res.json()
      const rev = info && info.rev ? String(info.rev) : ''
      const norm = (v) => String(v == null ? '' : v).replace(/[\"']/g, '')
      if (!rev) { backoff(); schedule(); return } // 正式包没有 rev：退避，别 2 秒空转
      if (norm(rev) === norm(window.__dshCrawlerRev)) { schedule(); return }
      busy = true
      const script = document.createElement('script')
      script.src = '/@dsh-external/dsh-crawler/dev/live.js?v=' + encodeURIComponent(rev)
      script.async = true
      script.onload = () => {
        const norm = (v) => String(v == null ? '' : v).replace(/["']/g, '')
        if (norm(window.__dshCrawlerRev) !== norm(rev)) {
          console.warn('[crawler] live bundle did not register its rev; backing off 30s')
          setTimeout(() => { busy = false }, 30000)
          return
        }
        const nowTs = Date.now()
        if (nowTs - lastHotAt < 10000) { busy = false; return }
        lastHotAt = nowTs
        try {
          if (typeof window.__dshCrawlerHotStart === 'function') window.__dshCrawlerHotStart()
        } catch (err) { console.warn('[crawler] hot apply failed', err) }
        busy = false
      }
      script.onerror = () => { busy = false }
      document.head.append(script)
    } catch (err) {
      backoff() // 开发路由不在就退避
    }
    schedule()
  }
  // 页面重新可见/获得焦点时立刻再问一次；监听只绑一次（用全局 kick 指向当前模块）
  try {
    if (!window.__dshCrawlerPollKickBound) {
      window.__dshCrawlerPollKickBound = true
      const kick = () => { try { window.__dshCrawlerPollKick && window.__dshCrawlerPollKick() } catch (err) { /* ignore */ } }
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick() })
      window.addEventListener('focus', kick)
    }
    window.__dshCrawlerPollKick = () => { delay = 2000; if (!timer) schedule() }
  } catch (err) { /* ignore */ }
  schedule()
}

let overlayStop = null

/** 按 cfg.enabled 起停整个 overlay：关闭时 dispose（不再有任何后台循环），打开时重建。 */
function ensureOverlay() {
  if (cfg.enabled) {
    try { cancelSeedWorkerStop() } catch (err) { /* ignore */ }
    if (!overlayStop) { try { overlayStop = startOverlay() } catch (err) { console.warn('[crawler] start failed', err) } }
  } else if (overlayStop) {
    try { overlayStop() } catch (err) { /* ignore */ }
    overlayStop = null
    // overlay 已经 dispose；Worker 还占着 ~10MB 解析后的形态数据，60s 后没人打开就释放
    try { scheduleSeedWorkerStop() } catch (err) { /* ignore */ }
  }
}

function apply(ctx) {
  ctx.effect(() => {
    const off = subscribe(ensureOverlay)
    // 首次启动让出给 DSH 自己的 boot：等一个空闲帧（最多 2.5s）再建 overlay，
    // 避免页面刚起来时和宿主抢主线程（之前会叠加出几百 ms 的长任务）。
    let cancelled = false
    let kick = 0
    const startSoon = () => { if (!cancelled) ensureOverlay() }
    try {
      if (typeof requestIdleCallback === 'function') kick = requestIdleCallback(startSoon, { timeout: 2500 })
      else kick = setTimeout(startSoon, 1200)
    } catch (err) { kick = setTimeout(startSoon, 1200) }
    return () => {
      cancelled = true
      try { if (typeof cancelIdleCallback === 'function') cancelIdleCallback(kick) } catch (err) { /* ignore */ }
      try { clearTimeout(kick) } catch (err) { /* ignore */ }
      try { off() } catch (err) { /* ignore */ }
      if (overlayStop) { try { overlayStop() } catch (err) { /* ignore */ } ; overlayStop = null }
    }
  }, '@dsh-external/dsh-crawler: overlay')
  // 设置页是「锦上添花」：slots 没就绪也不能拖累 overlay，所以走 ctx.inject 等它。
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['slots'], (child) => { try { registerSettingsSection(child) } catch (err) { console.warn('[crawler] settings section failed', err) } })
    else registerSettingsSection(ctx)
  } catch (err) { console.warn('[crawler] 设置页注册失败', err) }
  startHotPoll()
}

module.exports = { inject: ['slots'], apply }
