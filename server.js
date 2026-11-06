/**
 * jiojio厨房点菜网页版 - 服务端
 * 零依赖（只用 Node 内置模块），数据存 data/db.json
 * 运行：node server.js   （默认端口 3000，可用环境变量 PORT 修改）
 *
 * 身份体系（两套独立）：
 *   店主：管理密码登录 → x-admin-token（管理订单/菜品/评价回复）
 *   客人：昵称+密码注册/登录 → x-user-token（下单/取消/写评价）
 * 浏览菜单和看评价不需要登录。
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
const TOKEN_TTL = 7 * 24 * 3600 * 1000
const PW_SALT = 'jiojio_kitchen_2026'
const pwHash = pwd => sha256(PW_SALT + String(pwd))

/* ---------------- 数据库（JSON 文件） ---------------- */
let db = null

function defaultDB() {
  return {
    config: { adminPassword: sha256(uid4()).slice(0, 10) },
    tokens: {},          // 店主 token -> createdAt
    userTokens: {},      // 客人 token -> { uid, ts }
    users: [],           // { id, nickname, pw, createdAt }
    dishes: [],
    orders: [],
    reviews: []          // { id, orderId, uid, nickname, dishId, dishName, emoji, rating, content, reply, createdAt }
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
      // 兼容新增集合
      if (!db.users) db.users = []
      if (!db.userTokens) db.userTokens = {}
      // 兼容旧版整单评价（无 dishId）：标记为整单
      db.reviews.forEach(r => {
        if (!r.dishId) { r.dishId = ''; r.dishName = r.dishName || '整单'; r.emoji = r.emoji || '🍽️' }
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
    console.log('首次运行：已生成示例菜单')
    console.log('店主管理密码：' + db.config.adminPassword)
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
  // [菜名, emoji, 价格, 分类, 材料, 状态]
  // 价格为占位价，可在管理后台「菜品管理」里随时修改
  const seed = [
    ['清炖牛肋条', '🥩', 68, '荤菜', '', 'on'],
    ['土豆排骨炖粉条', '🍲', 42, '荤菜', '排骨、四季豆、土豆、粉条', 'on'],
    ['可乐鸡翅', '🍗', 32, '荤菜', '', 'on'],
    ['糖醋里脊', '🍖', 38, '荤菜', '', 'on'],
    ['番茄炒蛋', '🍅', 16, '素菜', '', 'on'],
    ['手抓饼', '🫓', 15, '主食', '鸡蛋、火腿肠、青椒土豆丝、沙拉酱', 'on'],
    ['酱油蛋炒饭', '🍚', 18, '主食', '虾滑、午餐肉、鸡蛋、隔夜米饭', 'on']
  ]
  db.dishes = seed.map(([name, emoji, price, category, desc, status], i) => ({
    id: 'd' + (i + 1),
    name, emoji, price, category, desc,
    status,           // new 新上线 / on 在售 / off 已下线（用户看不到）
    sort: i
  }))
}

/* ---------------- 菜单与评分 ---------------- */
// 用户可见的菜单：新上线 + 在售（已下线不显示）
function menuDishes() {
  return db.dishes.filter(d => d.status !== 'off')
}

// 某道菜的评分统计（按菜评价聚合）
function dishStat(dishId) {
  const rs = db.reviews.filter(r => r.dishId === dishId)
  if (!rs.length) return null
  return {
    avg: (rs.reduce((s, r) => s + r.rating, 0) / rs.length).toFixed(1),
    count: rs.length
  }
}

/* ---------------- 客人登录态 ---------------- */
function issueUserToken(userId) {
  const t = 'u' + uid4()
  db.userTokens[t] = { uid: userId, ts: nowTs() }
  // 顺手清理过期 token
  for (const [k, v] of Object.entries(db.userTokens)) {
    if (nowTs() - v.ts > TOKEN_TTL) delete db.userTokens[k]
  }
  saveDB()
  return t
}

function getUser(req) {
  const t = req.headers['x-user-token'] || ''
  const info = t && db.userTokens[t]
  if (!info || nowTs() - info.ts > TOKEN_TTL) return null
  return db.users.find(u => u.id === info.uid) || null
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
  const items = Array.isArray(body.items) ? body.items : []
  const mealDate = body.mealDate === 'tomorrow' ? 'tomorrow' : 'today'
  const mealTime = String(body.mealTime || '').slice(0, 5)
  const guests = Math.min(Math.max(parseInt(body.guests) || 1, 1), 20)
  const avoid = Array.isArray(body.avoid) ? body.avoid.slice(0, 8).map(s => String(s).slice(0, 20)) : []
  const note = String(body.note || '').trim().slice(0, 200)
  if (!items.length) return { err: '还没点菜呢' }
  if (!/^\d{1,2}:\d{2}$/.test(mealTime)) return { err: '选一下用餐时间' }
  const norm = []
  for (const it of items) {
    const count = Math.min(Math.max(parseInt(it.count) || 0, 1), 20)
    if (!it.dishId || !count) continue
    norm.push({ dishId: String(it.dishId), count })
  }
  if (!norm.length) return { err: '还没点菜呢' }
  return { items: norm, mealDate, mealTime, guests, avoid, note }
}

/* ---------------- API 路由 ---------------- */
async function handleAPI(req, res, urlObj) {
  const p = urlObj.pathname
  const q = urlObj.searchParams
  const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {}
  const adminToken = req.headers['x-admin-token'] || ''

  function isAdmin() {
    return adminToken && db.tokens[adminToken] && nowTs() - db.tokens[adminToken] < TOKEN_TTL
  }
  function orderView(o) {
    const rvd = db.reviews.filter(r => r.orderId === o.id)
    const reviewedIds = Array.from(new Set(rvd.map(r => r.dishId)))
    return Object.assign({}, o, {
      timeText: new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false }),
      reviewedIds,
      canReview: o.status === 'completed' && o.items.some(i => !reviewedIds.includes(i.dishId))
    })
  }
  function reviewView(r) {
    return Object.assign({}, r, {
      timeText: new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })
    })
  }

  /* ---- 客人认证 ---- */

  // 注册（注册即登录）
  if (p === '/api/auth/register' && req.method === 'POST') {
    const nickname = String(body.nickname || '').trim().slice(0, 20)
    const password = String(body.password || '')
    if (!nickname) return fail(res, 400, '先起一个称呼（昵称）')
    if (db.users.some(u => u.nickname === nickname)) return fail(res, 400, '这个称呼已被使用，换一个试试')
    if (password.length < 4) return fail(res, 400, '密码至少 4 位')
    if (password.length > 32) return fail(res, 400, '密码最多 32 位')
    const user = {
      id: 'u' + Date.now().toString(36) + uid4().slice(0, 4),
      nickname, pw: pwHash(password), createdAt: nowTs()
    }
    db.users.push(user)
    return ok(res, { token: issueUserToken(user.id), user: { id: user.id, nickname: user.nickname } })
  }

  // 登录
  if (p === '/api/auth/login' && req.method === 'POST') {
    const nickname = String(body.nickname || '').trim()
    const password = String(body.password || '')
    const user = db.users.find(u => u.nickname === nickname)
    if (!user || user.pw !== pwHash(password)) return fail(res, 401, '称呼或密码不对')
    return ok(res, { token: issueUserToken(user.id), user: { id: user.id, nickname: user.nickname } })
  }

  // 登出
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const t = req.headers['x-user-token'] || ''
    if (t && db.userTokens[t]) { delete db.userTokens[t]; saveDB() }
    return ok(res, {})
  }

  /* ---- 公开接口（无需登录） ---- */

  // 菜单（含每道菜的评分统计）
  if (p === '/api/menu' && req.method === 'GET') {
    const dishes = menuDishes().map(d => ({
      id: d.id, name: d.name, emoji: d.emoji, price: d.price,
      category: d.category, desc: d.desc, status: d.status,
      rating: dishStat(d.id)
    }))
    return ok(res, { dishes })
  }

  // 某道菜的评价列表
  if (p === '/api/dish-reviews' && req.method === 'GET') {
    const id = q.get('id') || ''
    const d = db.dishes.find(x => x.id === id)
    if (!d) return fail(res, 404, '菜品不存在')
    const list = db.reviews.filter(r => r.dishId === id)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(reviewView)
    return ok(res, { dish: { id: d.id, name: d.name, emoji: d.emoji }, stat: dishStat(id), list })
  }

  // 评价列表 + 总统计
  if (p === '/api/reviews' && req.method === 'GET') {
    const all = db.reviews
    const list = all.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(reviewView)
    const total = all.length
    const avg = total ? (all.reduce((s, r) => s + r.rating, 0) / total).toFixed(1) : '0.0'
    const good = all.filter(r => r.rating >= 4).length
    return ok(res, { stat: { avg, total, goodRate: total ? Math.round(good / total * 100) : 0 }, list })
  }

  /* ---- 客人接口（需登录） ---- */

  // 下单（必须登录；价格由服务端重算，前端改不了；称呼取自账号）
  if (p === '/api/order' && req.method === 'POST') {
    const user = getUser(req)
    if (!user) return fail(res, 401, '下单前先登录一下')
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
      uid: user.id,
      nickname: user.nickname,
      items, total,
      mealDate: c.mealDate, mealTime: c.mealTime, guests: c.guests,
      avoid: c.avoid, note: c.note,
      status: 'pending',           // pending 待接单 / cooking 制作中 / completed 已完成 / rejected 拒单 / cancelled 取消
      rejectReason: '',
      createdAt: nowTs(), updatedAt: nowTs()
    }
    db.orders.unshift(order)
    saveDB()
    return ok(res, { order: orderView(order) })
  }

  // 我的订单
  if (p === '/api/myorders' && req.method === 'GET') {
    const user = getUser(req)
    if (!user) return fail(res, 401, '登录后才能看订单')
    const list = db.orders.filter(o => o.uid === user.id).slice(0, 50).map(orderView)
    return ok(res, { list })
  }

  // 取消订单（本人 + 待接单状态）
  if (p.match(/^\/api\/order\/[\w-]+\/cancel$/) && req.method === 'POST') {
    const user = getUser(req)
    if (!user) return fail(res, 401, '登录后才能取消订单')
    const id = p.split('/')[3]
    const o = db.orders.find(x => x.id === id)
    if (!o) return fail(res, 404, '订单不存在')
    if (o.uid !== user.id) return fail(res, 403, '只能取消自己的订单')
    if (o.status !== 'pending') return fail(res, 400, '这个状态不能取消了，等店主看看吧')
    o.status = 'cancelled'
    o.updatedAt = nowTs()
    saveDB()
    return ok(res, { order: orderView(o) })
  }

  // 按菜写评价：已完成订单，可逐菜打分；每道菜只能评一次（没评的菜下次还能补评）
  if (p === '/api/review' && req.method === 'POST') {
    const user = getUser(req)
    if (!user) return fail(res, 401, '写评价前先登录一下')
    const o = db.orders.find(x => x.id === body.orderId)
    if (!o) return fail(res, 404, '订单不存在')
    if (o.uid !== user.id) return fail(res, 403, '只能评价自己的订单')
    if (o.status !== 'completed') return fail(res, 400, '吃上了才能评价哦')

    const ratings = Array.isArray(body.ratings) ? body.ratings : []
    const already = new Set(db.reviews.filter(r => r.orderId === o.id).map(r => r.dishId))
    const valid = []
    for (const it of ratings) {
      const dish = o.items.find(i => i.dishId === it.dishId)
      if (!dish || already.has(dish.dishId)) continue
      const rating = Math.min(Math.max(parseInt(it.rating) || 5, 1), 5)
      valid.push({
        dishId: dish.dishId, dishName: dish.name, emoji: dish.emoji,
        rating, content: String(it.content || '').trim().slice(0, 200)
      })
    }
    if (!valid.length) return fail(res, 400, '这单的菜都评价过啦')

    for (const v of valid) {
      db.reviews.unshift(Object.assign({
        id: 'r' + Date.now().toString(36) + uid4().slice(0, 3),
        orderId: o.id, uid: user.id, nickname: user.nickname,
        reply: '', createdAt: nowTs()
      }, v))
    }
    saveDB()
    return ok(res, { count: valid.length, reviews: db.reviews.filter(r => r.orderId === o.id).slice(0, 50).map(reviewView) })
  }

  /* ---- 店主接口 ---- */

  // 店主登录
  if (p === '/api/admin/login' && req.method === 'POST') {
    if (String(body.password || '') !== db.config.adminPassword) {
      return fail(res, 401, '密码不对，只有店主知道')
    }
    const token = 't' + uid4()
    db.tokens[token] = nowTs()
    // 清理 7 天前的旧 token
    for (const [t, ts] of Object.entries(db.tokens)) {
      if (nowTs() - ts > TOKEN_TTL) delete db.tokens[t]
    }
    saveDB()
    return ok(res, { token })
  }

  // 以下全部要求店主身份
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin()) return fail(res, 401, '请先输入店主密码')

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

    // 回复评价（逐条回复）
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
  console.log(`jiojio厨房已开张：http://localhost:${PORT}`)
  console.log(`数据文件：${DB_FILE}`)
})
