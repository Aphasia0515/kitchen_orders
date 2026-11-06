/* ============================================================
 * jiojio厨房点菜网页版 - 前端逻辑（原生 JS，无框架）
 * 客人：登录 → 勾选菜单 → 预约时间 → 下单 → 按菜写评价
 * 店主：管理页密码登录 → 管理订单/菜品（新上线·在售·已下线）/ 回复评价
 * ============================================================ */

/* ---------------- 小工具 ---------------- */
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let toastTimer
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 2200)
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (store.userToken) headers['x-user-token'] = store.userToken
  if (store.adminToken) headers['x-admin-token'] = store.adminToken
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  const data = await res.json()
  if (!data.ok) {
    // 登录态失效：清掉本地身份，提示重新登录
    if (res.status === 401 && opts.onAuthExpired) opts.onAuthExpired()
    throw new Error(data.msg || '请求失败')
  }
  return data
}

function openModal(html) {
  $('#modal-card').innerHTML = html
  $('#modal').hidden = false
}
function closeModal() { $('#modal').hidden = true }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal() })

/* ---------------- 本地身份 ---------------- */
const store = {
  get userToken() { return localStorage.getItem('dc_token') || '' },
  set userToken(v) { localStorage.setItem('dc_token', v) },
  get user() { try { return JSON.parse(localStorage.getItem('dc_user')) || null } catch { return null } },
  set user(v) { localStorage.setItem('dc_user', JSON.stringify(v)) },
  get adminToken() { return localStorage.getItem('dc_admin') || '' },
  set adminToken(v) { localStorage.setItem('dc_admin', v) }
}

/* ---------------- 登录态 UI ---------------- */
function updateLoginUI() {
  const u = store.user
  $('#user-entry').innerHTML = u
    ? `<span class="user-avatar">${esc(u.nickname.slice(0, 1))}</span>${esc(u.nickname)}`
    : '登录 / 注册'
}

$('#user-entry').addEventListener('click', () => {
  if (store.user) showUserMenu()
  else showLoginModal()
})

function showUserMenu() {
  openModal(`
    <div class="modal-title">我的账号 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="card" style="text-align:center">
      <div class="user-avatar big">${esc(store.user.nickname.slice(0, 1))}</div>
      <div class="user-menu-name">${esc(store.user.nickname)}</div>
      <button class="btn btn-ghost btn-sm" id="logout-btn" style="margin-top:14px;color:var(--red)">退出登录</button>
    </div>
  `)
  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }) } catch (e) { /* 忽略 */ }
    store.userToken = ''
    store.user = null
    updateLoginUI()
    closeModal()
    toast('已退出')
    switchView('menu')
  })
}

/* ---------- 登录 / 注册弹层 ---------- */
function showLoginModal(afterLogin) {
  let mode = 'login'
  openModal(`
    <div class="modal-title" id="auth-title">客人登录 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="card">
      <label class="field-label">称呼（昵称）</label>
      <input class="input" id="auth-nick" maxlength="20" placeholder="名字或外号">
      <label class="field-label">密码</label>
      <input class="input" id="auth-pwd" type="password" maxlength="32" placeholder="至少 4 位">
      <button class="btn btn-primary btn-block" id="auth-submit">登录</button>
      <a class="login-mode-link" id="auth-toggle">没有账号？注册一个</a>
      <div class="login-tip">店主请在底部「管理」页用管理密码登录</div>
    </div>
  `)

  $('#auth-toggle').addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login'
    $('#auth-title').firstChild.textContent = mode === 'login' ? '客人登录 ' : '注册新账号 '
    $('#auth-submit').textContent = mode === 'login' ? '登录' : '注册并登录'
    $('#auth-toggle').textContent = mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录'
  })
  $('#auth-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth() })
  $('#auth-submit').addEventListener('click', doAuth)

  async function doAuth() {
    const nickname = $('#auth-nick').value.trim()
    const password = $('#auth-pwd').value
    if (!nickname) return toast('填一下称呼')
    if (password.length < 4) return toast('密码至少 4 位')
    const btn = $('#auth-submit')
    btn.disabled = true
    try {
      const data = await api('/api/auth/' + mode, { method: 'POST', body: { nickname, password } })
      store.userToken = data.token
      store.user = data.user
      updateLoginUI()
      closeModal()
      toast(mode === 'login' ? '欢迎回来，' + data.user.nickname : '注册成功，欢迎 ' + data.user.nickname)
      if (afterLogin) afterLogin()
    } catch (e) {
      btn.disabled = false
      toast(e.message)
    }
  }
}

/* ---------------- 视图切换 ---------------- */
const VIEWS = ['menu', 'orders', 'reviews', 'admin', 'dish']
let refreshTimer = null

function switchView(name) {
  VIEWS.forEach(v => { $('#view-' + v).hidden = v !== name })
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name))
  location.hash = name
  clearInterval(refreshTimer)

  if (name === 'menu') loadMenu()
  if (name === 'orders') { loadMyOrders(); refreshTimer = setInterval(loadMyOrders, 20000) }
  if (name === 'reviews') loadReviews()
  if (name === 'admin') initAdmin()
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)))

function starsHTML(score) {
  let s = ''
  for (let i = 1; i <= 5; i++) s += `<span class="${i <= Math.round(score) ? '' : 'off'}">★</span>`
  return s
}

/* ============================================================
 * 菜单（勾选点菜）
 * ============================================================ */
let menuDishes = []
const selected = new Map()   // dishId -> count（1~20）

async function loadMenu() {
  try {
    const data = await api('/api/menu')
    menuDishes = data.dishes
    // 清掉已下线的勾选
    Array.from(selected.keys()).forEach(id => {
      if (!menuDishes.find(d => d.id === id)) selected.delete(id)
    })
    renderMenu()
  } catch (e) { toast(e.message) }
}

function selTotal() {
  let n = 0, sum = 0
  selected.forEach((count, id) => {
    const d = menuDishes.find(x => x.id === id)
    if (d) { n += count; sum += d.price * count }
  })
  return { n, sum }
}

function renderMenu() {
  const groups = {}
  menuDishes.forEach(d => (groups[d.category] = groups[d.category] || []).push(d))

  let html = ''
  Object.entries(groups).forEach(([cat, dishes]) => {
    html += `<div class="cat-title">${esc(cat)}</div>`
    dishes.forEach(d => {
      const count = selected.get(d.id) || 0
      html += `
        <div class="dish-row ${count ? 'sel' : ''}" data-id="${d.id}">
          <div class="check"></div>
          <div class="dish-emoji">${esc(d.emoji)}</div>
          <div class="dish-info">
            <div class="dish-name">${esc(d.name)}${d.status === 'new' ? '<span class="badge-new">新上线</span>' : ''}</div>
            ${d.desc ? `<div class="dish-desc">材料：${esc(d.desc)}</div>` : ''}
            <div class="dish-price">${d.price}</div>
            <div class="dish-entry" data-act="dish-detail">
              ${d.rating ? `<span class="dish-rating">★${d.rating.avg}·${d.rating.count}</span>` : '<span class="dish-rating none">暂无评价</span>'}
              <span class="dish-entry-txt">看评价</span>
              <span class="dish-chev">›</span>
            </div>
          </div>
          ${count ? `
          <div class="qty">
            <button data-act="minus">−</button>
            <span class="num">${count}</span>
            <button data-act="plus">＋</button>
          </div>` : ''}
        </div>`
    })
  })
  if (!menuDishes.length) {
    html = `<div class="empty">菜单准备中<br>过来看看～</div>`
  }
  $('#menu-list').innerHTML = html

  const { n, sum } = selTotal()
  $('#order-bar').hidden = n === 0
  $('#sel-count').textContent = n
  $('#sel-total').textContent = sum
}

$('#menu-list').addEventListener('click', e => {
  // 点评分/「暂无评价」入口 → 进菜品详情页（不触发行勾选）
  const entry = e.target.closest('[data-act="dish-detail"]')
  if (entry) {
    const row = entry.closest('.dish-row')
    if (row) location.hash = 'dish/' + encodeURIComponent(row.dataset.id)
    return
  }

  const row = e.target.closest('.dish-row')
  if (!row) return
  const id = row.dataset.id
  const d = menuDishes.find(x => x.id === id)
  if (!d) return

  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'plus') {
    const cur = selected.get(id) || 1
    if (cur >= 20) return toast('最多 20 份')
    selected.set(id, cur + 1)
    renderMenu()
  } else if (act === 'minus') {
    const cur = selected.get(id) || 1
    if (cur <= 1) selected.delete(id)
    else selected.set(id, cur - 1)
    renderMenu()
  } else {
    // 点整行 = 勾选/取消勾选
    if (selected.has(id)) selected.delete(id)
    else selected.set(id, 1)
    renderMenu()
  }
})

$('#clear-sel').addEventListener('click', () => { selected.clear(); renderMenu() })
$('#go-order').addEventListener('click', () => {
  // 下单必须登录
  if (!store.user) return showLoginModal(() => showOrderModal())
  showOrderModal()
})

/* ---------- 预约下单弹层（称呼取自登录账号） ---------- */
function showOrderModal() {
  const { sum } = selTotal()
  const items = []
  selected.forEach((count, id) => {
    const d = menuDishes.find(x => x.id === id)
    if (d) items.push(`${esc(d.name)} × ${count}`)
  })

  // 默认预约时间：明天 18:30（晚上做饭留出准备时间）
  openModal(`
    <div class="modal-title">确认订单 <button class="modal-close" onclick="closeModal()">✕</button></div>

    <div class="card">
      <div style="font-size:14px;line-height:2">${items.join('<br>')}</div>
      <div class="order-total">合计 <b>¥${sum}</b></div>
    </div>

    <div class="card">
      <label class="field-label">预约日期</label>
      <div class="chips" id="chips-date">
        <button class="chip on" data-v="today">今天</button>
        <button class="chip" data-v="tomorrow">明天</button>
      </div>

      <label class="field-label">预约时间</label>
      <input type="time" class="input" id="meal-time" value="18:30">

      <label class="field-label">备注（人数、忌口、过敏、想说的都可以写）</label>
      <textarea class="input" id="order-note" rows="2" placeholder="比如：3 个人吃，不吃香菜"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">再改改</button>
      <button class="btn btn-primary" id="submit-order">提交预约</button>
    </div>
  `)

  $('#chips-date').addEventListener('click', e => {
    const chip = e.target.closest('.chip')
    if (!chip) return
    chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('on'))
    chip.classList.add('on')
  })

  $('#submit-order').addEventListener('click', async () => {
    const mealTime = $('#meal-time').value
    if (!mealTime) return toast('选一下预约时间')

    const items = []
    selected.forEach((count, id) => items.push({ dishId: id, count }))

    const btn = $('#submit-order')
    btn.disabled = true
    try {
      await api('/api/order', {
        method: 'POST',
        body: {
          items,
          mealDate: $('#chips-date .on')?.dataset.v || 'today',
          mealTime,
          note: $('#order-note').value.trim()
        },
        onAuthExpired() { store.userToken = ''; store.user = null; updateLoginUI() }
      })
      selected.clear()
      closeModal()
      toast('预约成功，等店主确认')
      switchView('orders')
    } catch (e) {
      btn.disabled = false
      toast(e.message)
    }
  })
}

/* ============================================================
 * 我的订单
 * ============================================================ */
const STATUS = {
  pending:   ['待确认', 'st-pending'],
  cooking:   ['制作中', 'st-cooking'],
  completed: ['已完成', 'st-completed'],
  rejected:  ['已婉拒', 'st-rejected'],
  cancelled: ['已取消', 'st-cancelled']
}

async function loadMyOrders() {
  if (!store.user) {
    $('#orders-list').innerHTML = `
      <div class="card login-hint">
        <div style="font-size:34px">🔐</div>
        <div style="margin-top:8px;font-weight:600">登录后才能看你的订单</div>
        <div class="stat-sub" style="margin-top:4px">下单和写评价都需要登录</div>
        <button class="btn btn-primary" style="margin-top:14px" data-act="login">登录 / 注册</button>
      </div>`
    return
  }
  try {
    const data = await api('/api/myorders', {
      onAuthExpired() { store.userToken = ''; store.user = null; updateLoginUI(); loadMyOrders() }
    })
    const list = data.list
    if (!list.length) {
      $('#orders-list').innerHTML = `<div class="empty">还没有订单<br>去「菜单」勾几道菜吧</div>`
      return
    }
    $('#orders-list').innerHTML = list.map(o => {
      const [txt, cls] = STATUS[o.status] || ['未知', 'st-cancelled']
      const items = o.items.map(i => `${esc(i.name)} × ${i.count}`).join('<br>')
      const mealText = `${o.mealDate === 'tomorrow' ? '明天' : '今天'} ${o.mealTime}`
      return `
        <div class="card">
          <div class="order-head">
            <span class="order-no">${o.timeText}</span>
            <span class="status-tag ${cls}">${txt}</span>
          </div>
          <div class="order-items">${items}</div>
          <div class="order-total">合计 <b>¥${o.total}</b></div>
          <div class="order-meta">🕒 预约 ${mealText}${o.note ? '<br>💬 ' + esc(o.note) : ''}${o.status === 'rejected' && o.rejectReason ? '<br>店主留言：' + esc(o.rejectReason) : ''}</div>
          <div class="order-actions">
            ${o.status === 'pending' ? `<button class="btn btn-ghost btn-sm" data-act="cancel" data-id="${o.id}">取消</button>` : ''}
            ${o.canReview ? `<button class="btn btn-primary btn-sm" data-act="review" data-id="${o.id}">评价</button>` : ''}
          </div>
        </div>`
    }).join('')
  } catch (e) { toast(e.message) }
}

$('#orders-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  if (btn.dataset.act === 'login') return showLoginModal(() => loadMyOrders())
  if (btn.dataset.act === 'cancel') cancelOrder(btn.dataset.id)
  if (btn.dataset.act === 'review') {
    // 找到当前列表里的订单对象，传给评价弹层（需要 items / reviewedIds）
    api('/api/myorders', {
      onAuthExpired() { store.userToken = ''; store.user = null; updateLoginUI() }
    }).then(data => {
      const o = data.list.find(x => x.id === btn.dataset.id)
      if (o) showReviewModal(o)
    }).catch(e2 => toast(e2.message))
  }
})

async function cancelOrder(id) {
  if (!confirm('确定取消这个预约？')) return
  try {
    await api(`/api/order/${id}/cancel`, { method: 'POST' })
    toast('已取消')
    loadMyOrders()
  } catch (e) { toast(e.message) }
}

/* ============================================================
 * 写评价（按菜打分，一菜一评）
 * ============================================================ */
function showReviewModal(order) {
  // 只显示还没评价过的菜
  const toRate = order.items.filter(i => !(order.reviewedIds || []).includes(i.dishId))
  if (!toRate.length) return toast('这单的菜都评价过啦')

  openModal(`
    <div class="modal-title">逐道菜评价 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="stat-sub" style="margin-bottom:8px">给每道菜打个分（默认 5 星），想说的话选填</div>
    ${toRate.map(i => `
      <div class="card rate-row" data-dish="${i.dishId}">
        <div class="rate-dish">
          <span class="dish-name">${esc(i.emoji)} ${esc(i.name)}</span>
          <span class="rate-stars">${[1, 2, 3, 4, 5].map(n => `<span class="on" data-v="${n}">★</span>`).join('')}</span>
        </div>
        <input class="input rate-comment" maxlength="200" placeholder="这道菜想说的话（选填）">
      </div>`).join('')}
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">算了</button>
      <button class="btn btn-primary" id="submit-review">提交评价</button>
    </div>
  `)

  // 打星
  $('#modal-card').querySelectorAll('.rate-row').forEach(row => {
    row.querySelector('.rate-stars').addEventListener('click', e => {
      const s = e.target.closest('[data-v]')
      if (!s) return
      const v = parseInt(s.dataset.v)
      row.querySelectorAll('.rate-stars span').forEach(x =>
        x.classList.toggle('on', parseInt(x.dataset.v) <= v))
    })
  })

  $('#submit-review').addEventListener('click', async () => {
    const ratings = []
    $('#modal-card').querySelectorAll('.rate-row').forEach(row => {
      const stars = row.querySelectorAll('.rate-stars .on').length || 5
      ratings.push({
        dishId: row.dataset.dish,
        rating: stars,
        content: row.querySelector('.rate-comment').value.trim()
      })
    })
    const btn = $('#submit-review')
    btn.disabled = true
    try {
      await api('/api/review', {
        method: 'POST',
        body: { orderId: order.id, ratings },
        onAuthExpired() { store.userToken = ''; store.user = null; updateLoginUI() }
      })
      closeModal()
      toast('感谢评价！')
      loadMyOrders()
    } catch (e) {
      btn.disabled = false
      toast(e.message)
    }
  })
}

/* ============================================================
 * 评价
 * ============================================================ */
function reviewCardHTML(r, withReplyBtn) {
  return `
    <div class="card">
      <div class="review-head">
        <span class="review-name">${esc(r.nickname)}</span>
        <span class="review-time">${r.timeText}</span>
      </div>
      <div style="margin-top:6px">
        ${r.dishName ? `<span class="review-dish">${esc(r.emoji || '')} ${esc(r.dishName)}</span>` : ''}
        <span class="stars" style="font-size:15px">${starsHTML(r.rating)}</span>
      </div>
      ${r.content ? `<div class="review-content">${esc(r.content)}</div>` : ''}
      ${r.reply ? `<div class="review-reply">${esc(r.reply)}</div>` : ''}
      ${withReplyBtn ? `
      <div class="order-actions">
        <button class="btn btn-ghost btn-sm" data-act="reply" data-id="${r.id}">${r.reply ? '修改回复' : '回复'}</button>
      </div>` : ''}
    </div>`
}

async function loadReviews() {
  try {
    const data = await api('/api/reviews')
    const { stat, list } = data
    let html = `
      <div class="card stat-card">
        <div style="text-align:center">
          <div class="stat-avg">${stat.avg}</div>
          <div class="stat-sub">${stat.total} 条评价</div>
        </div>
        <div>
          <div class="stars">${starsHTML(parseFloat(stat.avg))}</div>
          <div class="stat-sub" style="margin-top:6px">${stat.goodRate}% 好评</div>
        </div>
      </div>`
    if (!list.length) {
      html += `<div class="empty">还没有评价<br>吃完记得来打分呀</div>`
    } else {
      html += list.map(r => reviewCardHTML(r, false)).join('')
    }
    $('#reviews-body').innerHTML = html
  } catch (e) { toast(e.message) }
}

/* ---------- 菜品详情页（每道菜都能点进去看评价） ---------- */
function showDishView(id) {
  VIEWS.forEach(v => { $('#view-' + v).hidden = v !== 'dish' })
  // 详情页是菜单的子页，底部「菜单」保持高亮
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'menu'))
  clearInterval(refreshTimer)
  loadDishDetail(id)
}

async function loadDishDetail(id) {
  const body = $('#dish-body')
  body.innerHTML = '<div class="empty">加载中…</div>'
  try {
    // 直接打开/刷新 #dish/xx 时菜单还没加载过，先补一次
    if (!menuDishes.length) {
      const m = await api('/api/menu')
      menuDishes = m.dishes
    }
    const d = menuDishes.find(x => x.id === id)
    if (!d) {
      body.innerHTML = '<div class="empty">菜品不存在或已下线<br><a class="back-link" href="#menu">← 返回菜单</a></div>'
      return
    }
    const { stat, list } = await api('/api/dish-reviews?id=' + encodeURIComponent(id))

    let html = `
      <div class="card dish-hero">
        <div class="dish-hero-emoji">${esc(d.emoji)}</div>
        <div class="dish-hero-info">
          <div class="dish-hero-name">${esc(d.name)}${d.status === 'new' ? '<span class="badge-new">新上线</span>' : ''}</div>
          <div class="dish-hero-sub">${esc(d.category)} · <b>¥${d.price}</b></div>
          ${d.desc ? `<div class="dish-hero-desc">材料：${esc(d.desc)}</div>` : ''}
        </div>
      </div>
      <div class="card stat-card">
        <div style="text-align:center">
          <div class="stat-avg">${stat ? stat.avg : '—'}</div>
          <div class="stat-sub">${esc(d.name)}的评分</div>
        </div>
        <div>
          <div class="stars">${starsHTML(stat ? parseFloat(stat.avg) : 0)}</div>
          <div class="stat-sub" style="margin-top:6px">${stat ? stat.count + ' 人评过' : '还没有评价'}</div>
        </div>
      </div>`
    if (!list.length) {
      html += '<div class="empty" style="padding:30px 0">这道菜还没有评价<br>吃完记得来打分呀</div>'
    } else {
      html += list.map(r => reviewCardHTML(r, false)).join('')
    }
    body.innerHTML = html
  } catch (e) { toast(e.message) }
}

/* ============================================================
 * 店主管理后台
 * ============================================================ */
let adminTab = 'orders'
let adminDishes = []

async function initAdmin() {
  if (!store.adminToken) return showAdminLogin()
  try {
    await api('/api/admin/orders?status=all')
    showAdminPanel()
  } catch (e) {
    store.adminToken = ''
    showAdminLogin()
  }
}

function showAdminLogin() {
  $('#admin-login').hidden = false
  $('#admin-panel').hidden = true
}
function showAdminPanel() {
  $('#admin-login').hidden = true
  $('#admin-panel').hidden = false
  setAdminTab(adminTab)
}

$('#admin-login-btn').addEventListener('click', adminLogin)
$('#admin-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin() })

async function adminLogin() {
  const pwd = $('#admin-pwd').value
  if (!pwd) return toast('输入管理密码')
  try {
    const data = await api('/api/admin/login', { method: 'POST', body: { password: pwd } })
    store.adminToken = data.token
    showAdminPanel()
  } catch (e) { toast(e.message) }
}

document.querySelectorAll('.atab').forEach(t => t.addEventListener('click', () => setAdminTab(t.dataset.atab)))

function setAdminTab(name) {
  adminTab = name
  document.querySelectorAll('.atab').forEach(t => t.classList.toggle('active', t.dataset.atab === name))
  clearInterval(refreshTimer)
  if (name === 'orders') { loadAdminOrders(); refreshTimer = setInterval(loadAdminOrders, 15000) }
  if (name === 'dishes') loadAdminDishes()
  if (name === 'reviews') loadAdminReviews()
}

/* ---------- 订单管理 ---------- */
async function loadAdminOrders() {
  try {
    const data = await api('/api/admin/orders?status=all')
    const list = data.list
    const pending = list.filter(o => o.status === 'pending').length

    let html = pending ? `<div class="pend-tip">🔔 ${pending} 个新预约待确认</div>` : ''
    if (!list.length) html += `<div class="empty">还没有订单</div>`
    html += list.map(o => {
      const [txt, cls] = STATUS[o.status] || ['未知', 'st-cancelled']
      const items = o.items.map(i => `${esc(i.name)} × ${i.count}`).join('<br>')
      const mealText = `${o.mealDate === 'tomorrow' ? '明天' : '今天'} ${o.mealTime}`
      return `
        <div class="card">
          <div class="order-head">
            <span class="review-name">${esc(o.nickname)}</span>
            <span class="status-tag ${cls}">${txt}</span>
          </div>
          <div class="order-items">${items}</div>
          <div class="order-total">合计 <b>¥${o.total}</b></div>
          <div class="order-meta">🕒 预约 ${mealText}${o.note ? '<br>💬 ' + esc(o.note) : ''}</div>
          <div class="order-no" style="margin-top:6px">${o.timeText}</div>
          <div class="order-actions">
            ${o.status === 'pending' ? `
              <button class="btn btn-ghost btn-sm" data-act="reject" data-id="${o.id}">婉拒</button>
              <button class="btn btn-primary btn-sm" data-act="accept" data-id="${o.id}">接单</button>` : ''}
            ${o.status === 'cooking' ? `<button class="btn btn-primary btn-sm" data-act="complete" data-id="${o.id}">标记完成</button>` : ''}
          </div>
        </div>`
    }).join('')
    $('#admin-body').innerHTML = html
  } catch (e) { toast(e.message) }
}

$('#admin-body').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const { act, id } = btn.dataset

  // 订单操作
  if (act === 'accept' || act === 'complete' || act === 'reject') {
    try {
      if (act === 'accept') {
        await api(`/api/admin/order/${id}/status`, { method: 'POST', body: { status: 'cooking' } })
      } else if (act === 'complete') {
        await api(`/api/admin/order/${id}/status`, { method: 'POST', body: { status: 'completed' } })
      } else {
        const reason = prompt('婉拒原因（朋友能看到，可留空）：')
        if (reason === null) return
        await api(`/api/admin/order/${id}/status`, { method: 'POST', body: { status: 'rejected', reason } })
      }
      loadAdminOrders()
    } catch (e2) { toast(e2.message) }
    return
  }

  // 菜品操作
  if (act === 'add-dish') return showDishModal(null)
  if (act === 'edit-dish') {
    const d = adminDishes.find(x => x.id === id)
    if (d) showDishModal(d)
    return
  }
  if (act === 'set-status') {
    try {
      await api(`/api/admin/dish/${id}`, { method: 'PUT', body: { status: btn.dataset.v } })
      loadAdminDishes()
    } catch (e2) { toast(e2.message) }
    return
  }
  if (act === 'reply') {
    try {
      const r = (await api('/api/reviews')).list.find(x => x.id === id)
      const reply = prompt(`回复「${r?.dishName || ''}」的评价（留空则清除）：`, r?.reply || '')
      if (reply === null) return
      await api(`/api/admin/review/${id}/reply`, { method: 'POST', body: { reply } })
      loadAdminReviews()
    } catch (e2) { toast(e2.message) }
  }
})

/* ---------- 菜品管理 ---------- */
const DISH_STATUS = { new: ['新上线', 'bs-new'], on: ['在售', 'bs-on'], off: ['已下线', 'bs-off'] }

async function loadAdminDishes() {
  try {
    const data = await api('/api/admin/dishes')
    adminDishes = data.list

    let html = `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px">
        <span class="stat-sub">共 ${adminDishes.length} 道菜 · 在售 ${adminDishes.filter(d => d.status !== 'off').length} 道</span>
        <button class="btn btn-primary btn-sm" data-act="add-dish">＋ 新增菜品</button>
      </div>`

    if (!adminDishes.length) html += `<div class="empty">还没有菜品，点右上角新增</div>`

    html += adminDishes.map(d => {
      const [stTxt, stCls] = DISH_STATUS[d.status] || DISH_STATUS.on
      return `
      <div class="card dish-mgr-row">
        <div class="dish-emoji" style="background:#F5F6F7">${esc(d.emoji)}</div>
        <div class="dish-mgr-info">
          <div class="dish-mgr-name">${esc(d.name)}<span class="badge-status ${stCls}">${stTxt}</span></div>
          <div class="dish-mgr-sub">${esc(d.category)} · ¥${d.price}${d.desc ? ' · ' + esc(d.desc) : ''}</div>
        </div>
        <div class="dish-mgr-acts">
          <div class="row">
            ${d.status === 'off'
              ? `<button class="btn-text" data-act="set-status" data-v="on" data-id="${d.id}">重新上架</button>`
              : `<button class="btn-text" data-act="set-status" data-v="new" data-id="${d.id}">设为新上线</button>
                 <button class="btn-text gray" data-act="set-status" data-v="off" data-id="${d.id}">下线</button>`}
          </div>
          <div class="row">
            <button class="btn-text gray" data-act="edit-dish" data-id="${d.id}">编辑</button>
          </div>
        </div>
      </div>`
    }).join('')
    $('#admin-body').innerHTML = html
  } catch (e) { toast(e.message) }
}

function showDishModal(dish) {
  const isEdit = !!dish
  const st = dish?.status || 'on'
  openModal(`
    <div class="modal-title">${isEdit ? '编辑菜品' : '新增菜品'} <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="card">
      <label class="field-label">菜名</label>
      <input class="input" id="d-name" value="${esc(dish?.name || '')}" maxlength="20" placeholder="比如：可乐鸡翅">
      <label class="field-label">图标（一个 emoji，选填）</label>
      <input class="input" id="d-emoji" value="${esc(dish?.emoji || '')}" maxlength="4" placeholder="🍗">
      <label class="field-label">价格（¥）</label>
      <input class="input" id="d-price" type="number" step="0.5" min="0.5" value="${dish?.price || ''}" placeholder="20">
      <label class="field-label">分类</label>
      <input class="input" id="d-category" value="${esc(dish?.category || '')}" maxlength="10" placeholder="荤菜 / 素菜 / 主食 / 饮品">
      <label class="field-label">材料（选填）</label>
      <input class="input" id="d-desc" value="${esc(dish?.desc || '')}" maxlength="50" placeholder="比如：鸡蛋、火腿肠、土豆">
      <label class="field-label">状态</label>
      <div class="chips" id="chips-status">
        <button class="chip ${st === 'new' ? 'on' : ''}" data-v="new">新上线</button>
        <button class="chip ${st === 'on' ? 'on' : ''}" data-v="on">在售</button>
        <button class="chip ${st === 'off' ? 'on' : ''}" data-v="off">已下线</button>
      </div>
    </div>
    <div class="modal-actions">
      ${isEdit ? '<button class="btn btn-ghost" id="del-dish" style="color:var(--red)">删除</button>' : ''}
      <button class="btn btn-primary" id="save-dish">保存</button>
    </div>
  `)

  $('#chips-status').addEventListener('click', e => {
    const chip = e.target.closest('.chip')
    if (!chip) return
    chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('on'))
    chip.classList.add('on')
  })

  $('#save-dish').addEventListener('click', async () => {
    const body = {
      name: $('#d-name').value.trim(),
      emoji: $('#d-emoji').value.trim() || '🍽️',
      price: parseFloat($('#d-price').value),
      category: $('#d-category').value.trim() || '家常菜',
      desc: $('#d-desc').value.trim(),
      status: $('#chips-status .on')?.dataset.v || 'on'
    }
    try {
      if (isEdit) await api(`/api/admin/dish/${dish.id}`, { method: 'PUT', body })
      else await api('/api/admin/dish', { method: 'POST', body })
      closeModal()
      toast('已保存')
      loadAdminDishes()
    } catch (e) { toast(e.message) }
  })

  if (isEdit) {
    $('#del-dish').addEventListener('click', async () => {
      if (!confirm(`确定删除「${dish.name}」？历史订单不受影响。`)) return
      try {
        await api(`/api/admin/dish/${dish.id}`, { method: 'DELETE' })
        closeModal()
        toast('已删除')
        loadAdminDishes()
      } catch (e) { toast(e.message) }
    })
  }
}

/* ---------- 评价管理 ---------- */
async function loadAdminReviews() {
  try {
    const data = await api('/api/reviews')
    let html = ''
    if (!data.list.length) {
      html = `<div class="empty">还没有评价</div>`
    } else {
      html = data.list.map(r => reviewCardHTML(r, true)).join('')
    }
    $('#admin-body').innerHTML = html
  } catch (e) { toast(e.message) }
}

/* ---------------- 启动 ---------------- */
window.closeModal = closeModal  // 供弹层内联按钮使用

function boot() {
  updateLoginUI()
  const hash = location.hash.replace('#', '')
  // 菜品详情页是带参数 hash（#dish/d1），由 hashchange 统一驱动，不走 switchView 避免重复加载
  if (hash.startsWith('dish')) {
    return showDishView(hash.startsWith('dish/') ? decodeURIComponent(hash.slice(5)) : '')
  }
  switchView(VIEWS.includes(hash) ? hash : 'menu')
}
window.addEventListener('hashchange', boot)
boot()
