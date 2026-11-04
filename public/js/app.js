/* ============================================================
 * 家常点菜网页版 - 前端逻辑（原生 JS，无框架）
 * 用户：勾选菜单 → 预约时间 → 下单
 * 店主：密码登录 → 管理订单/菜品（新上线·在售·已下线）/ 回复评价
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
  if (store.adminToken) headers['x-admin-token'] = store.adminToken
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.msg || '请求失败')
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
  get uid() { return localStorage.getItem('dc_uid') || '' },
  set uid(v) { localStorage.setItem('dc_uid', v) },
  get nickname() { return localStorage.getItem('dc_nick') || '' },
  set nickname(v) { localStorage.setItem('dc_nick', v) },
  get adminToken() { return localStorage.getItem('dc_admin') || '' },
  set adminToken(v) { localStorage.setItem('dc_admin', v) }
}
if (!store.uid) store.uid = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

/* ---------------- 视图切换 ---------------- */
const VIEWS = ['menu', 'orders', 'reviews', 'admin']
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
            ${d.desc ? `<div class="dish-desc">${esc(d.desc)}</div>` : ''}
            <div class="dish-price">${d.price}</div>
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
$('#go-order').addEventListener('click', showOrderModal)

/* ---------- 预约下单弹层 ---------- */
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

      <label class="field-label">你的称呼</label>
      <input class="input" id="order-nick" placeholder="名字或外号" value="${esc(store.nickname)}" maxlength="20">
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
    const nickname = $('#order-nick').value.trim()
    if (!nickname) return toast('填一下你的称呼')
    const mealTime = $('#meal-time').value
    if (!mealTime) return toast('选一下预约时间')

    const items = []
    selected.forEach((count, id) => items.push({ dishId: id, count }))

    const btn = $('#submit-order')
    btn.disabled = true
    try {
      const data = await api('/api/order', {
        method: 'POST',
        body: {
          uid: store.uid,
          nickname,
          items,
          mealDate: $('#chips-date .on')?.dataset.v || 'today',
          mealTime,
          note: $('#order-note').value.trim()
        }
      })
      store.uid = data.uid
      store.nickname = nickname
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
  try {
    const data = await api('/api/myorders?uid=' + encodeURIComponent(store.uid))
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
            ${o.status === 'completed' && !o.reviewed ? `<button class="btn btn-primary btn-sm" data-act="review" data-id="${o.id}">评价</button>` : ''}
          </div>
        </div>`
    }).join('')
  } catch (e) { toast(e.message) }
}

$('#orders-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  if (btn.dataset.act === 'cancel') cancelOrder(btn.dataset.id)
  if (btn.dataset.act === 'review') showReviewModal(btn.dataset.id)
})

async function cancelOrder(id) {
  if (!confirm('确定取消这个预约？')) return
  try {
    await api(`/api/order/${id}/cancel`, { method: 'POST', body: { uid: store.uid } })
    toast('已取消')
    loadMyOrders()
  } catch (e) { toast(e.message) }
}

/* ---------- 写评价 ---------- */
const RATING_TAGS = ['好吃', '下次还想吃', '份量足', '咸了', '淡了']

function showReviewModal(orderId) {
  openModal(`
    <div class="modal-title">评价这单 <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="card" style="text-align:center">
      <div id="rating-stars" style="font-size:36px;cursor:pointer;letter-spacing:6px">
        ${[1, 2, 3, 4, 5].map(i => `<span data-v="${i}" class="rstar" style="color:${i <= 5 ? '#FF8F1F' : '#E5E7EB'}">★</span>`).join('')}
      </div>
      <div class="stat-sub" id="rating-text" style="margin-top:4px">很好吃</div>
    </div>
    <div class="card">
      <div class="chips" id="chips-rtags">
        ${RATING_TAGS.map(t => `<button class="chip" data-v="${t}">${t}</button>`).join('')}
      </div>
      <textarea class="input" id="review-content" rows="3" placeholder="想说点什么～（选填）"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">算了</button>
      <button class="btn btn-primary" id="submit-review">提交评价</button>
    </div>
  `)

  let rating = 5
  $('#rating-stars').addEventListener('click', e => {
    const s = e.target.closest('.rstar')
    if (!s) return
    rating = parseInt(s.dataset.v)
    $('#rating-stars').querySelectorAll('.rstar').forEach(x =>
      x.style.color = parseInt(x.dataset.v) <= rating ? '#FF8F1F' : '#E5E7EB')
    $('#rating-text').textContent = ['', '不咋地', '一般', '还行', '好吃', '很好吃'][rating]
  })
  $('#chips-rtags').addEventListener('click', e => {
    const chip = e.target.closest('.chip')
    if (chip) chip.classList.toggle('on')
  })

  $('#submit-review').addEventListener('click', async () => {
    const tags = []
    $('#chips-rtags').querySelectorAll('.chip.on').forEach(c => tags.push(c.dataset.v))
    try {
      await api('/api/review', {
        method: 'POST',
        body: {
          uid: store.uid, orderId, rating, tags,
          content: $('#review-content').value.trim(),
          nickname: store.nickname
        }
      })
      closeModal()
      toast('感谢评价！')
      loadMyOrders()
    } catch (e) { toast(e.message) }
  })
}

/* ============================================================
 * 评价列表
 * ============================================================ */
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
      html += `<div class="empty">还没有评价</div>`
    } else {
      html += list.map(r => `
        <div class="card">
          <div class="review-head">
            <span class="review-name">${esc(r.nickname)}</span>
            <span class="review-time">${r.timeText}</span>
          </div>
          <div class="stars" style="font-size:15px">${starsHTML(r.rating)}</div>
          ${r.content ? `<div class="review-content">${esc(r.content)}</div>` : ''}
          ${r.tags.length ? `<div class="review-tags">${r.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${r.reply ? `<div class="review-reply">${esc(r.reply)}</div>` : ''}
        </div>`).join('')
    }
    $('#reviews-body').innerHTML = html
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
      const reply = prompt('回复内容（留空则清除）：', r?.reply || '')
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
      <label class="field-label">一句话介绍（选填）</label>
      <input class="input" id="d-desc" value="${esc(dish?.desc || '')}" maxlength="50" placeholder="比如：甜口的，朋友最爱">
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
      html = data.list.map(r => `
        <div class="card">
          <div class="review-head">
            <span class="review-name">${esc(r.nickname)}</span>
            <span class="review-time">${r.timeText}</span>
          </div>
          <div class="stars" style="font-size:15px">${starsHTML(r.rating)}</div>
          ${r.content ? `<div class="review-content">${esc(r.content)}</div>` : ''}
          ${r.tags.length ? `<div class="review-tags">${r.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${r.reply ? `<div class="review-reply">${esc(r.reply)}</div>` : ''}
          <div class="order-actions">
            <button class="btn btn-ghost btn-sm" data-act="reply" data-id="${r.id}">${r.reply ? '修改回复' : '回复'}</button>
          </div>
        </div>`).join('')
    }
    $('#admin-body').innerHTML = html
  } catch (e) { toast(e.message) }
}

/* ---------------- 启动 ---------------- */
window.closeModal = closeModal  // 供弹层内联按钮使用

function boot() {
  const hash = location.hash.replace('#', '')
  switchView(VIEWS.includes(hash) ? hash : 'menu')
}
window.addEventListener('hashchange', boot)
boot()
