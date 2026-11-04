#!/usr/bin/env node
/**
 * 抓取引擎构建脚本：
 *   assets/engine.src.js  (原作引擎，未改)  → 打上 1 个最小补丁 → lib 内嵌 base64
 *   assets/seeds.json     (1111 个原作形态) → gzip → 内嵌 base64
 *   assets/audio.json     (各形态自带音色池) → 内嵌
 *   src/client/index.js   (手写逻辑)        → 替换占位符 → 包成 ModuleLoader 模块
 *
 * 补丁只有一个：把引擎内部返回的 api 挂到 window.__crawler_api，
 * 否则 eval 拿不到它（原作的 IIFE 把返回值丢掉了），也就无法 set_active / stop / 静音。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const NEEDLE = 'return t.on_stop((()=>b.close())),t.listen(e,"pagehide",t.stop),j(),{spider:s,'
const PATCHED = 'return t.on_stop((()=>b.close())),t.listen(e,"pagehide",t.stop),j(),window.__crawler_api={spider:s,'

let engine = read('assets/engine.src.js')
if (!engine.includes(NEEDLE)) {
  console.error('engine patch: needle not found — engine asset changed?')
  process.exit(1)
}
engine = engine.replace(NEEDLE, PATCHED)

// 去掉原作页面底纹的方格网（dsh 界面不需要"作业本"网格，也避免和面板边框混在一起）
const GRID_NEEDLE = 'A.strokeStyle=n?"#0000000f":"#ffffff0f"'
const GRID_PATCH = 'A.strokeStyle="transparent"'
if (!engine.includes(GRID_NEEDLE)) {
  console.error('engine patch: grid needle not found')
  process.exit(1)
}
engine = engine.replace(GRID_NEEDLE, GRID_PATCH)

// 网格虽然已经透明，但每帧仍在拼 ~60 条线再 stroke（三只虫 ×30fps ≈ 5 千条/秒的废活）。
// 直接把画网格的那个 IIFE 在最前面 return 掉——dsh 界面不需要底纹网格。
const GRID_SKIP_NEEDLE = '{let o=HA(i.x-a.x),r=HA(i.y-a.y);A.strokeStyle="transparent"'
const GRID_SKIP_PATCH = '{return;let o=HA(i.x-a.x),r=HA(i.y-a.y);A.strokeStyle="transparent"'
if (!engine.includes(GRID_SKIP_NEEDLE)) {
  console.error('engine patch: grid skip needle not found')
  process.exit(1)
}
engine = engine.replace(GRID_SKIP_NEEDLE, GRID_SKIP_PATCH)

// 渲染分辨率：不再一律压到 1x（那会让 125%/150% 缩放的显示器上虫子被放大、发虚），
// 改成按客户端给的 __crawlerDprCap（= min(devicePixelRatio, 2)）渲染。
// 小画布只有 560×500，1.25x 也就 1.75MB/只，比全屏时代省得多。
const DPR_NEEDLE = 'Math.min(e.devicePixelRatio||1,2)'
const DPR_PATCH = 'Math.min(e.devicePixelRatio||1,window.__crawlerDprCap||1)'
if (!engine.includes(DPR_NEEDLE)) {
  console.error('engine patch: dpr needle not found')
  process.exit(1)
}
engine = engine.replace(DPR_NEEDLE, DPR_PATCH)

// —— 画布槽位补丁（多实例的关键） ——
// 原作引擎按 id 找画布：i.querySelector("#crawler-canvas")。
// 我们给每只虫一张画布，三张画布的 id 相同 → querySelector 永远返回第一张，
// 结果三只引擎都画在第一张画布上（互相 clear、只有一只可见、动作看起来同步）。
// 改成：优先用 createPet 在 eval 前放进 window.__crawlerCanvasSlot 的这一张。
const SLOT_NEEDLE = 'a=i.querySelector("#crawler-canvas")'
const SLOT_PATCH = 'a=window.__crawlerCanvasSlot||i.querySelector("#crawler-canvas")'
if (!engine.includes(SLOT_NEEDLE)) {
  console.error('engine patch: canvas slot needle not found')
  process.exit(1)
}
engine = engine.replace(SLOT_NEEDLE, SLOT_PATCH)

// 数据脚本同理（每只虫的 settings 不同）；虽然我们是「插入→立即移除」，也走槽位保证拿到自己那份。
const DATA_SLOT_NEEDLE = 'JSON.parse(document.querySelector("#crawler-data").textContent)'
const DATA_SLOT_PATCH = 'JSON.parse((window.__crawlerDataSlot||document.querySelector("#crawler-data")).textContent)'
if (!engine.includes(DATA_SLOT_NEEDLE)) {
  console.error('engine patch: data slot needle not found')
  process.exit(1)
}
engine = engine.replace(DATA_SLOT_NEEDLE, DATA_SLOT_PATCH)

// —— 帧率上限 30fps ——
// 引擎每个实例各自跑满 rAF（60fps），三只就是 180 次/秒全屏 clear + 绘制。
// 虫子移动很慢，30fps 足够；引擎用 rAF 时间戳推进物理，跳帧不会让动作变慢。
// 保留每实例独立的 rAF 循环（不引入共享帧驱动，避免上次那种「一停全停」的问题）。
const FRAME_NEEDLE = 'request_frame:function(e){return r?0:(s=A.requestAnimationFrame((A=>{r||e(A)})),s)}'
const FRAME_PATCH = 'request_frame:(function(){var L=0,self=function(e){return r?0:(s=A.requestAnimationFrame((function(A){if(r)return;var p=(A||0)-(L||0);if(p<32){return void self(e)}L=A||0,e(A)})),s)};return self})()'
if (!engine.includes(FRAME_NEEDLE)) {
  console.error('engine patch: request_frame needle not found')
  process.exit(1)
}
engine = engine.replace(FRAME_NEEDLE, FRAME_PATCH)

// —— 小画布模式（跟随相机） ——
// 1) 视口 = 画布 CSS 尺寸，不再是整个窗口：虫子永远画在一张 560×500 的小画布里，
//    画布跟着引擎相机走（camera_follow），显存从每只 ~5.7MB 降到 ~1.1MB。
const VIEW_NEEDLE = 'w=Math.max(1,e.innerWidth),M=Math.max(1,e.innerHeight)'
const VIEW_PATCH = 'w=Math.max(1,a.clientWidth||e.innerWidth),M=Math.max(1,a.clientHeight||e.innerHeight)'
if (!engine.includes(VIEW_NEEDLE)) {
  console.error('engine patch: viewport needle not found')
  process.exit(1)
}
engine = engine.replace(VIEW_NEEDLE, VIEW_PATCH)

// 2) 不再按视口把 scale 压小；也不再在 resize 时把 scale 重置回初始值
//    （生长是运行时改 settings.scale 的，resize 如果重置就白长了）。
const CAP_NEEDLE = 'r.scale=Math.min(P,.42*Math.min(w,M)/E)'
const CAP_PATCH = '0'
if (!engine.includes(CAP_NEEDLE)) {
  console.error('engine patch: scale cap needle not found')
  process.exit(1)
}
engine = engine.replace(CAP_NEEDLE, CAP_PATCH)

// 3) 在引擎自己的帧里、物理步进之后、绘制之前，把相机对准虫子并移动画布。
//    放在 q() 的绘制入口前（此时 s.update(c) 已执行，虫子位置是本帧最新的），
//    这样「相机偏移」和「画布位移」永远同一帧、同一个值 —— 不会出现 30fps 错相的高频抖动。
const CAM_NEEDLE = 'let _=Math.min(e.devicePixelRatio||1,window.__crawlerDprCap||1),m=Math.round(w*_),P=Math.round(M*_)'
const CAM_PATCH = 'window.__crawlerCamHook&&window.__crawlerCamHook(l);' + CAM_NEEDLE
if (!engine.includes(CAM_NEEDLE)) {
  console.error('engine patch: camera-frame needle not found')
  process.exit(1)
}
engine = engine.replace(CAM_NEEDLE, CAM_PATCH)

const seeds = read('assets/seeds.json')
const seedsGz = zlib.gzipSync(Buffer.from(seeds, 'utf8'), { level: 9 }).toString('base64')
const audio = read('assets/audio.json').trim()
// 每个形态自己的音色（抓取结果；缺失时退回到通用音色池）
let audioMapText = '{}'
try {
  audioMapText = fs.readFileSync(path.join(ROOT, 'assets/audio-map.json'), 'utf8')
  console.log('audio-map entries', Object.keys(JSON.parse(audioMapText)).length)
} catch (err) { console.warn('audio-map.json missing — fallback to the shared pool') }
const audioMapGz = zlib.gzipSync(Buffer.from(audioMapText, 'utf8'), { level: 9 }).toString('base64')

const rev = String(Date.now())
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const ver = pkg.version || '0.0.0'
let body = read('src/client/index.js')
body = body
  .replace("'__ENGINE_B64__'", JSON.stringify(Buffer.from(engine, 'utf8').toString('base64')))
  .replace("'__SEEDS_GZ_B64__'", JSON.stringify(seedsGz))
  .replace('__AUDIO_POOL__', audio)
  .replace('__BUILD_TAG__', rev)
  .replace("'__BUILD_VER__'", JSON.stringify(ver))
  .replace("'__AUDIO_MAP_GZ_B64__'", JSON.stringify(audioMapGz))
if (body.includes('__ENGINE_B64__') || body.includes('__SEEDS_GZ_B64__') || body.includes('__AUDIO_POOL__') || body.includes('__AUDIO_MAP_GZ_B64__') || body.includes('__BUILD_TAG__') || body.includes('__BUILD_VER__')) {
  console.error('build: placeholder left in output')
  process.exit(1)
}

const out = `window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-crawler',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${body}
    return module.exports
  },
})
`
fs.writeFileSync(path.join(ROOT, 'lib/client.js'), out, 'utf8')

// 自更新用：同一份逻辑去掉 CommonJS 尾巴，作为普通脚本发出去（页面直接加载并热替换 overlay）
const liveBody = '(() => {\n' + body.replace(/module\.exports\s*=\s*\{[^}]*\}\s*$/, '') + '\n})()\n'
// live.js 是当普通 <script> 加载的，里面不能出现 module/exports 引用（否则直接 ReferenceError）
if (liveBody.includes('module.exports')) {
  console.error('build: live body still contains module.exports — strip regex broken')
  process.exit(1)
}
fs.writeFileSync(path.join(ROOT, 'lib/client.live.js'), liveBody, 'utf8')
fs.writeFileSync(path.join(ROOT, 'lib/client.rev'), rev, 'utf8')
console.log('rev', rev, '| live.js', (Buffer.byteLength(liveBody) / 1048576).toFixed(2) + 'MB')
console.log('client.js', (Buffer.byteLength(out) / 1048576).toFixed(2) + 'MB', '| seeds.b64', (seedsGz.length / 1024).toFixed(0) + 'KB')
