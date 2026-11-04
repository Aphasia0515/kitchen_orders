/**
 * 家常点菜网页版 - 服务端
 * 零依赖（只用 Node 内置模块），数据存 data/db.json
 * 运行：node server.js   （默认端口 3000，可用环境变量 PORT 修改）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = process.env.PORT || 3000
const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, 'public')
const DATA_DIR = path.join(ROOT, 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')

/* ---------------- 工具 ---------------- */
const uid4 = () => crypto.randomBytes(8).toString('hex')
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex')
const nowTs = () => Date.now()

function todayStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- 数据库（JSON 文件） ---------------- */
let db = null

function defaultDB() {
  return {
    config: { adminPassword: sha256(uid4()).slice(0, 10), adminToken: '' },
    tokens: {},          // adminToken -> createdAt
    dishes: [],
    orders: [],
    reviews: []
  }
}

function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
      // 兼容旧版数据：available/today 字段迁移为 status
      db.dishes.forEach(d => {
        if (!d.status) {
          d.status = (d.available === false || d.today === false) ? 'off' : 'on'
          delete d.available
          delete d.today
        }
      })
    } catch (e) {
      console.error('db.json 解析失败，使用全新数据', e)
      db = defaultDB()
    }
  } else {
    db = defaultDB()
    seedDishes()
    saveDB()
    console.log('========================================')
    console.log('首次运行：已生成 12 道示例菜')
    console.log('主人管理密码：' + db.config.adminPassword)
    console.log('（也可在 data/db.json 的 config.adminPassword 里改）')
    console.log('========================================')
  }
}

// 原子写入：先写临时文件再改名，断电也不会损坏数据
let saveTimer = null
function saveDB() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
    fs.renameSync(tmp, DB_FILE)
  }, 50)
}

function seedDishes() {
  const seed = [
    ['红烧排骨', '🍖', 42, '荤菜', '慢炖一小时，软烂脱骨', 'new'],
    ['可乐鸡翅', '🍗', 32, '荤菜', '甜口的，朋友最爱', 'new'],
    ['糖醋里脊', '🐷', 36, '荤菜', '外酥里嫩，酸甜口', 'on'],
    ['蒜蓉大虾', '🦐', 48, '荤菜', '蒜香十足', 'on'],
    ['麻婆豆腐', '🌶️', 22, '素菜', '下饭神器，微辣', 'on'],
    ['番茄炒蛋', '🍅', 18, '素菜', '家常经典', 'on'],
    ['清炒时蔬', '🥬', 12, '素菜', '今天买的青菜', 'on'],
    ['凉拌黄瓜', '🥒', 8, '素菜', '爽口小菜', 'off'],
    ['扬州炒饭', '🍚', 12, '主食', '料多管饱', 'on'],
    ['紫菜蛋花汤', '🍲', 8, '汤羹', '热乎', 'on'],
    ['冰可乐', '🥤', 5, '饮品', '冰的', 'on'],
    ['酸梅汤', '🧃', 6, '饮品', '自己熬的', 'on']
  ]
  db.dishes = seed.map(([name, emoji, price, category, desc, status], i) => ({
    id: 'd' + (i + 1),
    name, emoji, price, category, desc,
    status,           // new 新上线 / on 在售 / off 已下线（用户看不到）
    sort: i
  }))
}

/* ---------------- 菜单逻辑 ---------------- */
// 用户可见的菜单：新上线 + 在售（已下线不显示）
function menuDishes() {
  return db.dishes.filter(d => d.status !== 'off')
}

/* ---------------- HTTP 基础 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}
const ok = (res, data) => sendJSON(res, 200, Object.assign({ ok: true }, data))
const fail = (res, code, msg) => sendJSON(res, code, { ok: false, msg })

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => {
      raw += c
      if (raw.length > 1e6) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath
  const file = path.normalize(path.join(PUBLIC_DIR, p))
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden')
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 前端是单页应用，未匹配到的路径回退到 index.html
      if (!path.extname(p)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
          if (e2) return fail(res, 404, 'not found')
          res.writeHead(200, { 'Content-Type': MIME['.html'] })
          res.end(b2)
        })
      }
      return fail(res, 404, 'not found')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}

/* ---------------- 校验 ---------------- */
function cleanOrderInput(body) {
  const nickname = String(body.nickname || '').trim().slice(0, 20)
  const items = Array.isArray(body.items) ? body.items : []
  const mealDate = body.mealDate === 'tomorrow' ? 'tomorrow' : 'today'
  const mealTime = String(body.mealTime || '').slice(0, 5)
  const guests = Math.min(Math.max(parseInt(body.guests) || 1, 1), 20)
  const avoid = Array.isArray(body.avoid) ? body.avoid.slice(0, 8).map(s => String(s).slice(0, 20)) : []
  const note = String(body.note || '').trim().slice(0, 200)
  if (!nickname) return { err: '先告诉我们怎么称呼你' }
  if (!items.length) return { err: '还没点菜呢' }
  if (!/^\d{1,2}:\d{2}$/.test(mealTime)) return { err: '选一下用餐时间' }
  const norm = []
  for (const it of items) {
    const count = Math.min(Math.max(parseInt(it.count) || 0, 1), 20)
    if (!it.dishId || !count) continue
    norm.push({ dishId: String(it.dishId), count })
  }
  if (!norm.length) return { err: '还没点菜呢' }
  return { nickname, items: norm, mealDate, mealTime, guests, avoid, note }
}

/* ---------------- API 路由 ---------------- */
async function handleAPI(req, res, urlObj) {
  const p = urlObj.pathname
  const q = urlObj.searchParams
  const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {}
  const adminToken = req.headers['x-admin-token'] || body.adminToken || ''

  function isAdmin() {
    return adminToken && db.tokens[adminToken] && nowTs() - db.tokens[adminToken] < 7 * 24 * 3600 * 1000
  }
  function orderView(o) {
    const r = db.reviews.find(x => x.orderId === o.id)
    return Object.assign({}, o, {
      timeText: new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false }),
      reviewed: !!r
    })
  }
  function reviewView(r) {
    return Object.assign({}, r, {
      timeText: new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })
    })
  }

  /* ---- 公开接口 ---- */

  // 菜单
  if (p === '/api/menu' && req.method === 'GET') {
    const dishes = menuDishes().map(d => ({
      id: d.id, name: d.name, emoji: d.emoji, price: d.price,
      category: d.category, desc: d.desc, status: d.status
    }))
    return ok(res, { dishes })
  }

  // 下单（价格由服务端重算，前端改不了）
  if (p === '/api/order' && req.method === 'POST') {
    const c = cleanOrderInput(body)
    if (c.err) return fail(res, 400, c.err)
    const menu = new Map(menuDishes().map(d => [d.id, d]))
    let total = 0
    const items = []
    for (const it of c.items) {
      const dish = menu.get(it.dishId)
      if (!dish) return fail(res, 400, '有菜已下线了，刷新一下再点')
      total += dish.price * it.count
      items.push({ dishId: dish.id, name: dish.name, emoji: dish.emoji, price: dish.price, count: it.count })
    }
    const order = {
      id: 'o' + Date.now().toString(36) + uid4().slice(0, 4),
      uid: String(body.uid || '').slice(0, 40),
      nickname: c.nickname,
      items, total,
      mealDate: c.mealDate, mealTime: c.mealTime, guests: c.guests,
      avoid: c.avoid, note: c.note,
      status: 'pending',           // pending 待接单 / cooking 制作中 / completed 已完成 / rejected 拒单 / cancelled 取消
      rejectReason: '',
      createdAt: nowTs(), updatedAt: nowTs()
    }
    if (!order.uid) order.uid = uid4()
    db.orders.unshift(order)
    saveDB()
    return ok(res, { order: orderView(order), uid: order.uid })
  }

  // 我的订单
  if (p === '/api/myorders' && req.method === 'GET') {
    const uid = q.get('uid') || ''
    const list = db.orders.filter(o => o.uid === uid).slice(0, 50).map(orderView)
    return ok(res, { list })
  }

  // 取消订单（只有本人 + 待接单状态）
  if (p.match(/^\/api\/order\/[\w-]+\/cancel$/) && req.method === 'POST') {
    const id = p.split('/')[3]
    const o = db.orders.find(x => x.id === id)
    if (!o) return fail(res, 404, '订单不存在')
    if (o.uid !== body.uid) return fail(res, 403, '只能取消自己的订单')
    if (o.status !== 'pending') return fail(res, 400, '这个状态不能取消了，等主人看看吧')
    o.status = 'cancelled'
    o.updatedAt = nowTs()
    saveDB()
    return ok(res, { order: orderView(o) })
  }

  // 写评价（只有已完成订单能评，一单一评）
  if (p === '/api/review' && req.method === 'POST') {
    const { uid, orderId, rating, tags, content } = body
    const o = db.orders.find(x => x.id === orderId)
    if (!o) return fail(res, 404, '订单不存在')
    if (o.uid !== uid) return fail(res, 403, '只能评价自己的订单')
    if (o.status !== 'completed') return fail(res, 400, '吃上了才能评价哦')
    if (db.reviews.some(r => r.orderId === orderId)) return fail(res, 400, '这单已经评价过啦')
    const r = Math.min(Math.max(parseInt(rating) || 5, 1), 5)
    const review = {
      id: 'r' + Date.now().toString(36),
      orderId, uid: o.uid,
      nickname: String(body.nickname || o.nickname).slice(0, 20),
      rating: r,
      tags: Array.isArray(tags) ? tags.slice(0, 5).map(s => String(s).slice(0, 10)) : [],
      content: String(content || '').trim().slice(0, 300),
      reply: '',
      createdAt: nowTs()
    }
    db.reviews.unshift(review)
    saveDB()
    return ok(res, { review: reviewView(review) })
  }

  // 评价列表 + 统计
  if (p === '/api/reviews' && req.method === 'GET') {
    const list = db.reviews.slice(0, 50).map(reviewView)
    const total = list.length
    const avg = total ? (list.reduce((s, r) => s + r.rating, 0) / total).toFixed(1) : '0.0'
    const good = list.filter(r => r.rating >= 4).length
    return ok(res, { stat: { avg, total, goodRate: total ? Math.round(good / total * 100) : 0 }, list })
  }

  /* ---- 主人接口 ---- */

  // 登录
  if (p === '/api/admin/login' && req.method === 'POST') {
    if (String(body.password || '') !== db.config.adminPassword) {
      return fail(res, 401, '密码不对，只有主人知道')
    }
    const token = 't' + uid4()
    db.tokens[token] = nowTs()
    // 清理 7 天前的旧 token
    for (const [t, ts] of Object.entries(db.tokens)) {
      if (nowTs() - ts > 7 * 24 * 3600 * 1000) delete db.tokens[t]
    }
    saveDB()
    return ok(res, { token })
  }

  // 以下全部要求管理员身份
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin()) return fail(res, 401, '请先输入主人密码')

    // 订单管理
    if (p === '/api/admin/orders' && req.method === 'GET') {
      const status = q.get('status')
      let list = db.orders
      if (status && status !== 'all') list = list.filter(o => o.status === status)
      return ok(res, { list: list.slice(0, 100).map(orderView) })
    }

    // 修改订单状态：cooking / completed / rejected
    if (p.match(/^\/api\/admin\/order\/[\w-]+\/status$/) && req.method === 'POST') {
      const id = p.split('/')[4]
      const o = db.orders.find(x => x.id === id)
      if (!o) return fail(res, 404, '订单不存在')
      const to = body.status
      const allow = { cooking: ['pending'], completed: ['cooking'], rejected: ['pending'] }
      if (!allow[to]) return fail(res, 400, '状态不合法')
      if (!allow[to].includes(o.status)) {
        return fail(res, 400, o.status === 'pending' ? '手慢了，这单状态已经变了' : '当前状态不能这样改')
      }
      o.status = to
      o.rejectReason = to === 'rejected' ? String(body.reason || '今天这菜没了，改天再约').slice(0, 100) : ''
      o.updatedAt = nowTs()
      saveDB()
      return ok(res, { order: orderView(o) })
    }

    // 菜品列表
    if (p === '/api/admin/dishes' && req.method === 'GET') {
      return ok(res, { list: db.dishes })
    }

    // 新增菜品
    if (p === '/api/admin/dish' && req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 20)
      const price = Math.round(parseFloat(body.price) * 100) / 100
      if (!name) return fail(res, 400, '菜名不能为空')
      if (!(price > 0 && price < 10000)) return fail(res, 400, '价格不对')
      const dish = {
        id: 'd' + Date.now().toString(36),
        name,
        emoji: String(body.emoji || '🍽️').slice(0, 8),
        price,
        category: String(body.category || '家常菜').slice(0, 10),
        desc: String(body.desc || '').slice(0, 50),
        status: ['new', 'on', 'off'].includes(body.status) ? body.status : 'on',
        sort: db.dishes.length
      }
      db.dishes.push(dish)
      saveDB()
      return ok(res, { dish })
    }

    // 修改菜品
    if (p.match(/^\/api\/admin\/dish\/[\w-]+$/) && req.method === 'PUT') {
      const id = p.split('/')[4]
      const d = db.dishes.find(x => x.id === id)
      if (!d) return fail(res, 404, '菜品不存在')
      if (body.name !== undefined) d.name = String(body.name).trim().slice(0, 20) || d.name
      if (body.emoji !== undefined) d.emoji = String(body.emoji).slice(0, 8) || d.emoji
      if (body.price !== undefined) {
        const price = Math.round(parseFloat(body.price) * 100) / 100
        if (price > 0 && price < 10000) d.price = price
      }
      if (body.category !== undefined) d.category = String(body.category).slice(0, 10) || d.category
      if (body.desc !== undefined) d.desc = String(body.desc).slice(0, 50)
      if (body.status !== undefined && ['new', 'on', 'off'].includes(body.status)) d.status = body.status
      saveDB()
      return ok(res, { dish: d })
    }

    // 删除菜品
    if (p.match(/^\/api\/admin\/dish\/[\w-]+$/) && req.method === 'DELETE') {
      const id = p.split('/')[4]
      const i = db.dishes.findIndex(x => x.id === id)
      if (i < 0) return fail(res, 404, '菜品不存在')
      db.dishes.splice(i, 1)
      saveDB()
      return ok(res, {})
    }

    // 回复评价
    if (p.match(/^\/api\/admin\/review\/[\w-]+\/reply$/) && req.method === 'POST') {
      const id = p.split('/')[4]
      const r = db.reviews.find(x => x.id === id)
      if (!r) return fail(res, 404, '评价不存在')
      r.reply = String(body.reply || '').trim().slice(0, 100)
      saveDB()
      return ok(res, { review: reviewView(r) })
    }

    return fail(res, 404, '接口不存在')
  }

  return fail(res, 404, '接口不存在')
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (urlObj.pathname.startsWith('/api/')) {
    handleAPI(req, res, urlObj).catch(e => {
      console.error(e)
      if (!res.headersSent) fail(res, 500, '服务器开小差了')
    })
  } else {
    serveStatic(req, res, urlObj.pathname)
  }
})

loadDB()
server.listen(PORT, () => {
  console.log(`家常点菜已开张：http://localhost:${PORT}`)
  console.log(`数据文件：${DB_FILE}`)
})
