'use strict';

const state = {
  token: localStorage.getItem('pc.token') || null,
  user: null, socket: null,
  view: 'main', chat: null,
  friends: [], channels: [], presence: Object.create(null), requests: [],
  authMode: 'login',
};

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

/* ---------- Custom Modal (Glassmorphism) ---------- */
function showModal(title, contentNode) {
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const modal = el('div', { class: 'glass-modal' },
    el('div', { class: 'modal-header' },
      el('h3', null, title),
      el('button', { class: 'modal-close', onclick: () => overlay.remove() }, '✕')
    ),
    el('div', { class: 'modal-body' }, contentNode)
  );
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'parse_error' }));
  if (!res.ok) throw new Error(data.error || 'request_failed');
  return data;
}

(async function boot() {
  if (state.token) {
    try {
      state.user = await api('GET', '/me');
      await connectSocket();
      await Promise.all([loadFriends(), loadChannels(), loadRequests()]);
      render();
      return;
    } catch {
      state.token = null; localStorage.removeItem('pc.token');
    }
  }
  renderAuth();
})();

function connectSocket() {
  return new Promise((resolve) => {
    state.socket = io({ auth: { token: state.token }, transports: ['websocket', 'polling'] });
    state.socket.on('connect', () => resolve());
    state.socket.on('connect_error', () => resolve());

    state.socket.on('presence:update', ({ userId, online }) => {
      state.presence[userId] = online;
      if (state.view === 'main') renderMainList();
    });
    state.socket.on('friend:request', async () => { await loadRequests(); render(); });
    state.socket.on('friend:response', async () => { await loadFriends(); render(); });
    state.socket.on('message:dm', ({ message }) => {
      if (state.view === 'chat') appendMessage(message);
    });
    state.socket.on('message:channel', ({ message }) => {
      if (state.view === 'chat') appendMessage(message);
    });
    state.socket.on('user:updated', ({ userId, displayName, username }) => {
      const f = state.friends.find(x => x.id === userId);
      if (f) { f.displayName = displayName; f.username = username; }
      render();
    });
  });
}

async function loadFriends() { state.friends = (await api('GET', '/friends')).friends; }
async function loadChannels() { state.channels = (await api('GET', '/channels')).channels; }
async function loadRequests() { state.requests = (await api('GET', '/friends/requests')).requests; }

function renderAuth() {
  const app = $('#app'); app.innerHTML = '';
  const card = el('div', { class: 'auth-card' },
    el('h1', null, 'Presence Chat'),
    el('div', { class: 'tabs' },
      el('button', { class: 'tab active', onclick: onTab, 'data-tab': 'login' }, 'دخول'),
      el('button', { class: 'tab', onclick: onTab, 'data-tab': 'register' }, 'تسجيل')
    ),
    el('form', { class: 'auth-form', onsubmit: onAuthSubmit },
      el('div', { class: 'field', id: 'f-name', style: 'display:none' },
        el('label', null, 'الاسم الظاهر'),
        el('input', { name: 'displayName', type: 'text' })
      ),
      el('div', { class: 'field' }, el('label', null, 'اسم المستخدم'), el('input', { name: 'username', type: 'text', required: true })),
      el('div', { class: 'field' }, el('label', null, 'كلمة المرور'), el('input', { name: 'password', type: 'password', required: true })),
      el('button', { type: 'submit', class: 'btn primary', style: 'width:100%' }, 'دخول')
    ),
    el('div', { class: 'err', id: 'auth-err' })
  );
  app.appendChild(card);
}

function onTab(e) {
  state.authMode = e.target.dataset.tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.authMode));
  $('#f-name').style.display = state.authMode === 'register' ? 'block' : 'none';
  document.querySelector('.auth-form button[type="submit"]').textContent = state.authMode === 'register' ? 'تسجيل' : 'دخول';
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  try {
    const path = state.authMode === 'login' ? '/login' : '/register';
    const r = await api('POST', path, body);
    state.token = r.token; localStorage.setItem('pc.token', r.token); state.user = r.user;
    await connectSocket();
    await Promise.all([loadFriends(), loadChannels(), loadRequests()]);
    render();
  } catch (err) { $('#auth-err').textContent = err.message; }
}

function render() {
  const app = $('#app'); app.innerHTML = '';
  const shell = el('div', { class: 'shell' },
    el('header', { class: 'header' },
      el('div', { class: 'brand' }, 'Presence Chat'),
      el('div', { class: 'me' }, el('span', { class: 'dot' }), el('span', null, state.user.username))
    ),
    el('main', { class: 'content', id: 'content' }),
    el('nav', { class: 'bottom-nav' },
      el('button', { class: 'nav-btn' + (state.view === 'main' ? ' active' : ''), onclick: () => switchView('main') }, 'الرئيسية'),
      el('button', { class: 'nav-btn' + (state.view === 'add' ? ' active' : ''), onclick: () => switchView('add') }, 'إضافة'),
      el('button', { class: 'nav-btn' + (state.view === 'requests' ? ' active' : ''), onclick: () => switchView('requests') }, 'الطلبات'),
      el('button', { class: 'nav-btn' + (state.view === 'settings' ? ' active' : ''), onclick: () => switchView('settings') }, 'الإعدادات')
    )
  );
  app.appendChild(shell);

  if (state.view === 'main') renderMain();
  else if (state.view === 'add') renderAdd();
  else if (state.view === 'requests') renderRequests();
  else if (state.view === 'settings') renderSettings();
  else if (state.view === 'admin') renderAdmin();
  else if (state.view === 'chat') renderChat();
}

function switchView(v) { state.view = v; render(); }

function renderMain() {
  const c = $('#content'); c.innerHTML = '';
  c.appendChild(el('div', { class: 'search-bar' }, el('input', { type: 'search', class: 'search-input', placeholder: 'بحث', oninput: (e) => renderMainList(e.target.value) })));
  c.appendChild(el('div', { class: 'list', id: 'main-list' }));
  renderMainList();
}

function renderMainList(filter = '') {
  const list = $('#main-list'); if (!list) return; list.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();

  const friends = state.friends.filter(fr => fr.displayName.toLowerCase().includes(f) || fr.username.toLowerCase().includes(f));
  const fs = el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'الأصدقاء'));
  for (const fr of friends) {
    fs.appendChild(el('div', { class: 'item', onclick: () => openChat('user', fr.id, fr.displayName) },
      el('div', { class: 'avatar' + (state.presence[fr.id] ? ' online' : '') }, fr.displayName.charAt(0).toUpperCase()),
      el('div', { class: 'item-body' }, el('div', { class: 'item-name' }, fr.displayName), el('div', { class: 'item-sub' }, state.presence[fr.id] ? 'متوفر الآن' : 'غير متوفر'))
    ));
  }
  list.appendChild(fs);

  const cs = el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'القنوات العامة'));
  for (const ch of state.channels) {
    cs.appendChild(el('div', { class: 'item', onclick: () => openChat('channel', ch.id, '#' + ch.name) },
      el('div', { class: 'channel-icon' }, '#'),
      el('div', { class: 'item-body' }, el('div', { class: 'item-name' }, ch.name))
    ));
  }
  list.appendChild(cs);
}

function renderRequests() {
  const c = $('#content'); c.innerHTML = '';
  c.appendChild(el('h3', { class: 'section-title' }, 'طلبات الصداقة'));
  const list = el('div', { class: 'list' });
  if (!state.requests.length) list.appendChild(el('div', { class: 'empty' }, 'لا توجد طلبات جديدة'));
  for (const r of state.requests) {
    list.appendChild(el('div', { class: 'item' },
      el('div', { class: 'avatar' }, r.display_name.charAt(0).toUpperCase()),
      el('div', { class: 'item-body' }, el('div', { class: 'item-name' }, r.display_name), el('div', { class: 'item-sub' }, '@' + r.username)),
      el('div', { class: 'actions' },
        el('button', { class: 'btn small primary', onclick: () => respondRequest(r.id, 'accept') }, 'قبول'),
        el('button', { class: 'btn small danger', onclick: () => respondRequest(r.id, 'reject') }, 'رفض')
      )
    ));
  }
  c.appendChild(list);
}

async function respondRequest(id, action) {
  await api('POST', '/friends/respond', { requestId: id, action });
  await Promise.all([loadRequests(), loadFriends()]);
  render();
}

function renderAdd() {
  const c = $('#content'); c.innerHTML = '';
  c.appendChild(el('div', { class: 'search-bar' }, el('input', { type: 'search', class: 'search-input', placeholder: 'بحث', oninput: debounce(async (e) => {
    const q = e.target.value.trim(); const host = $('#add-results'); host.innerHTML = '';
    if (q.length < 2) return;
    const r = await api('GET', '/users/search?q=' + encodeURIComponent(q));
    for (const u of r.results) {
      const btn = u.relationship?.status === 'pending' ? el('button', { class: 'btn small', disabled: true }, 'معلق') : el('button', { class: 'btn small primary', onclick: () => api('POST', '/friends/request', { userId: u.id }).then(() => alert('تم الإرسال')) }, 'إضافة');
      host.appendChild(el('div', { class: 'profile-card' }, el('div', { class: 'profile-name' }, u.displayName), el('div', { class: 'profile-user' }, '@' + u.username), btn));
    }
  }, 300) })));
  c.appendChild(el('div', { class: 'list', id: 'add-results', html: '<div class="empty">اكتب يوزرنيم صديقك</div>' }));
}

function renderSettings() {
  const c = $('#content'); c.innerHTML = '';
  
  // Profile Box
  const profileBox = el('div', { class: 'profile-card' },
    el('div', { class: 'profile-name' }, state.user.displayName),
    el('div', { class: 'profile-user' }, '@' + state.user.username),
    el('button', { class: 'btn small', onclick: () => renderEditProfile() }, 'تعديل')
  );
  c.appendChild(el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'ملفي الشخصي'), profileBox));

  // Options
  c.appendChild(el('div', { class: 'section' },
    el('h3', { class: 'section-title' }, 'الدعم'),
    el('div', { class: 'item', onclick: () => showModal('سياسة الخصوصية', el('p', null, 'نحن نحترم خصوصيتك تماماً. جميع بياناتك محمية ومشفرة، ولا نشاركها مع أي طرف ثالث تحت أي ظرف. أنت المتحكم الوحيد في بياناتك.')) }, 'سياسة الخصوصية'),
    el('div', { class: 'item', onclick: () => promptReport() }, 'الدعم الفني والبلاغات')
  ));

  // Admin
  if (state.user.role === 'admin') {
    c.appendChild(el('div', { class: 'section' },
      el('h3', { class: 'section-title' }, 'الإدارة'),
      el('div', { class: 'item', onclick: () => switchView('admin') }, 'لوحة التحكم (صانع التطبيق)')
    ));
  } else {
    c.appendChild(el('div', { class: 'section' },
      el('h3', { class: 'section-title' }, 'دخول الإدارة'),
      el('div', { class: 'item' }, el('input', { type: 'password', class: 'search-input', placeholder: 'كلمة مرور الإدارة', onchange: async (e) => {
        if (!e.target.value) return;
        try {
          const r = await api('POST', '/admin/login', { password: e.target.value });
          state.token = r.token; localStorage.setItem('pc.token', r.token); state.user.role = 'admin';
          showModal('تم التفعيل', el('p', null, 'تم تفعيل وضع الإدارة بنجاح.'));
          render();
        } catch { showModal('خطأ', el('p', null, 'كلمة المرور خاطئة.')); }
      } }))
    ));
  }

  // Logout
  c.appendChild(el('div', { class: 'section' },
    el('div', { class: 'item', style: 'color:#e5484d', onclick: () => { localStorage.clear(); location.reload(); } }, 'تسجيل الخروج')
  ));
}

function renderEditProfile() {
  const c = $('#content'); c.innerHTML = '';
  c.appendChild(el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'تعديل الملف الشخصي')));
  const form = el('form', { class: 'profile-card', onsubmit: async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api('POST', '/user/update', data);
      state.token = r.token; localStorage.setItem('pc.token', r.token); state.user = r.user;
      showModal('تم الحفظ', el('p', null, 'تم تحديث بياناتك بنجاح.')); switchView('settings');
    } catch (err) { showModal('خطأ', el('p', null, err.message)); }
  }},
    el('div', { class: 'field' }, el('label', null, 'الاسم الجديد'), el('input', { name: 'displayName', value: state.user.displayName, required: true })),
    el('div', { class: 'field' }, el('label', null, 'اليوزرنيم الجديد'), el('input', { name: 'username', value: state.user.username, required: true })),
    el('div', { class: 'profile-actions' },
      el('button', { type: 'submit', class: 'btn primary' }, 'حفظ'),
      el('button', { type: 'button', class: 'btn', onclick: () => switchView('settings') }, 'إلغاء')
    )
  );
  c.appendChild(form);
}

function promptReport() {
  const form = el('form', { class: 'field', onsubmit: async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('POST', '/reports', data);
      document.querySelector('.modal-overlay').remove();
      showModal('تم الإرسال', el('p', null, 'تم استلام بلاغك وسيتم مراجعته من قبل الإدارة.'));
    } catch (err) { showModal('خطأ', el('p', null, err.message)); }
  }},
    el('div', { class: 'field' }, el('label', null, 'موضوع البلاغ'), el('input', { name: 'subject', required: true })),
    el('div', { class: 'field' }, el('label', null, 'التفاصيل'), el('textarea', { name: 'message', required: true, rows: 4 })),
    el('button', { type: 'submit', class: 'btn primary', style: 'width:100%; margin-top:8px;' }, 'إرسال البلاغ')
  );
  showModal('الدعم الفني', form);
}

async function renderAdmin() {
  const c = $('#content'); c.innerHTML = '';
  c.appendChild(el('h3', { class: 'section-title' }, 'لوحة تحكم الإدارة'));
  try {
    const r = await api('GET', '/admin/dashboard');
    c.appendChild(el('div', { class: 'section' }, el('h4', null, 'المستخدمين'), el('div', { class: 'list' }, r.users.map(u => el('div', { class: 'item' }, u.display_name, ' @' + u.username)))));
    c.appendChild(el('div', { class: 'section' }, el('h4', null, 'البلاغات'), el('div', { class: 'list' }, r.reports.map(rep => el('div', { class: 'item' }, rep.subject, ' - ', rep.message)))));
  } catch (err) {
    c.appendChild(el('div', { class: 'empty' }, 'غير مصرح لك'));
  }
}

async function openChat(type, id, name) {
  state.chat = { type, id, name }; state.view = 'chat'; render();
  const path = type === 'user' ? `/messages/dm/${id}` : `/messages/channel/${id}`;
  const r = await api('GET', path); $('#messages').innerHTML = ''; for (const m of r.messages) appendMessage(m);
}

function renderChat() {
  const c = $('#content'); c.innerHTML = '';
  c.appendChild(el('div', { class: 'chat-header' }, el('button', { class: 'back', onclick: () => switchView('main') }, '→'), el('div', { class: 'chat-title' }, state.chat.name)));
  c.appendChild(el('div', { class: 'messages', id: 'messages' }));
  c.appendChild(el('form', { class: 'composer', onsubmit: async (e) => {
    e.preventDefault(); const inp = e.target.querySelector('input'); const content = inp.value.trim(); if (!content) return; inp.value = '';
    const path = state.chat.type === 'user' ? `/messages/dm/${state.chat.id}` : `/messages/channel/${state.chat.id}`;
    await api('POST', path, { content });
  }}, el('input', { type: 'text', placeholder: 'اكتب رسالة…', autocomplete: 'off' }), el('button', { type: 'submit', class: 'send' }, 'إرسال')));
}

function appendMessage(m) {
  const box = $('#messages'); if (!box) return;
  box.appendChild(el('div', { class: 'msg' + (m.sender_id === state.user.id ? ' mine' : '') }, el('div', { class: 'msg-meta' }, m.display_name), el('div', { class: 'msg-body' }, m.content)));
  box.scrollTop = box.scrollHeight;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
