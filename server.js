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
const IMG_DIR = path.join(DATA_DIR, 'img')   // 上传的菜品图片（不进 git）

/* ---------------- 工具 ---------------- */
const uid4 = () => crypto.randomBytes(8).toString('hex')
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex')
const nowTs = () => Date.now()
const TOKEN_TTL = 7 * 24 * 3600 * 1000
const PW_SALT = 'jiojio_kitchen_2026'
const pwHash = pwd => sha256(PW_SALT + String(pwd))

/* ---------------- 日志 ---------------- */
const LOG_DIR = path.join(DATA_DIR, 'logs')
const ERR_LOG = path.join(LOG_DIR, 'error.log')

// 统一错误日志：双写 —— console（进 out.log，方便 tail）+ data/logs/error.log（进程自管可轮转）
function logErr(tag, err) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false })
  const stack = err instanceof Error ? (err.stack || err.message) : String(err)
  const line = `[${time}] [${tag}] ${stack}\n`
  console.error(line.trimEnd())
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    // 单文件超 5MB：旧的 .1 删掉，当前转存为 .1
    if (fs.existsSync(ERR_LOG) && fs.statSync(ERR_LOG).size > 5 * 1024 * 1024) {
      try { fs.unlinkSync(ERR_LOG + '.1') } catch (e) { /* 无旧档 */ }
      fs.renameSync(ERR_LOG, ERR_LOG + '.1')
    }
    fs.appendFileSync(ERR_LOG, line)
  } catch (e) { /* 写日志本身失败只能放弃 */ }
}

// 进程级兜底：未捕获异常记日志但不退出，服务不挂
process.on('uncaughtException', err => {
  logErr('uncaughtException', err)
  console.error('（已捕获未处理异常，服务继续运行）')
})
process.on('unhandledRejection', reason => {
  logErr('unhandledRejection', reason)
})

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
      logErr('loadDB', e)
      console.error('db.json 解析失败，使用全新数据')
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
// 用户可见的菜单排序（优先级从高到低）：
//   1) 均分 ≥ 4 星的菜，组内按均分降序
//   2) 新上线
//   3) 其余在售（评分不足 4 星或未评价）
//   4) 已下线（仅展示，不可点）
function menuDishes() {
  const avg = d => {
    const s = dishStat(d.id)
    return s ? (parseFloat(s.avg) || 0) : 0
  }
  const rank = d => {
    if (d.status === 'off') return 3
    if (avg(d) >= 4) return 0
    if (d.status === 'new') return 1
    return 2
  }
  return db.dishes.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) return avg(b) - avg(a)   // 四星组内按均分降序
    return 0   // 其余组保持原有顺序（稳定排序）
  })
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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.gif': 'image/gif'
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

/* 二进制 body（图片上传用），上限 5MB */
function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 5 * 1024 * 1024) { reject(new Error('图片超过 5MB')); req.destroy() }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/* 把 multipart 表单拆成 { name, filename, contentType, data } 列表 */
function splitMultipart(buf, boundary) {
  const out = []
  let start = buf.indexOf(boundary)
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length)
    if (next === -1) break
    // 段内容 = boundary 之后到下一个 boundary 之前，去掉前后的 \r\n
    let segStart = start + boundary.length
    let segEnd = next
    if (buf[segStart] === 0x0d && buf[segStart + 1] === 0x0a) segStart += 2
    if (buf[segEnd - 2] === 0x0d && buf[segEnd - 1] === 0x0a) segEnd -= 2
    const seg = buf.subarray(segStart, segEnd)
    // 头部和内容以空行 \r\n\r\n 分隔
    const headEnd = seg.indexOf('\r\n\r\n')
    if (headEnd !== -1) {
      const head = seg.subarray(0, headEnd).toString('utf8')
      const data = seg.subarray(headEnd + 4)
      const name = head.match(/name="([^"]*)"/)?.[1] || ''
      const filename = head.match(/filename="([^"]*)"/)?.[1] || ''
      const contentType = (head.match(/Content-Type:\s*(.+)/i)?.[1] || '').trim()
      if (name) out.push({ name, filename, contentType, data })
    }
    start = next
  }
  return out
}

function serveStatic(req, res, urlPath) {
  // 菜品图片存 data/img（不进 git），经 /img/ 前缀对外提供（中文菜名会带 %xx 编码，需解码）
  if (urlPath.startsWith('/img/')) {
    let rel = urlPath.slice(4)
    try { rel = decodeURIComponent(rel) } catch (e) { /* 非法编码按原样，交给 404 */ }
    const imgFile = path.normalize(path.join(IMG_DIR, rel))
    if (!imgFile.startsWith(IMG_DIR)) return fail(res, 403, 'forbidden')
    return fs.readFile(imgFile, (err, buf) => {
      if (err) return fail(res, 404, 'not found')
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(imgFile)] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      })
      res.end(buf)
    })
  }
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

/* 菜品图片文件名 = 菜名（清理非法字符），同名直接覆盖 */
function dishFileName(name, ext) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')   // 文件名非法字符
    .replace(/^\.+/, '')                   // 不能以点开头
    .trim()
    .slice(0, 20)
  return (clean || 'dish') + ext
}

/* 改菜名时把图片文件一并重命名，db.img 路径同步 */
function renameDishPhoto(d, newName) {
  if (!d.img || !d.img.startsWith('/img/')) return
  const oldName = path.basename(d.img)
  const newFname = dishFileName(newName, path.extname(oldName) || '.jpg')
  if (newFname === oldName) return   // 文件名没变（菜名相同或清后相同）
  const oldPath = path.join(IMG_DIR, oldName)
  const newPath = path.join(IMG_DIR, newFname)
  try {
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath)
    d.img = '/img/' + newFname
  } catch (e) { logErr('renameDishPhoto', e) }
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
  // 图片上传是 multipart，不能按 JSON 读
  const isUpload = p === '/api/admin/photo' && req.method === 'POST'
  const body = isUpload ? {} : (['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {})
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

  // 浏览器页面报错上报（app.js window.onerror），只记录不返回内容
  if (p === '/api/log' && req.method === 'POST') {
    const msg = String(body.msg || '').slice(0, 500)
    logErr('browser', msg || '(空消息)')
    return ok(res, {})
  }

  // 菜单（含每道菜的评分统计）
  if (p === '/api/menu' && req.method === 'GET') {
    const dishes = menuDishes().map(d => ({
      id: d.id, name: d.name, emoji: d.emoji, price: d.price,
      category: d.category, desc: d.desc, status: d.status,
      img: d.img || '',
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
    // 下单集合排除已下线（菜单里 off 仅展示，不可点）
    const menu = new Map(menuDishes().filter(d => d.status !== 'off').map(d => [d.id, d]))
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

  // 订单列表（公开：看单不需要登录，下单/取消/评价才需要；标注下单人昵称；按下单时间倒序）
  if (p === '/api/orders' && req.method === 'GET') {
    const list = db.orders.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(orderView)
    return ok(res, { list })
  }

  // 我的订单
  if (p === '/api/myorders' && req.method === 'GET') {
    const user = getUser(req)
    if (!user) return fail(res, 401, '登录后才能看订单')
    const list = db.orders.filter(o => o.uid === user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(orderView)
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
      return ok(res, { list: list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(orderView) })
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

    // 注册用户列表（只给店主，不返回密码哈希和 id）
    if (p === '/api/admin/users' && req.method === 'GET') {
      const list = db.users
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(u => ({ nickname: u.nickname, createdAt: u.createdAt }))
      return ok(res, { list })
    }

    // 上传菜品图片：multipart/form-data，字段 photo；文件名 = 菜名.jpg（仅店主）
    if (p === '/api/admin/photo' && req.method === 'POST') {
      const dishId = q.get('id') || ''
      const d = db.dishes.find(x => x.id === dishId)
      if (!d) return fail(res, 404, '菜品不存在')
      const boundary = (req.headers['content-type'] || '').match(/boundary=(.+)$/)?.[1]
      if (!boundary) return fail(res, 400, '不是表单上传')
      const buf = await readBodyBuffer(req)
      if (!buf.length) return fail(res, 400, '没收到文件')

      // 按 boundary 拆分，取第一个文件段的 Content-Type 和内容
      const parts = splitMultipart(buf, '--' + boundary)
      const file = parts.find(part => part.filename)
      if (!file) return fail(res, 400, '没找到图片字段')
      const extMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }
      const ext = extMime[file.contentType] || '.jpg'
      if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true })

      // 换图后删除旧文件，避免目录里堆没用的图
      if (d.img) {
        const oldPath = path.join(IMG_DIR, path.basename(d.img))
        fs.unlink(oldPath, () => {})
      }
      // 文件名跟菜名走，同名自动覆盖
      const fname = dishFileName(d.name, ext)
      fs.writeFileSync(path.join(IMG_DIR, fname), file.data)
      d.img = '/img/' + fname
      saveDB()
      return ok(res, { dish: d })
    }

    // 清除菜品图片
    if (p === '/api/admin/photo/clear' && req.method === 'POST') {
      const dishId = q.get('id') || ''
      const d = db.dishes.find(x => x.id === dishId)
      if (!d) return fail(res, 404, '菜品不存在')
      if (d.img) {
        fs.unlink(path.join(IMG_DIR, path.basename(d.img)), () => {})
        d.img = ''
        saveDB()
      }
      return ok(res, { dish: d })
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

    // 修改菜品（改菜名时，图片文件一并重命名，路径同步）
    if (p.match(/^\/api\/admin\/dish\/[\w-]+$/) && req.method === 'PUT') {
      const id = p.split('/')[4]
      const d = db.dishes.find(x => x.id === id)
      if (!d) return fail(res, 404, '菜品不存在')
      if (body.name !== undefined) {
        const newName = String(body.name).trim().slice(0, 20) || d.name
        if (newName !== d.name) {
          d.name = newName
          renameDishPhoto(d, newName)
        }
      }
      if (body.emoji !== undefined) d.emoji = String(body.emoji).slice(0, 8) || d.emoji
      if (body.img !== undefined) d.img = String(body.img).slice(0, 200)
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

    // 删除评价（店主）
    if (p.match(/^\/api\/admin\/review\/[\w-]+$/) && req.method === 'DELETE') {
      const id = p.split('/')[4]
      const i = db.reviews.findIndex(x => x.id === id)
      if (i < 0) return fail(res, 404, '评价不存在')
      db.reviews.splice(i, 1)
      saveDB()
      return ok(res, {})
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
      logErr('handleAPI ' + req.method + ' ' + urlObj.pathname, e)
      if (!res.headersSent) fail(res, 500, '服务器开小差了')
    })
  } else {
    // 静态文件/图片：回调风格，兜一层防连接挂死
    try {
      serveStatic(req, res, urlObj.pathname)
    } catch (e) {
      logErr('serveStatic ' + urlObj.pathname, e)
      if (!res.headersSent) fail(res, 500, '服务器开小差了')
      else res.end()
    }
  }
})

loadDB()
server.listen(PORT, () => {
  console.log(`jiojio厨房已开张：http://localhost:${PORT}`)
  console.log(`数据文件：${DB_FILE}`)
})
