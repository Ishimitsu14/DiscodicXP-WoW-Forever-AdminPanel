const $ = selector => document.querySelector(selector);
const views = {
  characters: ['Персонажи', 'Сохранённые маршруты и прогресс со всех компьютеров.', 'Все персонажи', ['Персонаж', 'Аккаунт', 'Маршрут / шаг', 'Сохранение', '']],
  accounts: ['Аккаунты', 'Игроки и доступ к их облачным сохранениям.', 'Все аккаунты', ['BattleTag', 'Персонажи', 'Компьютеры', 'Создан', '']],
  devices: ['Компьютеры', 'Управляйте ключами доступа для каждого компьютера.', 'Все компьютеры', ['Компьютер', 'Аккаунт', 'Статус', 'Создан', '']],
  guides: ['Гайды', 'Загрузите файл маршрутов. Игроки получат его кнопкой «Обновить гайды» в лаунчере.', 'Версии гайдов', ['Файл', 'Версия', 'Разделы', 'Загружен', 'Статус']],
  events: ['Журнал', 'Последние действия администраторов и лаунчеров.', 'Последние события', ['Действие', 'Объект', 'Время']]
};
const errors = { invalid_credentials: 'Проверьте логин и пароль.', unauthorized: 'Войдите в панель заново.',
  invalid_battle_tag: 'Укажите BattleTag в формате Player#1234.', account_exists: 'Такой аккаунт уже существует.',
  too_many_requests: 'Слишком много запросов. Повторите через минуту.', invalid_input: 'Проверьте заполненные поля.',
  origin_rejected: 'Адрес панели отличается от PUBLIC_ORIGIN сервера.', csrf_rejected: 'Обновите страницу и повторите действие.',
  invalid_guide: 'Не удалось прочитать гайд. Нужен исходный .txt с маршрутами для Forever.',
  invalid_guide_filename: 'Загрузите файл с исходным именем, включая часть после !.', body_too_large: 'Файл слишком большой. Допустимо до 16 МиБ.' };
const actions = { account_created: 'Создан аккаунт', device_created: 'Выдан ключ', device_revoked: 'Ключ отозван',
  admin_login: 'Вход администратора', progress_uploaded: 'Сохранён прогресс', progress_downloaded: 'Загружен прогресс', guides_published: 'Опубликованы гайды' };
let csrf = '', view = 'characters', data = { accounts: [], devices: [], characters: [], events: [], guides: [] }, busy = false, noticeTimer;
const date = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
function notify(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 7000); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(errors[result.error] || 'Не удалось выполнить действие. Повторите попытку.');
  }
  return result;
}
function showLogin() { csrf = ''; $('#login-view').hidden = false; $('#app-view').hidden = true; document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }
function showApp(session) { csrf = session.csrf; $('#admin-name').textContent = session.login; $('#login-view').hidden = true; $('#app-view').hidden = false; }
function node(tag, content, className) { const element = document.createElement(tag); if (content != null) element.textContent = content; if (className) element.className = className; return element; }
function cell(row, value, className) { const td = node('td', null, className); if (value instanceof Node) td.append(value); else td.textContent = value; row.append(td); return td; }
function button(label, callback) { const element = node('button', label, 'text-button'); element.type = 'button'; element.addEventListener('click', () => run(callback)); return element; }
async function run(callback) { if (busy) return; busy = true; try { await callback(); } catch (error) { notify(error.message); } finally { busy = false; } }
const accountName = id => data.accounts.find(item => item.id === id)?.battleTag || '—';
function render() {
  const [title, description, listTitle, columns] = views[view];
  $('#breadcrumb').textContent = title; $('#page-title').textContent = title; $('#page-description').textContent = description; $('#list-title').textContent = listTitle;
  $('#create').textContent = view === 'guides' ? '+ Загрузить гайд' : view === 'devices' ? '+ Подключить компьютер' : '+ Добавить аккаунт';
  $('#create').hidden = view === 'events';
  $('#search').placeholder = view === 'guides' ? 'Поиск по файлу или версии…' : 'Поиск по имени, серверу, BattleTag…';
  const help = $('.help-note p');
  help.replaceChildren(node('strong', view === 'guides' ? 'Новые маршруты — через лаунчер.' : 'Один персонаж. Любой компьютер.'), node('br'),
    document.createTextNode(view === 'guides' ? 'Загрузите файл, обновите гайды в лаунчере и выполните /reload в игре. Выходить из WoW не нужно.' : 'Игрок закрывает WoW и сохраняет прогресс в лаунчере. На другом компьютере — загружает его перед игрой.'));
  document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $('#stat-accounts').textContent = data.accounts.length; $('#stat-characters').textContent = data.characters.length; $('#stat-devices').textContent = data.devices.filter(item => !item.revoked).length;
  const term = $('#search').value.trim().toLocaleLowerCase('ru-RU');
  const rows = data[view].filter(item => `${Object.values(item).join(' ')} ${accountName(item.accountId)}`.toLocaleLowerCase('ru-RU').includes(term));
  const head = node('tr'); columns.forEach(value => head.append(node('th', value))); $('#table-head').replaceChildren(head);
  $('#result-count').textContent = `${rows.length} из ${data[view].length}`;
  $('#table-body').replaceChildren(...rows.map(item => {
    const row = node('tr');
    if (view === 'characters') {
      const character = node('div', null, 'character-cell'), description = node('div');
      description.append(node('strong', item.name), node('small', item.realm)); character.append(node('span', item.name.slice(0, 1), 'character-avatar'), description);
      cell(row, character); cell(row, item.battleTag);
      const guide = node('div'); guide.append(node('strong', item.guide || 'Маршрут не выбран'), node('small', `Шаг ${item.step}`)); cell(row, guide);
      const saved = node('div'); saved.append(node('span', `Ревизия ${item.revision}`, 'revision'), node('small', date(item.updatedAt))); cell(row, saved);
      cell(row, button('История ↗', async () => {
        const entries = await api(`/api/admin/characters/${item.id}/history`);
        $('#history-list').replaceChildren(...entries.map(entry => { const li = node('li', `Ревизия ${entry.revision} · ${date(entry.createdAt)}`); li.append(node('small', data.devices.find(device => device.id === entry.deviceId)?.name || entry.deviceId)); return li; }));
        $('#history-dialog').showModal();
      }));
    } else if (view === 'accounts') {
      cell(row, node('strong', item.battleTag)); cell(row, item.characterCount); cell(row, item.deviceCount); cell(row, date(item.createdAt));
      cell(row, button('Выдать ключ ↗', () => openDevice(item.id)));
    } else if (view === 'devices') {
      cell(row, node('strong', item.name)); cell(row, accountName(item.accountId)); cell(row, node('span', item.revoked ? 'Отозван' : 'Активен', item.revoked ? 'badge revoked' : 'badge')); cell(row, date(item.createdAt));
      cell(row, item.revoked ? '—' : button('Отозвать ключ', async () => {
        if (!confirm(`Отозвать доступ компьютера «${item.name}»?`)) return;
        await api(`/api/admin/devices/${item.id}/revoke`, { method: 'POST', body: '{}' }); await refresh(); notify('Доступ компьютера отозван.');
      }));
    } else if (view === 'guides') {
      cell(row, node('strong', item.name)); cell(row, `Ревизия ${item.revision}`); cell(row, item.sectionCount); cell(row, date(item.createdAt));
      cell(row, node('span', item.revision === data.guides[0].revision ? 'Актуальная' : 'Архив', item.revision === data.guides[0].revision ? 'badge' : 'badge revoked'));
    } else { cell(row, actions[item.action] || item.action); cell(row, item.subject); cell(row, date(item.createdAt)); }
    return row;
  }));
  $('#empty').hidden = rows.length > 0;
  $('#empty-title').textContent = term ? 'Ничего не найдено' : `Пока нет ${view === 'characters' ? 'персонажей' : view === 'accounts' ? 'аккаунтов' : view === 'devices' ? 'компьютеров' : view === 'guides' ? 'гайдов' : 'событий'}`;
  $('#empty-description').textContent = term ? 'Попробуйте другое имя, сервер или BattleTag.' : view === 'guides' ? 'Загрузите исходный .txt. Каждый новый файл заменяет комплект маршрутов для всех подключённых компьютеров.' : view === 'characters' ? 'Создайте аккаунт, выдайте ключ компьютера и отправьте первое сохранение через лаунчер.' : view === 'devices' ? 'Подключите компьютер к аккаунту, чтобы игрок мог пользоваться лаунчером.' : 'Новые записи появятся здесь после действий в панели или лаунчере.';
}
async function refresh() { data = await api('/api/admin/overview'); render(); $('#updated-at').textContent = `Обновлено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`; }
function openDevice(id) {
  if (!data.accounts.length) { notify('Сначала создайте аккаунт.'); return; }
  $('#device-account').replaceChildren(...data.accounts.map(item => { const option = node('option', item.battleTag); option.value = item.id; return option; }));
  if (id) $('#device-account').value = id;
  $('#device-dialog').showModal();
}
$('#login-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const form = event.currentTarget;
  const session = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  form.reset(); showApp(session); await refresh();
}); });
$('#logout').addEventListener('click', () => run(async () => { await api('/api/admin/logout', { method: 'POST', body: '{}' }); showLogin(); }));
$('#top-logout').addEventListener('click', () => $('#logout').click());
document.querySelectorAll('[data-view]').forEach(element => element.addEventListener('click', () => { view = element.dataset.view; $('#search').value = ''; render(); }));
$('#search').addEventListener('input', render);
$('#refresh').addEventListener('click', () => run(refresh));
$('#create').addEventListener('click', () => { if (view === 'devices') openDevice(); else if (view === 'guides') $('#guide-dialog').showModal(); else $('#account-dialog').showModal(); });
document.querySelectorAll('[data-close]').forEach(element => element.addEventListener('click', () => element.closest('dialog').close()));
$('#key-dialog').addEventListener('close', () => { $('#device-secret').value = ''; });
$('#account-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; run(async () => {
  await api('/api/admin/accounts', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  form.reset(); $('#account-dialog').close(); await refresh(); notify('Аккаунт создан. Выдайте ключ для первого компьютера.');
}); });
$('#device-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; run(async () => {
  const result = await api('/api/admin/devices', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  form.reset(); $('#device-dialog').close(); $('#device-secret').value = result.token; $('#key-dialog').showModal(); await refresh();
}); });
$('#copy-key').addEventListener('click', () => run(async () => { await navigator.clipboard.writeText($('#device-secret').value); notify('Ключ скопирован.'); }));
$('#guide-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; run(async () => {
  const file = $('#guide-file').files[0];
  if (!file || !/\.txt$/i.test(file.name)) throw new Error('Выберите исходный файл .txt.');
  if (file.size > 16 * 1024 * 1024) throw new Error('Файл слишком большой. Допустимо до 16 МиБ.');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true; submit.textContent = 'Проверяем и публикуем…';
  try {
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('Сохраните исходный .txt в кодировке UTF-8 и повторите загрузку.'); }
    const result = await api('/api/admin/guides', { method: 'POST', body: JSON.stringify({ fileName: file.name, content }) });
    form.reset(); $('#guide-dialog').close(); await refresh();
    notify(`Гайды опубликованы: ревизия ${result.revision}, разделов ${result.sectionCount}. Обновите их в лаунчере и выполните /reload в игре.`);
  } finally { submit.disabled = false; submit.textContent = 'Загрузить и опубликовать'; }
}); });
try { showApp(await api('/api/admin/session')); await refresh(); } catch { showLogin(); }
