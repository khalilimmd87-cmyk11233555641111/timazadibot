const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const searchInput = document.getElementById('search-input');
const userFilter = document.getElementById('user-filter');
const messagesList = document.getElementById('messages-list');
const totalCount = document.getElementById('total-count');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const pageInfo = document.getElementById('page-info');

let state = { page: 1, search: '', userId: '', total: 0, pageSize: 30 };
let searchTimeout = null;

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  loadUsers();
  loadMessages();
}

function showLogin() {
  dashboardScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
}

async function checkSession() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.isAdmin) showDashboard();
  else showLogin();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (res.ok) {
    showDashboard();
  } else {
    const data = await res.json().catch(() => ({}));
    loginError.textContent = data.error || 'خطا در ورود';
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.search = searchInput.value;
    state.page = 1;
    loadMessages();
  }, 350);
});

userFilter.addEventListener('change', () => {
  state.userId = userFilter.value;
  state.page = 1;
  loadMessages();
});

prevPageBtn.addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    loadMessages();
  }
});

nextPageBtn.addEventListener('click', () => {
  const maxPage = Math.ceil(state.total / state.pageSize) || 1;
  if (state.page < maxPage) {
    state.page += 1;
    loadMessages();
  }
});

async function loadUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) return;
  const data = await res.json();
  userFilter.innerHTML = '<option value="">همه کاربرها</option>';
  data.users.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u.id;
    const label = u.username ? '@' + u.username : (u.first_name || 'کاربر ' + u.id);
    opt.textContent = `${label} (${u.message_count} پیام)`;
    userFilter.appendChild(opt);
  });
}

async function loadMessages() {
  const params = new URLSearchParams({
    page: state.page,
    search: state.search,
    userId: state.userId,
  });
  const res = await fetch('/api/messages?' + params.toString());
  if (res.status === 401) {
    showLogin();
    return;
  }
  const data = await res.json();
  state.total = data.total;
  renderMessages(data.messages);
  renderPagination();
}

function renderMessages(messages) {
  messagesList.innerHTML = '';
  totalCount.textContent = `${state.total} پیام`;

  if (!messages.length) {
    messagesList.innerHTML = '<div class="empty-state">پیامی پیدا نشد</div>';
    return;
  }

  messages.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'message-card';

    const toLabel = m.to_username ? '@' + m.to_username : (m.to_first_name || 'کاربر ' + m.to_user_id);
    const date = new Date(m.created_at).toLocaleString('fa-IR');

    const fromFullName = [m.from_first_name, m.from_last_name].filter(Boolean).join(' ') || '—';
    const fromUsername = m.from_username ? '@' + m.from_username : '—';
    const premiumBadge = m.from_is_premium ? '<span class="badge premium">پرمیوم</span>' : '';
    const langBadge = m.from_language_code ? `<span class="badge lang">${escapeHtml(m.from_language_code)}</span>` : '';

    card.innerHTML = `
      <div class="meta">
        <span>${date}</span>
        <span class="to-tag">برای: ${escapeHtml(toLabel)}</span>
      </div>
      <div class="text">${escapeHtml(m.text)}</div>
      <button class="toggle-sender-btn">👤 مشخصات فرستنده (برای گزارش مزاحمت)</button>
      <div class="sender-info hidden">
        <div class="sender-row">
          <span class="label">آیدی عددی تلگرام:</span>
          <span class="value mono">${m.from_telegram_id ?? '—'}</span>
          <button class="copy-btn" data-copy="${m.from_telegram_id ?? ''}">کپی</button>
        </div>
        <div class="sender-row">
          <span class="label">یوزرنیم:</span>
          <span class="value">${escapeHtml(fromUsername)}</span>
        </div>
        <div class="sender-row">
          <span class="label">نام کامل:</span>
          <span class="value">${escapeHtml(fromFullName)}</span>
        </div>
        <div class="sender-row">
          <span class="label">سایر:</span>
          <span class="value">${premiumBadge}${langBadge}</span>
        </div>
      </div>
    `;

    card.querySelector('.toggle-sender-btn').addEventListener('click', () => {
      card.querySelector('.sender-info').classList.toggle('hidden');
    });

    card.querySelector('.copy-btn').addEventListener('click', (e) => {
      const val = e.target.getAttribute('data-copy');
      if (val) {
        navigator.clipboard.writeText(val);
        e.target.textContent = 'کپی شد ✓';
        setTimeout(() => (e.target.textContent = 'کپی'), 1200);
      }
    });

    messagesList.appendChild(card);
  });
}

function renderPagination() {
  const maxPage = Math.ceil(state.total / state.pageSize) || 1;
  pageInfo.textContent = `صفحه ${state.page} از ${maxPage}`;
  prevPageBtn.disabled = state.page <= 1;
  nextPageBtn.disabled = state.page >= maxPage;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

checkSession();
