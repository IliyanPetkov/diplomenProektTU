// =====================================================================
// CloudFS ТУ-София: Клиентска SPA логика (Vanilla JavaScript)
// =====================================================================

// Глобално състояние
const state = {
  token: localStorage.getItem('cloudfs_token') || null,
  refreshToken: localStorage.getItem('cloudfs_refresh') || null,
  user: JSON.parse(localStorage.getItem('cloudfs_user') || 'null'),
  currentFolderId: null,
  activeView: 'files', // 'files', 'shared', 'trash'
  currentFileForModal: null,
  eventSource: null,
  sortBy: 'name',
  sortOrder: 'asc',
};

// Хелпър за показване на Toast известия
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Форматиране на байтове
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Заявки към API с автентикация
async function apiRequest(endpoint, options = {}) {
  const headers = { ...options.headers };

  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(endpoint, { ...options, headers });

  // Обработка на изтекъл токен
  if (response.status === 401 && state.refreshToken) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${state.token}`;
      return fetch(endpoint, { ...options, headers });
    }
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMsg = data?.error?.message || `Грешка ${response.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

// Обновяване на JWT токен
async function tryRefreshToken() {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    setSession(data.accessToken, state.refreshToken, data.user);
    return true;
  } catch {
    logout();
    return false;
  }
}

function setSession(token, refreshToken, user) {
  state.token = token;
  state.refreshToken = refreshToken;
  state.user = user;

  localStorage.setItem('cloudfs_token', token);
  localStorage.setItem('cloudfs_refresh', refreshToken);
  localStorage.setItem('cloudfs_user', JSON.stringify(user));

  updateUiForSession();
  connectRealtime();
}

function logout() {
  if (state.token) {
    fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
    }).catch(() => {});
  }

  state.token = null;
  state.refreshToken = null;
  state.user = null;
  localStorage.clear();

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  updateUiForSession();
}

function updateUiForSession() {
  const authSection = document.getElementById('authSection');
  const fileManagerSection = document.getElementById('fileManagerSection');
  const adminSection = document.getElementById('adminSection');
  const publicShareSection = document.getElementById('publicShareSection');
  const authHeaderSection = document.getElementById('authHeaderSection');
  const userBadge = document.getElementById('userBadge');
  const roleBadge = document.getElementById('roleBadge');
  const adminPanelBtn = document.getElementById('adminPanelBtn');

  // 1. Проверка дали се намираме на публичен линк за споделяне (/share/:token)
  if (window.location.pathname.startsWith('/share/')) {
    authSection.classList.add('hidden');
    fileManagerSection.classList.add('hidden');
    adminSection.classList.add('hidden');
    if (publicShareSection) publicShareSection.classList.remove('hidden');

    if (state.user && state.token) {
      authHeaderSection.classList.remove('hidden');
      userBadge.textContent = `${state.user.fullName} (${state.user.email})`;
      roleBadge.textContent = state.user.role.toUpperCase();
      roleBadge.className = `role-badge ${state.user.role}`;
    } else {
      authHeaderSection.classList.add('hidden');
    }

    loadPublicShareView();
    return;
  }

  if (publicShareSection) publicShareSection.classList.add('hidden');

  if (state.user && state.token) {
    authSection.classList.add('hidden');
    adminSection.classList.add('hidden');
    fileManagerSection.classList.remove('hidden');
    authHeaderSection.classList.remove('hidden');

    userBadge.textContent = `${state.user.fullName} (${state.user.email})`;
    roleBadge.textContent = state.user.role.toUpperCase();
    roleBadge.className = `role-badge ${state.user.role}`;

    const navAdminFilesBtn = document.getElementById('navAdminFilesBtn');
    if (state.user.role === 'admin') {
      adminPanelBtn.classList.remove('hidden');
      if (navAdminFilesBtn) navAdminFilesBtn.classList.remove('hidden');
    } else {
      adminPanelBtn.classList.add('hidden');
      if (navAdminFilesBtn) navAdminFilesBtn.classList.add('hidden');
    }

    loadFolderContents();
  } else {
    authSection.classList.remove('hidden');
    fileManagerSection.classList.add('hidden');
    adminSection.classList.add('hidden');
    authHeaderSection.classList.add('hidden');
  }
}

// -------------------------------------------------------------
// Публичен изглед за изтегляне на споделен файл (/share/:token)
// -------------------------------------------------------------
async function loadPublicShareView() {
  const token = window.location.pathname.replace('/share/', '').trim();
  const subtitle = document.getElementById('publicShareSubtitle');
  const infoCard = document.getElementById('publicShareInfoCard');
  const fileNameEl = document.getElementById('pubFileName');
  const fileSizeEl = document.getElementById('pubFileSize');
  const protectedRow = document.getElementById('pubFileProtectedRow');
  const passGroup = document.getElementById('publicSharePassGroup');
  const passInput = document.getElementById('publicSharePasswordInput');
  const downloadBtn = document.getElementById('downloadPublicFileBtn');

  if (!token) {
    subtitle.textContent = 'Невалиден линк за споделяне.';
    subtitle.style.color = '#dc3545';
    return;
  }

  try {
    const data = await apiRequest(`/api/v1/public/${token}`);
    subtitle.textContent = 'Файлът е готов за изтегляне:';
    subtitle.style.color = '';
    fileNameEl.textContent = data.filename;
    fileSizeEl.textContent = formatBytes(data.sizeBytes);
    infoCard.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');

    if (data.isProtected) {
      protectedRow.classList.remove('hidden');
      passGroup.classList.remove('hidden');
      passInput.focus();
    } else {
      protectedRow.classList.add('hidden');
      passGroup.classList.add('hidden');
    }

    downloadBtn.onclick = async () => {
      const password = passInput.value;
      downloadBtn.disabled = true;
      downloadBtn.textContent = '⏳ Изтегляне...';

      try {
        const res = await fetch(`/api/v1/public/${token}/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error?.message || `Грешка при сваляне (${res.status})`);
        }

        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);

        showToast(`Файлът "${data.filename}" се изтегли успешно!`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '⬇️ Свали файла';
      }
    };
  } catch (err) {
    subtitle.textContent = err.message || 'Връзката за споделяне е невалидна или е била отнета.';
    subtitle.style.color = '#dc3545';
    infoCard.classList.add('hidden');
    downloadBtn.classList.add('hidden');
  }
}

// -------------------------------------------------------------
// Realtime SSE Synchronizer
// -------------------------------------------------------------
function connectRealtime() {
  if (!state.token) return;
  if (state.eventSource) state.eventSource.close();

  const url = `/events?token=${encodeURIComponent(state.token)}`;
  state.eventSource = new EventSource(url);

  state.eventSource.onopen = () => {
    document.getElementById('realtimeStatusText').textContent = 'Свързан (Реално време)';
    document.querySelector('.status-dot').className = 'status-dot online';
  };

  state.eventSource.onerror = () => {
    document.getElementById('realtimeStatusText').textContent = 'Прекъсната връзка (Опит за reconnect...)';
    document.querySelector('.status-dot').className = 'status-dot';
  };

  const handleRemoteUpdate = (event) => {
    try {
      const payload = JSON.parse(event.data);
      showToast(`🔄 Синхронизация: ${payload.type} (${payload.name || ''})`, 'info');
      if (state.activeView === 'files') {
        loadFolderContents();
      } else if (state.activeView === 'shared') {
        loadSharedContents();
      } else if (state.activeView === 'trash') {
        loadTrashContents();
      }
    } catch (e) {}
  };

  state.eventSource.addEventListener('FOLDER_CREATED', handleRemoteUpdate);
  state.eventSource.addEventListener('FOLDER_UPDATED', handleRemoteUpdate);
  state.eventSource.addEventListener('FOLDER_DELETED', handleRemoteUpdate);
  state.eventSource.addEventListener('FOLDER_RESTORED', handleRemoteUpdate);
  state.eventSource.addEventListener('FILE_UPLOAD', handleRemoteUpdate);
  state.eventSource.addEventListener('FILE_UPDATED', handleRemoteUpdate);
  state.eventSource.addEventListener('FILE_DELETED', handleRemoteUpdate);
  state.eventSource.addEventListener('FILE_RESTORED', handleRemoteUpdate);
  state.eventSource.addEventListener('FILE_VERSION_RESTORED', handleRemoteUpdate);
}

// -------------------------------------------------------------
// Файлов мениджър: Зареждане на съдържание
// -------------------------------------------------------------
async function loadFolderContents() {
  const dropZone = document.getElementById('dropZone');
  const createFolderBtn = document.getElementById('createFolderBtn');
  const uploadTriggerBtn = document.getElementById('uploadTriggerBtn');
  const emptyMessage = document.getElementById('emptyFolderMessage');

  if (dropZone) dropZone.classList.remove('hidden');
  if (createFolderBtn) createFolderBtn.classList.remove('hidden');
  if (uploadTriggerBtn) uploadTriggerBtn.classList.remove('hidden');
  emptyMessage.textContent = 'Тази папка е празна. Качете файл или създайте папка.';

  try {
    const url = `/api/v1/contents?folderId=${state.currentFolderId || ''}&sortBy=${state.sortBy}&order=${state.sortOrder}`;
    const data = await apiRequest(url);

    // Обновяване на квотата
    if (data.quota) {
      document.getElementById('quotaText').textContent =
        `${formatBytes(data.quota.usedBytes)} / ${formatBytes(data.quota.totalBytes)}`;
      document.getElementById('quotaProgressBar').style.width = `${data.quota.percentage}%`;
    }

    // Хлебни трохи (Breadcrumbs)
    renderBreadcrumbs(data.breadcrumbs);

    // Рендериране на папки и файлове
    renderFilesTable(data.folders, data.files);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// Споделени с мен (Shared with Me)
// -------------------------------------------------------------
async function loadSharedContents() {
  const tbody = document.getElementById('filesTableBody');
  const emptyMessage = document.getElementById('emptyFolderMessage');
  const breadcrumbs = document.getElementById('breadcrumbsContainer');
  const dropZone = document.getElementById('dropZone');
  const createFolderBtn = document.getElementById('createFolderBtn');
  const uploadTriggerBtn = document.getElementById('uploadTriggerBtn');

  // Актуализация на тулбара
  breadcrumbs.innerHTML = '<span class="breadcrumb-item">🤝 Споделени с мен файлове</span>';
  if (dropZone) dropZone.classList.add('hidden');
  if (createFolderBtn) createFolderBtn.classList.add('hidden');
  if (uploadTriggerBtn) uploadTriggerBtn.classList.add('hidden');

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#6c757d;">Зареждане на споделени файлове...</td></tr>';
  emptyMessage.classList.add('hidden');

  try {
    const data = await apiRequest('/api/v1/shares');
    tbody.innerHTML = '';
    const items = data.sharedWithMe || [];

    if (items.length === 0) {
      emptyMessage.textContent = 'Няма файлове, споделени с вас от колеги.';
      emptyMessage.classList.remove('hidden');
      return;
    }

    for (const file of items) {
      const tr = document.createElement('tr');
      const checksumShort = file.checksum_sha256 ? `${file.checksum_sha256.slice(0, 10)}...` : '—';
      const permBadge = file.permission === 'editor' 
        ? '<span class="badge" style="background:#28a745; color:white;">Редакция</span>' 
        : '<span class="badge" style="background:#17a2b8; color:white;">Преглед</span>';

      tr.innerHTML = `
        <td>📄 <strong>${file.name}</strong> ${permBadge}</td>
        <td>${formatBytes(file.size_bytes)}</td>
        <td><span class="badge">v${file.version || 1}</span></td>
        <td><span class="checksum-badge" title="${file.checksum_sha256}">${checksumShort}</span></td>
        <td>
          <div>От: <strong>${file.owner_name}</strong> (${file.owner_email})</div>
          <small style="color:#6c757d;">${new Date(file.created_at).toLocaleString('bg-BG')}</small>
        </td>
        <td>
          <div class="action-buttons">
            <button class="btn-icon" title="Свали файл" onclick="downloadFile('${file.file_id}')">⬇️</button>
            <button class="btn-icon" title="История на версиите" onclick="openVersionsModal('${file.file_id}', '${file.name}')">⏱️</button>
            ${file.permission === 'editor' ? `<button class="btn-icon" title="Преименувай" onclick="openRenameModal('file', '${file.file_id}', '${file.name}')">✏️</button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// Кошче (Trash View)
// -------------------------------------------------------------
async function loadTrashContents() {
  const tbody = document.getElementById('filesTableBody');
  const emptyMessage = document.getElementById('emptyFolderMessage');
  const breadcrumbs = document.getElementById('breadcrumbsContainer');
  const dropZone = document.getElementById('dropZone');
  const createFolderBtn = document.getElementById('createFolderBtn');
  const uploadTriggerBtn = document.getElementById('uploadTriggerBtn');

  breadcrumbs.innerHTML = '<span class="breadcrumb-item">🗑️ Кошче за изтрити файлове и папки</span>';
  if (dropZone) dropZone.classList.add('hidden');
  if (createFolderBtn) createFolderBtn.classList.add('hidden');
  if (uploadTriggerBtn) uploadTriggerBtn.classList.add('hidden');

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#6c757d;">Зареждане на кошчето...</td></tr>';
  emptyMessage.classList.add('hidden');

  try {
    const data = await apiRequest('/api/v1/trash');
    tbody.innerHTML = '';
    const folders = data.folders || [];
    const files = data.files || [];

    if (folders.length === 0 && files.length === 0) {
      emptyMessage.textContent = 'Кошчето е празно.';
      emptyMessage.classList.remove('hidden');
      return;
    }

    for (const folder of folders) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>📁 ${folder.name}</strong> <span class="badge" style="background:#6c757d; color:white;">Папка</span></td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td><small>Изтрита: ${new Date(folder.deletedAt).toLocaleString('bg-BG')}</small></td>
        <td>
          <div class="action-buttons">
            <button class="btn btn-outline" style="padding:2px 8px; font-size:0.75rem;" title="Възстанови" onclick="restoreResource('folder', '${folder.id}')">♻️ Възстанови</button>
            <button class="btn btn-danger" style="padding:2px 8px; font-size:0.75rem;" title="Изтрий окончателно" onclick="permanentDeleteResource('folder', '${folder.id}')">❌ Изтрий</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }

    for (const file of files) {
      const tr = document.createElement('tr');
      const checksumShort = file.checksum_sha256 ? `${file.checksum_sha256.slice(0, 10)}...` : '—';
      tr.innerHTML = `
        <td>📄 ${file.name}</td>
        <td>${formatBytes(file.sizeBytes)}</td>
        <td><span class="badge">v${file.version || 1}</span></td>
        <td><span class="checksum-badge" title="${file.checksum_sha256}">${checksumShort}</span></td>
        <td><small>Изтрит: ${new Date(file.deletedAt).toLocaleString('bg-BG')}</small></td>
        <td>
          <div class="action-buttons">
            <button class="btn btn-outline" style="padding:2px 8px; font-size:0.75rem;" title="Възстанови" onclick="restoreResource('file', '${file.id}')">♻️ Възстанови</button>
            <button class="btn btn-danger" style="padding:2px 8px; font-size:0.75rem;" title="Изтрий окончателно" onclick="permanentDeleteResource('file', '${file.id}')">❌ Изтрий</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

window.restoreResource = async (type, id) => {
  try {
    await apiRequest(`/api/v1/trash/restore/${type}/${id}`, { method: 'POST' });
    showToast('Ресурсът беше успешно възстановен!', 'success');
    loadTrashContents();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.permanentDeleteResource = async (type, id) => {
  if (!confirm('Сигурни ли сте, че искате да изтриете този ресурс ОКОНЧАТЕЛНО? Това действие е необратимо!')) return;
  try {
    await apiRequest(`/api/v1/trash/permanent/${type}/${id}`, { method: 'DELETE' });
    showToast('Ресурсът беше изтрит окончателно.', 'info');
    loadTrashContents();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// -------------------------------------------------------------
// Административен изглед: Всички файлове в системата
// -------------------------------------------------------------
async function loadAdminFilesView() {
  const tbody = document.getElementById('filesTableBody');
  const emptyMessage = document.getElementById('emptyFolderMessage');
  const breadcrumbs = document.getElementById('breadcrumbsContainer');
  const dropZone = document.getElementById('dropZone');
  const createFolderBtn = document.getElementById('createFolderBtn');
  const uploadTriggerBtn = document.getElementById('uploadTriggerBtn');

  breadcrumbs.innerHTML = '<span class="breadcrumb-item" style="color:#c0392b; font-weight:700;">🌐 Глобален регистър на всички файлове в системата (Административен достъп)</span>';
  if (dropZone) dropZone.classList.add('hidden');
  if (createFolderBtn) createFolderBtn.classList.add('hidden');
  if (uploadTriggerBtn) uploadTriggerBtn.classList.add('hidden');

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#6c757d;">Зареждане на глобалния регистър на файлове...</td></tr>';
  emptyMessage.classList.add('hidden');

  try {
    const data = await apiRequest('/api/v1/admin/files');
    tbody.innerHTML = '';
    const files = data.files || [];

    if (files.length === 0) {
      emptyMessage.textContent = 'Няма качени файлове в системата.';
      emptyMessage.classList.remove('hidden');
      return;
    }

    for (const file of files) {
      const tr = document.createElement('tr');
      const checksumShort = file.checksumSha256 ? `${file.checksumSha256.slice(0, 10)}...` : '—';

      tr.innerHTML = `
        <td>📄 <strong>${file.name}</strong></td>
        <td>${formatBytes(file.sizeBytes)}</td>
        <td><span class="badge">v${file.version}</span></td>
        <td><span class="checksum-badge" title="${file.checksumSha256}">${checksumShort}</span></td>
        <td>
          <div>👤 <strong>${file.ownerName}</strong> (<small>${file.ownerEmail}</small>)</div>
          <div style="font-size:0.75rem; color:#6c757d;">Папка: 📁 ${file.folderName} | ${new Date(file.createdAt).toLocaleString('bg-BG')}</div>
        </td>
        <td>
          <div class="action-buttons">
            <button class="btn-icon" title="Свали файл (Администратор)" onclick="downloadFile('${file.id}')">⬇️</button>
            <button class="btn-icon" title="История на версиите" onclick="openVersionsModal('${file.id}', '${file.name}')">⏱️</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderBreadcrumbs(breadcrumbs) {
  const container = document.getElementById('breadcrumbsContainer');
  container.innerHTML = `<span class="breadcrumb-item" data-folder-id="">Корен (Root)</span>`;

  for (const b of breadcrumbs) {
    const sep = document.createElement('span');
    sep.textContent = ' / ';
    const item = document.createElement('span');
    item.className = 'breadcrumb-item';
    item.textContent = b.name;
    item.dataset.folderId = b.id;
    item.onclick = () => {
      state.currentFolderId = b.id;
      loadFolderContents();
    };
    container.appendChild(sep);
    container.appendChild(item);
  }

  container.querySelector('[data-folder-id=""]').onclick = () => {
    state.currentFolderId = null;
    loadFolderContents();
  };
}

function renderFilesTable(folders, files) {
  const tbody = document.getElementById('filesTableBody');
  const emptyMessage = document.getElementById('emptyFolderMessage');
  tbody.innerHTML = '';

  if (folders.length === 0 && files.length === 0) {
    emptyMessage.classList.remove('hidden');
    return;
  }
  emptyMessage.classList.add('hidden');

  // Папки
  for (const folder of folders) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>📁 ${folder.name}</strong></td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>${new Date(folder.updated_at).toLocaleString('bg-BG')}</td>
      <td>
        <div class="action-buttons">
          <button class="btn-icon" title="Отвори" onclick="openFolder('${folder.id}')">📂</button>
          <button class="btn-icon" title="Преименувай" onclick="openRenameModal('folder', '${folder.id}', '${folder.name}')">✏️</button>
          <button class="btn-icon" title="Премести в кошче" onclick="trashFolder('${folder.id}')">🗑️</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Файлове
  for (const file of files) {
    const tr = document.createElement('tr');
    const checksumShort = file.checksumSha256 ? `${file.checksumSha256.slice(0, 10)}...` : '—';
    tr.innerHTML = `
      <td>📄 ${file.name}</td>
      <td>${formatBytes(file.sizeBytes)}</td>
      <td><span class="badge">v${file.version}</span></td>
      <td><span class="checksum-badge" title="${file.checksumSha256}">${checksumShort}</span></td>
      <td>${new Date(file.updatedAt).toLocaleString('bg-BG')}</td>
      <td>
        <div class="action-buttons">
          <button class="btn-icon" title="Свали файл" onclick="downloadFile('${file.id}')">⬇️</button>
          <button class="btn-icon" title="Версии" onclick="openVersionsModal('${file.id}', '${file.name}')">⏱️</button>
          <button class="btn-icon" title="Споделяне" onclick="openSharingModal('${file.id}', '${file.name}')">🔗</button>
          <button class="btn-icon" title="Преименувай" onclick="openRenameModal('file', '${file.id}', '${file.name}')">✏️</button>
          <button class="btn-icon" title="Премести в кошче" onclick="trashFile('${file.id}')">🗑️</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

window.openFolder = (folderId) => {
  state.currentFolderId = folderId;
  loadFolderContents();
};

// -------------------------------------------------------------
// Стрийминг качване на файлове с Progress Bar (Drag-and-Drop)
// -------------------------------------------------------------
async function handleFileUpload(file) {
  if (!file) return;

  const progressCard = document.getElementById('uploadProgressCard');
  const filenameEl = document.getElementById('uploadFilename');
  const percentEl = document.getElementById('uploadPercent');
  const barEl = document.getElementById('uploadProgressBar');

  progressCard.classList.remove('hidden');
  filenameEl.textContent = `Качване на: ${file.name} (${formatBytes(file.size)})`;
  percentEl.textContent = '0%';
  barEl.style.width = '0%';

  try {
    // 1. Инициализация (INITIATED)
    const initRes = await apiRequest('/api/v1/upload/init', {
      method: 'POST',
      body: {
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        folderId: state.currentFolderId,
      }
    });

    const uploadId = initRes.uploadId;

    // 2. Стрийминг поток с реален XMLHttpRequest progress (UPLOADING)
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/v1/upload/${uploadId}/stream`);
      xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          const pct = Math.round((evt.loaded / evt.total) * 100);
          percentEl.textContent = `${pct}%`;
          barEl.style.width = `${pct}%`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`Грешка при качване: ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => reject(new Error('Мрежова грешка при качване'));
      xhr.send(file);
    }).then(async (streamRes) => {
      // 3. Финализиране (COMMITTED)
      percentEl.textContent = 'Финализиране и проверка на SHA-256...';
      const commitRes = await apiRequest(`/api/v1/upload/${uploadId}/commit`, {
        method: 'POST',
        body: {
          sizeBytes: streamRes.actualSizeBytes,
          checksumSha256: streamRes.checksumSha256,
        }
      });

      showToast(`Успешно качен файл "${file.name}" (SHA-256: ${commitRes.checksumSha256.slice(0, 12)}...)`, 'success');
      loadFolderContents();
    });
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setTimeout(() => progressCard.classList.add('hidden'), 2500);
  }
}

// Сваляне на файл
window.downloadFile = (fileId) => {
  const url = `/api/v1/download/${fileId}`;
  const a = document.createElement('a');
  a.href = `${url}?token=${state.token}`; // Gateway/proxy поддържа и Bearer токен през header
  // Изтегляне чрез fetch с токен за максимална сигурност
  fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } })
    .then(res => {
      if (!res.ok) throw new Error('Грешка при изтегляне на файл');
      const filenameHeader = res.headers.get('Content-Disposition');
      let filename = 'downloaded_file';
      if (filenameHeader && filenameHeader.includes('filename=')) {
        filename = decodeURIComponent(filenameHeader.split('filename=')[1].replace(/"/g, ''));
      }
      return res.blob().then(blob => ({ blob, filename }));
    })
    .then(({ blob, filename }) => {
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
      showToast(`Изтеглен файл: ${filename}`, 'success');
    })
    .catch(err => showToast(err.message, 'error'));
};

// -------------------------------------------------------------
// Кошче, Преименуване, Изтриване
// -------------------------------------------------------------
window.trashFile = async (fileId) => {
  if (!confirm('Сигурни ли сте, че искате да преместите файла в кошчето?')) return;
  try {
    await apiRequest(`/api/v1/files/${fileId}`, { method: 'DELETE' });
    showToast('Файлът е преместен в кошчето', 'info');
    loadFolderContents();
  } catch (e) { showToast(e.message, 'error'); }
};

window.trashFolder = async (folderId) => {
  if (!confirm('Сигурни ли сте, че искате да преместите папката в кошчето?')) return;
  try {
    await apiRequest(`/api/v1/folders/${folderId}`, { method: 'DELETE' });
    showToast('Папката е преместена в кошчето', 'info');
    loadFolderContents();
  } catch (e) { showToast(e.message, 'error'); }
};

window.openRenameModal = (type, id, currentName) => {
  const modal = document.getElementById('renameModal');
  const input = document.getElementById('renameInput');
  input.value = currentName;
  modal.classList.remove('hidden');

  document.getElementById('confirmRenameModalBtn').onclick = async () => {
    const newName = input.value.trim();
    if (!newName) return;
    try {
      if (type === 'file') {
        await apiRequest(`/api/v1/files/${id}`, { method: 'PATCH', body: { name: newName } });
      } else {
        await apiRequest(`/api/v1/folders/${id}`, { method: 'PATCH', body: { name: newName } });
      }
      modal.classList.add('hidden');
      showToast('Успешно преименуване', 'success');
      loadFolderContents();
    } catch (e) { showToast(e.message, 'error'); }
  };
};

document.getElementById('cancelRenameModalBtn').onclick = () => {
  document.getElementById('renameModal').classList.add('hidden');
};

// -------------------------------------------------------------
// Модал за версии на файл
// -------------------------------------------------------------
window.openVersionsModal = async (fileId, filename) => {
  const modal = document.getElementById('versionsModal');
  const tbody = document.getElementById('versionsTableBody');
  document.getElementById('versionsModalTitle').textContent = `История на версиите: ${filename}`;
  tbody.innerHTML = '<tr><td colspan="5">Зареждане...</td></tr>';
  modal.classList.remove('hidden');

  try {
    const data = await apiRequest(`/api/v1/files/${fileId}/versions`);
    tbody.innerHTML = '';

    // Текуща версия
    const curr = data.currentVersion;
    const trCurr = document.createElement('tr');
    trCurr.innerHTML = `
      <td><strong>v${curr.version} (Текуща)</strong></td>
      <td>${formatBytes(curr.sizeBytes)}</td>
      <td><span class="checksum-badge">${curr.checksumSha256.slice(0, 10)}...</span></td>
      <td>${new Date(curr.updatedAt).toLocaleString('bg-BG')}</td>
      <td><em>Активна</em></td>
    `;
    tbody.appendChild(trCurr);

    // Предишни версии
    for (const v of data.previousVersions) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>v${v.versionNumber}</td>
        <td>${formatBytes(v.sizeBytes)}</td>
        <td><span class="checksum-badge">${v.checksumSha256.slice(0, 10)}...</span></td>
        <td>${new Date(v.createdAt).toLocaleString('bg-BG')}</td>
        <td>
          <button class="btn btn-outline" onclick="restoreVersion('${fileId}', '${v.id}')">Възстанови</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:red;">${err.message}</td></tr>`;
  }
};

window.restoreVersion = async (fileId, versionId) => {
  try {
    await apiRequest(`/api/v1/files/${fileId}/versions/${versionId}/restore`, { method: 'POST' });
    showToast('Версията е възстановена успешно!', 'success');
    document.getElementById('versionsModal').classList.add('hidden');
    loadFolderContents();
  } catch (e) { showToast(e.message, 'error'); }
};

document.getElementById('closeVersionsModalBtn').onclick = () => {
  document.getElementById('versionsModal').classList.add('hidden');
};

// -------------------------------------------------------------
// Модал за споделяне (Sharing)
// -------------------------------------------------------------
window.openSharingModal = async (fileId, filename) => {
  state.currentFileForModal = fileId;
  const modal = document.getElementById('sharingModal');
  document.getElementById('sharingModalTitle').textContent = `Споделяне: ${filename}`;
  modal.classList.remove('hidden');
  loadSharesList(fileId);

  // Зареждане на списъка с регистрирани потребители за автодовършване
  try {
    const users = await apiRequest('/api/v1/users');
    const datalist = document.getElementById('registeredUsersDatalist');
    if (datalist && Array.isArray(users)) {
      datalist.innerHTML = users
        .map(u => `<option value="${u.email}">${u.fullName} (${u.email})</option>`)
        .join('');
    }
  } catch (e) {}
};

async function loadSharesList(fileId) {
  const userSharesContainer = document.getElementById('activeUserSharesList');
  const publicLinksContainer = document.getElementById('publicLinksList');
  userSharesContainer.innerHTML = 'Зареждане на споделяния...';

  try {
    const data = await apiRequest(`/api/v1/shares?fileId=${fileId}`);
    userSharesContainer.innerHTML = '<strong>Активни потребители:</strong>';

    if (data.userShares.length === 0) {
      userSharesContainer.innerHTML += '<p style="color:#6c757d;">Файлът все още не е споделен с колеги.</p>';
    } else {
      for (const s of data.userShares) {
        userSharesContainer.innerHTML += `
          <div style="display:flex; justify-content:space-between; margin-top:6px; padding:6px; background:#f8f9fa; border-radius:4px;">
            <span>${s.grantee_name} (${s.grantee_email}) - <em>${s.permission}</em></span>
            <button class="btn-icon" title="Отнеми права" onclick="revokeUserShare('${s.id}')">❌</button>
          </div>
        `;
      }
    }

    publicLinksContainer.innerHTML = '<strong>Публични линкове:</strong>';
    if (data.publicLinks.length === 0) {
      publicLinksContainer.innerHTML += '<p style="color:#6c757d;">Няма генерирани активни линкове.</p>';
    } else {
      for (const pl of data.publicLinks) {
        const linkUrl = `${window.location.origin}/share/${pl.token}`;
        publicLinksContainer.innerHTML += `
          <div style="margin-top:6px; padding:6px; background:#f8f9fa; border-radius:4px; font-size:0.8rem;">
            <div>Линк: <input readonly value="${linkUrl}" style="width:70%; font-size:0.8rem;" onclick="this.select()"></div>
            <div style="display:flex; justify-content:space-between; margin-top:4px;">
              <span>Изтегляния: ${pl.download_count} | Защита: ${pl.isProtected ? 'Да 🔒' : 'Не'}</span>
              <button class="btn btn-outline" style="padding:2px 8px; font-size:0.75rem;" onclick="revokePublicLink('${pl.id}')">Деактивирай</button>
            </div>
          </div>
        `;
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('confirmUserShareBtn').onclick = async () => {
  const email = document.getElementById('shareUserEmail').value.trim();
  const perm = document.getElementById('sharePermissionSelect').value;
  if (!email) return;

  try {
    await apiRequest('/api/v1/shares', {
      method: 'POST',
      body: { fileId: state.currentFileForModal, granteeEmail: email, permission: perm }
    });
    showToast(`Файлът е споделен успешно с ${email}`, 'success');
    document.getElementById('shareUserEmail').value = '';
    loadSharesList(state.currentFileForModal);
  } catch (e) { showToast(e.message, 'error'); }
};

document.getElementById('publicLinkPassCheck').onchange = (e) => {
  const passInput = document.getElementById('publicLinkPassInput');
  if (e.target.checked) passInput.classList.remove('hidden');
  else passInput.classList.add('hidden');
};

document.getElementById('generatePublicLinkBtn').onclick = async () => {
  const passInput = document.getElementById('publicLinkPassInput');
  const password = document.getElementById('publicLinkPassCheck').checked ? passInput.value : null;

  try {
    const res = await apiRequest('/api/v1/public-links', {
      method: 'POST',
      body: { fileId: state.currentFileForModal, password, expiresInHours: 72 }
    });
    showToast('Генериран е нов публичен линк!', 'success');
    loadSharesList(state.currentFileForModal);
  } catch (e) { showToast(e.message, 'error'); }
};

window.revokeUserShare = async (shareId) => {
  try {
    await apiRequest(`/api/v1/shares/${shareId}`, { method: 'DELETE' });
    showToast('Споделянето е отнето', 'info');
    loadSharesList(state.currentFileForModal);
  } catch (e) { showToast(e.message, 'error'); }
};

window.revokePublicLink = async (linkId) => {
  try {
    await apiRequest(`/api/v1/public-links/${linkId}`, { method: 'DELETE' });
    showToast('Публичният линк е деактивиран', 'info');
    loadSharesList(state.currentFileForModal);
  } catch (e) { showToast(e.message, 'error'); }
};

document.getElementById('closeSharingModalBtn').onclick = () => {
  document.getElementById('sharingModal').classList.add('hidden');
};

// -------------------------------------------------------------
// Административен панел (Audit Logs & Metrics & Redundancy)
// -------------------------------------------------------------
document.getElementById('adminPanelBtn').onclick = () => {
  document.getElementById('fileManagerSection').classList.add('hidden');
  document.getElementById('adminSection').classList.remove('hidden');
  loadAdminData();
};

document.getElementById('closeAdminBtn').onclick = () => {
  document.getElementById('adminSection').classList.add('hidden');
  document.getElementById('fileManagerSection').classList.remove('hidden');
};

async function loadAdminData() {
  try {
    // 1. Статистика
    const stats = await apiRequest('/api/v1/audit/stats');
    document.getElementById('metricUsers').textContent = stats.usersCount;
    document.getElementById('metricFiles').textContent = stats.filesCount;
    document.getElementById('metricStorage').textContent = formatBytes(stats.totalStorageBytes);
    document.getElementById('metricLogins').textContent = `${stats.successfulLogins} (Грешни: ${stats.failedLogins})`;

    // 2. Статус на Storage Nodes (Redundancy)
    const storageStatus = await apiRequest('/api/v1/storage/nodes');
    const nodesGrid = document.getElementById('storageNodesGrid');
    nodesGrid.innerHTML = '';

    for (const node of storageStatus.nodes) {
      const isOnline = node.status === 'ONLINE_HEALTHY';
      const card = document.createElement('div');
      card.className = 'storage-node-card';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
          <strong>Storage Node #${node.nodeId + 1}</strong>
          <span class="node-status-badge ${isOnline ? 'online' : 'offline'}">${isOnline ? 'АКТИВЕН' : 'ОТКАЗ'}</span>
        </div>
        <div style="font-size:0.75rem; color:#6c757d; word-break:break-all;">Директория: ${node.path}</div>
        <div style="margin-top:auto;">
          ${isOnline 
            ? `<button class="btn btn-danger btn-block" onclick="simulateNodeFault(${node.nodeId})">Симулирай отказ 💥</button>`
            : `<button class="btn btn-success btn-block" onclick="restoreNode(${node.nodeId})">Възстанови възела 🔄</button>`
          }
        </div>
      `;
      nodesGrid.appendChild(card);
    }

    // 3. Глобален регистър на всички файлове
    let allAdminFiles = [];
    const filesData = await apiRequest('/api/v1/admin/files');
    allAdminFiles = filesData.files || [];
    document.getElementById('adminTotalFilesCount').textContent = allAdminFiles.length;

    const renderAdminFiles = (filesList) => {
      const tbody = document.getElementById('adminFilesTableBody');
      const emptyMsg = document.getElementById('adminEmptyFilesMessage');
      tbody.innerHTML = '';

      if (filesList.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
      }
      emptyMsg.classList.add('hidden');

      for (const file of filesList) {
        const tr = document.createElement('tr');
        const checksumShort = file.checksumSha256 ? `${file.checksumSha256.slice(0, 10)}...` : '—';
        tr.innerHTML = `
          <td>📄 <strong>${file.name}</strong></td>
          <td>
            <div>👤 <strong>${file.ownerName}</strong></div>
            <small style="color:#6c757d;">${file.ownerEmail}</small>
          </td>
          <td>📁 ${file.folderName}</td>
          <td>${formatBytes(file.sizeBytes)}</td>
          <td><span class="badge">v${file.version}</span></td>
          <td><span class="checksum-badge" title="${file.checksumSha256}">${checksumShort}</span></td>
          <td><small>${new Date(file.createdAt).toLocaleString('bg-BG')}</small></td>
          <td>
            <div class="action-buttons">
              <button class="btn-icon" title="Свали файл (Администратор)" onclick="downloadFile('${file.id}')">⬇️</button>
              <button class="btn-icon" title="История на версиите" onclick="openVersionsModal('${file.id}', '${file.name}')">⏱️</button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      }
    };

    renderAdminFiles(allAdminFiles);

    // Търсене в списъка на администратора
    const adminSearchInput = document.getElementById('adminFileSearchInput');
    if (adminSearchInput) {
      adminSearchInput.oninput = () => {
        const q = adminSearchInput.value.trim().toLowerCase();
        if (!q) {
          renderAdminFiles(allAdminFiles);
          return;
        }
        const filtered = allAdminFiles.filter(f =>
          f.name.toLowerCase().includes(q) ||
          f.ownerName.toLowerCase().includes(q) ||
          f.ownerEmail.toLowerCase().includes(q) ||
          f.folderName.toLowerCase().includes(q) ||
          (f.checksumSha256 && f.checksumSha256.toLowerCase().includes(q))
        );
        renderAdminFiles(filtered);
      };
    }

    // 4. Одит дневник
    const auditData = await apiRequest('/api/v1/audit/logs?limit=40');
    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    for (const log of auditData.logs) {
      const tr = document.createElement('tr');
      const timeStr = new Date(log.timestamp).toLocaleTimeString('bg-BG');
      const isOk = log.result === 'SUCCESS';
      tr.innerHTML = `
        <td>${timeStr}</td>
        <td><strong>${log.action}</strong></td>
        <td>${log.actorRole ? `${log.actorRole} (${log.actorId ? log.actorId.slice(0, 8) : 'anon'})` : 'anonym'}</td>
        <td>${log.targetType || '—'}</td>
        <td><span style="color:${isOk ? 'green' : 'red'}; font-weight:600;">${log.result}</span></td>
        <td><code>${log.ipAddress || '—'}</code></td>
        <td style="font-size:0.8rem;">${log.details ? JSON.stringify(log.details) : '—'}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

window.simulateNodeFault = async (nodeId) => {
  try {
    await apiRequest(`/api/v1/storage/nodes/${nodeId}/fault`, { method: 'POST' });
    showToast(`Симулиран е хардуерен отказ на Възел #${nodeId + 1}`, 'warning');
    loadAdminData();
  } catch (e) { showToast(e.message, 'error'); }
};

window.restoreNode = async (nodeId) => {
  try {
    await apiRequest(`/api/v1/storage/nodes/${nodeId}/restore`, { method: 'POST' });
    showToast(`Възел #${nodeId + 1} е успешно възстановен в клъстера`, 'success');
    loadAdminData();
  } catch (e) { showToast(e.message, 'error'); }
};

// -------------------------------------------------------------
// Инициализация на събития при зареждане
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Проверка за активна сесия
  updateUiForSession();

  // Превключване на табовете за вход / регистрация
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const linkGoToRegister = document.getElementById('linkGoToRegister');
  const linkGoToLogin = document.getElementById('linkGoToLogin');

  const showLoginForm = () => {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
  };

  const showRegisterForm = () => {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    registerForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  };

  tabLogin.onclick = showLoginForm;
  tabRegister.onclick = showRegisterForm;
  if (linkGoToRegister) linkGoToRegister.onclick = showRegisterForm;
  if (linkGoToLogin) linkGoToLogin.onclick = showLoginForm;

  // Демо бутони за бързо попълване
  const setupDemoBtn = (btnId, email, pass, label) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.onclick = () => {
        document.getElementById('loginEmail').value = email;
        document.getElementById('loginPassword').value = pass;
        showToast(`Попълнени са данните за: ${label}`, 'info');
      };
    }
  };

  setupDemoBtn('demoStudentBtn', 'student@tu-sofia.bg', 'StudentPass123!', 'Студент');
  setupDemoBtn('demoAdminBtn', 'admin@tu-sofia.bg', 'AdminPassword123!', 'Администратор');
  setupDemoBtn('demoColleagueBtn', 'colleague@tu-sofia.bg', 'ColleaguePass123!', 'Колега');

  // Submit на формата за вход
  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
      const data = await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password }
      });
      setSession(data.accessToken, data.refreshToken, data.user);
      showToast(`Добре дошли, ${data.user.fullName}!`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Submit на формата за регистрация (с автоматичен незабавен вход)
  registerForm.onsubmit = async (e) => {
    e.preventDefault();
    const fullName = document.getElementById('regFullName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;

    try {
      const data = await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: { fullName, email, password }
      });

      if (data.accessToken && data.user) {
        setSession(data.accessToken, data.refreshToken, data.user);
        showToast(`Успешна регистрация! Добре дошли, ${data.user.fullName}!`, 'success');
      } else {
        showToast('Регистрацията е успешна! Моля, влезте в профила си.', 'success');
        showLoginForm();
        document.getElementById('loginEmail').value = email;
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  document.getElementById('logoutBtn').onclick = logout;

  // Създаване на нова папка
  const folderModal = document.getElementById('folderModal');
  const newFolderNameInput = document.getElementById('newFolderNameInput');

  document.getElementById('createFolderBtn').onclick = () => {
    newFolderNameInput.value = '';
    folderModal.classList.remove('hidden');
    newFolderNameInput.focus();
  };

  document.getElementById('cancelFolderModalBtn').onclick = () => {
    folderModal.classList.add('hidden');
  };

  document.getElementById('confirmFolderModalBtn').onclick = async () => {
    const name = newFolderNameInput.value.trim();
    if (!name) return;

    try {
      await apiRequest('/api/v1/folders', {
        method: 'POST',
        body: { name, parentId: state.currentFolderId }
      });
      folderModal.classList.add('hidden');
      showToast(`Създадена е папка "${name}"`, 'success');
      loadFolderContents();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Качване чрез бутон
  const hiddenFileInput = document.getElementById('hiddenFileInput');
  document.getElementById('uploadTriggerBtn').onclick = () => hiddenFileInput.click();
  hiddenFileInput.onchange = (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  };

  // Drag & Drop
  const dropZone = document.getElementById('dropZone');
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
  dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };
  dropZone.onclick = () => hiddenFileInput.click();

  // Навигация в страничната лента (Sidebar Navigation)
  const navFilesBtn = document.getElementById('navFilesBtn');
  const navSharedBtn = document.getElementById('navSharedBtn');
  const navTrashBtn = document.getElementById('navTrashBtn');
  const navAdminFilesBtn = document.getElementById('navAdminFilesBtn');

  const setActiveNav = (activeBtn) => {
    [navFilesBtn, navSharedBtn, navTrashBtn, navAdminFilesBtn].forEach(b => {
      if (b) b.classList.remove('active');
    });
    if (activeBtn) activeBtn.classList.add('active');
  };

  if (navFilesBtn) {
    navFilesBtn.onclick = () => {
      state.activeView = 'files';
      state.currentFolderId = null;
      setActiveNav(navFilesBtn);
      loadFolderContents();
    };
  }

  if (navSharedBtn) {
    navSharedBtn.onclick = () => {
      state.activeView = 'shared';
      setActiveNav(navSharedBtn);
      loadSharedContents();
    };
  }

  if (navTrashBtn) {
    navTrashBtn.onclick = () => {
      state.activeView = 'trash';
      setActiveNav(navTrashBtn);
      loadTrashContents();
    };
  }

  if (navAdminFilesBtn) {
    navAdminFilesBtn.onclick = () => {
      state.activeView = 'adminFiles';
      setActiveNav(navAdminFilesBtn);
      loadAdminFilesView();
    };
  }

  // Търсене в реално време
  const searchInput = document.getElementById('searchInput');
  let searchTimeout = null;
  searchInput.oninput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (!q) {
        if (state.activeView === 'files') loadFolderContents();
        else if (state.activeView === 'shared') loadSharedContents();
        else if (state.activeView === 'trash') loadTrashContents();
        return;
      }
      try {
        const results = await apiRequest(`/api/v1/search?q=${encodeURIComponent(q)}`);
        renderFilesTable(results.folders, results.files);
      } catch (e) { showToast(e.message, 'error'); }
    }, 300);
  };
});
