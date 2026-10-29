'use strict';

const state = {
  token: localStorage.getItem('pc.token') || null,
  user: null,
  socket: null,
  view: 'main',           // 'main' | 'add' | 'chat'
  chat: null,             // { type:'user'|'channel', id, name }
  friends: [],
  channels: [],
  presence: Object.create(null),
  requests: [],
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

/* ---------- API ---------- */
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'parse_error' }));
  if (!res.ok) throw new Error(data.error || 'request_failed');
  return data;
}

/* ---------- Boot ---------- */
(async function boot() {
  if (state.token) {
    try {
      state.user = await api('GET', '/me');
      await connectSocket();
      await Promise.all([loadFriends(), loadChannels(), loadRequests()]);
      render();
      return;
    } catch {
      state.token = null;
      localStorage.removeItem('pc.token');
    }
  }
  renderAuth();
})();

/* ---------- Socket ---------- */
function connectSocket() {
  return new Promise((resolve) => {
    state.socket = io({ auth: { token: state.token }, transports: ['websocket', 'polling'] });
    state.socket.on('connect', () => resolve());
    state.socket.on('connect_error', () => resolve());

    state.socket.on('presence:update', ({ userId, online }) => {
      state.presence[userId] = online;
      if (state.view === 'main') renderMainList(currentFilter.main);
    });
    state.socket.on('friend:request', async () => {
      await loadRequests();
      if (state.view === 'main') renderMainList(currentFilter.main);
    });
    state.socket.on('friend:response', async ({ accepted }) => {
      if (accepted) await loadFriends();
      if (state.view === 'main') renderMainList(currentFilter.main);
    });
    state.socket.on('message:dm', ({ peerId, message }) => {
      if (state.view === 'chat' && state.chat?.type === 'user' && state.chat.id === peerId) {
        appendMessage(message);
      }
    });
    state.socket.on('message:channel', ({ channelId, message }) => {
      if (state.view === 'chat' && state.chat?.type === 'channel' && state.chat.id === channelId) {
        appendMessage(message);
      }
    });
  });
}

/* ---------- Loaders ---------- */
async function loadFriends() {
  const r = await api('GET', '/friends');
  state.friends = r.friends;
  for (const f of r.friends) if (f.online) state.presence[f.id] = true;
}
async function loadChannels() {
  const r = await api('GET', '/channels');
  state.channels = r.channels;
}
async function loadRequests() {
  const r = await api('GET', '/friends/requests');
  state.requests = r.requests;
}

/* ---------- Auth UI ---------- */
function renderAuth() {
  const app = $('#app');
  app.innerHTML = '';
  const card = el('div', { class: 'auth-card' },
    el('h1', null, 'Presence Chat'),
    el('div', { class: 'tabs' },
      el('button', { class: 'tab active', 'data-tab': 'login', onclick: onTab }, 'دخول'),
      el('button', { class: 'tab', 'data-tab': 'register', onclick: onTab }, 'تسجيل')
    ),
    el('form', { class: 'auth-form', onsubmit: onAuthSubmit },
      el('div', { class: 'field', id: 'f-name', style: 'display:none' },
        el('label', null, 'الاسم الظاهر'),
        el('input', { name: 'displayName', type: 'text', autocomplete: 'name' })
      ),
      el('div', { class: 'field' },
        el('label', null, 'اسم المستخدم'),
        el('input', { name: 'username', type: 'text', autocomplete: 'username', required: true })
      ),
      el('div', { class: 'field' },
        el('label', null, 'كلمة المرور'),
        el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })
      ),
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
  document.querySelector('.auth-form button[type="submit"]').textContent =
    state.authMode === 'register' ? 'تسجيل' : 'دخول';
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  try {
    const path = state.authMode === 'login' ? '/login' : '/register';
    const r = await api('POST', path, body);
    state.token = r.token;
    localStorage.setItem('pc.token', r.token);
    state.user = r.user;
    await connectSocket();
    await Promise.all([loadFriends(), loadChannels(), loadRequests()]);
    render();
  } catch (err) {
    $('#auth-err').textContent = err.message;
  }
}

/* ---------- Shell ---------- */
function render() {
  const app = $('#app');
  app.innerHTML = '';
  const shell = el('div', { class: 'shell' },
    el('header', { class: 'header' },
      el('div', { class: 'brand' }, 'Presence Chat'),
      el('div', { class: 'me' },
        el('span', { class: 'dot' }),
        el('span', null, state.user.username),
        el('button', { class: 'logout', onclick: logout }, 'خروج')
      )
    ),
    el('main', { class: 'content', id: 'content' }),
    el('nav', { class: 'bottom-nav' },
      el('button', {
        class: 'nav-btn' + (state.view === 'main' ? ' active' : ''),
        onclick: () => switchView('main'),
      }, 'القائمة الرئيسية'),
      el('button', {
        class: 'nav-btn' + (state.view === 'add' ? ' active' : ''),
        onclick: () => switchView('add'),
      }, 'إضافة إلى القائمة')
    )
  );
  app.appendChild(shell);
  if (state.view === 'main') renderMain();
  else if (state.view === 'add') renderAdd();
  else if (state.view === 'chat') renderChat();
}

function switchView(v) {
  state.view = v;
  render();
}

/* ---------- Main list ---------- */
const currentFilter = { main: '' };

function renderMain() {
  const c = $('#content');
  c.innerHTML = '';
  c.appendChild(el('div', { class: 'search-bar' },
    el('input', {
      type: 'search',
      class: 'search-input',
      placeholder: 'بحث',
      autocomplete: 'off',
      oninput: (e) => { currentFilter.main = e.target.value; renderMainList(currentFilter.main); },
    })
  ));
  c.appendChild(el('div', { class: 'list', id: 'main-list' }));
  renderMainList(currentFilter.main);
}

function avatarEl(url, name, online) {
  const w = el('div', { class: 'avatar' + (online ? ' online' : '') });
  if (url) w.appendChild(el('img', { src: url, alt: name }));
  else w.appendChild(el('span', null, (name || '?').charAt(0).toUpperCase()));
  return w;
}

function renderMainList(filter) {
  const list = $('#main-list');
  if (!list) return;
  list.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();

  // Incoming friend requests
  const reqs = state.requests.filter(r =>
    !f || r.username.toLowerCase().includes(f) || r.displayName.toLowerCase().includes(f)
  );
  if (reqs.length) {
    const sec = el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'طلبات الصداقة'));
    for (const r of reqs) {
      sec.appendChild(el('div', { class: 'item' },
        avatarEl(r.avatarUrl, r.displayName),
        el('div', { class: 'item-body' },
          el('div', { class: 'item-name' }, r.displayName),
          el('div', { class: 'item-sub' }, '@' + r.username)
        ),
        el('div', { class: 'actions' },
          el('button', { class: 'btn small primary', onclick: () => respond(r.id, 'accept') }, 'قبول'),
          el('button', { class: 'btn small', onclick: () => respond(r.id, 'reject') }, 'رفض')
        )
      ));
    }
    list.appendChild(sec);
  }

  // Friends
  const friends = state.friends.filter(fr =>
    !f || fr.username.toLowerCase().includes(f) || fr.displayName.toLowerCase().includes(f)
  );
  const fs = el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'الأصدقاء'));
  if (!friends.length) fs.appendChild(el('div', { class: 'empty' }, 'لا أصدقاء بعد'));
  else for (const fr of friends) {
    const online = !!state.presence[fr.id];
    fs.appendChild(el('div', {
      class: 'item',
      onclick: () => openChat('user', fr.id, fr.displayName),
    },
      avatarEl(fr.avatarUrl, fr.displayName, online),
      el('div', { class: 'item-body' },
        el('div', { class: 'item-name' }, fr.displayName),
        el('div', { class: 'item-sub' }, online ? 'متوفر الآن' : 'غير متوفر')
      )
    ));
  }
  list.appendChild(fs);

  // Public channels
  const chans = state.channels.filter(ch => !f || ch.name.toLowerCase().includes(f));
  const cs = el('div', { class: 'section' }, el('h3', { class: 'section-title' }, 'القنوات العامة'));
  for (const ch of chans) {
    cs.appendChild(el('div', {
      class: 'item',
      onclick: () => openChat('channel', ch.id, '#' + ch.name),
    },
      el('div', { class: 'channel-icon' }, '#'),
      el('div', { class: 'item-body' },
        el('div', { class: 'item-name' }, ch.name),
        el('div', { class: 'item-sub' }, ch.description || 'قناة عامة')
      )
    ));
  }
  list.appendChild(cs);
}

async function respond(requestId, action) {
  try {
    await api('POST', '/friends/respond', { requestId, action });
    await loadRequests();
    await loadFriends();
    renderMainList(currentFilter.main);
  } catch (e) { alert(e.message); }
}

/* ---------- Add view ---------- */
function renderAdd() {
  const c = $('#content');
  c.innerHTML = '';
  c.appendChild(el('div', { class: 'search-bar' },
    el('input', {
      type: 'search',
      class: 'search-input',
      placeholder: 'بحث',
      autocomplete: 'off',
      oninput: debounce(onAddSearch, 280),
    })
  ));
  c.appendChild(el('div', { class: 'list', id: 'add-results' },
    el('div', { class: 'empty' }, 'اكتب يوزرنيم صديقك للبحث')
  ));
}

const onAddSearch = async (e) => {
  const q = e.target.value.trim();
  const host = $('#add-results');
  host.innerHTML = '';
  if (q.length < 2) return;
  try {
    const r = await api('GET', '/users/search?q=' + encodeURIComponent(q));
    if (!r.results.length) { host.appendChild(el('div', { class: 'empty' }, 'لا نتائج')); return; }
    for (const u of r.results) host.appendChild(profileCard(u));
  } catch (err) {
    host.appendChild(el('div', { class: 'empty' }, err.message));
  }
};

function profileCard(u) {
  const rel = u.relationship;
  const actions = [];
  if (!rel) {
    actions.push(el('button', { class: 'btn primary', onclick: () => sendRequest(u.id) }, 'إضافة'));
  } else if (rel.status === 'pending' && rel.incoming) {
    actions.push(
      el('button', { class: 'btn primary', onclick: () => respond(rel.requestId, 'accept') }, 'قبول'),
      el('button', { class: 'btn danger',  onclick: () => respond(rel.requestId, 'reject') }, 'رفض')
    );
  } else if (rel.status === 'pending') {
    actions.push(el('button', { class: 'btn', disabled: true }, 'طلب معلق'));
  } else if (rel.status === 'accepted') {
    actions.push(el('button', { class: 'btn', disabled: true }, 'صديق'));
  } else {
    actions.push(el('button', { class: 'btn primary', onclick: () => sendRequest(u.id) }, 'إضافة'));
  }
  return el('div', { class: 'profile-card' },
    avatarEl(u.avatarUrl, u.displayName),
    el('div', { class: 'profile-info' },
      el('div', { class: 'profile-name' }, u.displayName),
      el('div', { class: 'profile-user' }, '@' + u.username)
    ),
    el('div', { class: 'profile-actions' }, ...actions)
  );
}

async function sendRequest(userId) {
  try {
    await api('POST', '/friends/request', { userId });
    const host = $('#add-results');
    const q = host.previousElementSibling?.querySelector('input')?.value?.trim() || '';
    if (q.length >= 2) onAddSearch({ target: { value: q } });
  } catch (e) { alert(e.message); }
}

/* ---------- Chat ---------- */
async function openChat(type, id, name) {
  state.chat = { type, id, name };
  state.view = 'chat';
  render();
  if (type === 'channel') state.socket?.emit('channel:join-room', id);
  const path = type === 'user' ? `/messages/dm/${id}` : `/messages/channel/${id}`;
  try {
    const r = await api('GET', path);
    const box = $('#messages');
    box.innerHTML = '';
    for (const m of r.messages) appendMessage(m);
  } catch (e) {
    const box = $('#messages');
    if (box) box.textContent = e.message;
  }
}

function renderChat() {
  const c = $('#content');
  c.innerHTML = '';
  c.appendChild(el('div', { class: 'chat-header' },
    el('button', { class: 'back', onclick: () => { state.view = 'main'; render(); } }, '→'),
    el('div', { class: 'chat-title' }, state.chat.name)
  ));
  c.appendChild(el('div', { class: 'messages', id: 'messages' }));
  c.appendChild(el('form', {
    class: 'composer',
    onsubmit: async (e) => {
      e.preventDefault();
      const inp = e.target.querySelector('input');
      const content = inp.value.trim();
      if (!content) return;
      inp.value = '';
      const path = state.chat.type === 'user'
        ? `/messages/dm/${state.chat.id}`
        : `/messages/channel/${state.chat.id}`;
      try { await api('POST', path, { content }); }
      catch (err) { alert(err.message); }
    },
  },
    el('input', { type: 'text', placeholder: 'اكتب رسالة…', autocomplete: 'off' }),
    el('button', { type: 'submit', class: 'send' }, 'إرسال')
  ));
}

function appendMessage(m) {
  const box = $('#messages');
  if (!box) return;
  const mine = m.sender_id === state.user.id;
  box.appendChild(el('div', { class: 'msg' + (mine ? ' mine' : '') },
    el('div', { class: 'msg-meta' }, m.display_name),
    el('div', { class: 'msg-body' }, m.content)
  ));
  box.scrollTop = box.scrollHeight;
}

/* ---------- Misc ---------- */
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function logout() {
  state.socket?.disconnect();
  state.token = null;
  state.user = null;
  localStorage.removeItem('pc.token');
  renderAuth();
       }
