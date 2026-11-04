/**
 * @dsh-external/dsh-crawler — host 半边。
 *
 * 插件本体全在 client（lib/client.js）。host 这里只做两件事：
 *   1. 保留插件身份；
 *   2. 如果宿主提供 webServer，挂两条「开发用」路由给页面自更新用：
 *        GET /@dsh-external/dsh-crawler/dev/rev      → { rev }
 *        GET /@dsh-external/dsh-crawler/dev/live.js  → lib/client.live.js
 *      没有 webServer 时静默降级（爬虫照常在页面里跑，只是不热更新）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-crawler'
export const inject = []

export function apply(ctx) {
  const dir = dirname(fileURLToPath(import.meta.url))
  const liveFile = join(dir, 'client.live.js')
  const revFile = join(dir, 'client.rev')

  // 正式包不含 client.live.js（files 里排除了）：不挂开发路由，
  // 页面那边的热更新轮询拿到 404 会退避，不会每 2 秒空转。
  if (!existsSync(liveFile)) return

  const readRev = () => {
    try { return readFileSync(revFile, 'utf8').trim() } catch { /* fall through */ }
    return ''
  }

  // webServer 是可选的：拿不到就只做「没有 host 资源」的普通插件。
  try {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (child) => {
      child.effect(() => child.webServer.register({
        kind: 'prefix',
        path: '/@dsh-external/dsh-crawler/dev',
        handler: async (req, res) => {
          const url = String(req.url || '')
          if (url.indexOf('/rev') >= 0) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ rev: readRev() }))
            return
          }
          if (url.indexOf('/live.js') < 0) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          try {
            const body = readFileSync(liveFile)
            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          } catch (err) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('no live bundle: ' + String(err && err.message))
          }
        },
      }), '@dsh-external/dsh-crawler: dev routes')
    })
  } catch (err) {
    console.warn('[crawler] dev routes unavailable', err)
  }
}
