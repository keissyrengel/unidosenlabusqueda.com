const API_BASE = 'https://unidosenlabusqueda.morning-hall-4207.workers.dev';

// ---------- STATE ----------
let state = {
  view: 'search',
  foundPersons: [],
  missingReports: [],
  loading: true,
  searchQuery: '',
  adminLoggedIn: false,
};
let csvPreviewState = null;

// ⚠️ Cambia estas credenciales si quieres. ADMIN_API_KEY debe coincidir EXACTO
// con el secreto ADMIN_KEY que configures en el Worker.
const ADMIN_EMAIL = 'keissy.rengel@yahoo.com';
const ADMIN_PASSWORD = 'RescateVZLA123*';
const ADMIN_API_KEY = ADMIN_PASSWORD;

function normalize(str) {
  return (str || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function normalizeHeader(h) {
  return normalize(h).replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function getField(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k].toString().trim() !== '') return row[k].toString().trim();
  }
  return '';
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function showToast(msg) {
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast">${msg}</div>`;
  setTimeout(() => { root.innerHTML = ''; }, 2400);
}

// ---------- CUSTOM CONFIRM DIALOG ----------
function showConfirmDialog(message, confirmLabel, onConfirm) {
  const html = `
    <div class="confirm-overlay" id="confirmOverlay">
      <div class="confirm-box">
        <p>${esc(message)}</p>
        <div class="row-actions">
          <button class="btn-secondary btn" id="confirmCancelBtn" style="flex:1;">Cancelar</button>
          <button class="btn-danger btn" id="confirmOkBtn" style="flex:1;">${esc(confirmLabel || 'Confirmar')}</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('confirmRoot').innerHTML = html;
  document.getElementById('confirmCancelBtn').onclick = closeConfirm;
  document.getElementById('confirmOverlay').onclick = (e) => { if (e.target.id === 'confirmOverlay') closeConfirm(); };
  document.getElementById('confirmOkBtn').onclick = async () => {
    closeConfirm();
    await onConfirm();
  };
}
function closeConfirm() {
  document.getElementById('confirmRoot').innerHTML = '';
}

// ---------- BACKEND (Cloudflare Worker + KV) ----------
async function loadData() {
  state.loading = true;
  render();
  try {
    const res = await fetch(`${API_BASE}/api/found-persons`);
    state.foundPersons = res.ok ? await res.json() : [];
  } catch (e) {
    state.foundPersons = [];
  }
  try {
    const res = await fetch(`${API_BASE}/api/missing-reports`);
    state.missingReports = res.ok ? await res.json() : [];
  } catch (e) {
    state.missingReports = [];
  }
  state.loading = false;
  render();
}

// Admin: reemplaza la lista completa de encontrados.
async function saveFoundPersons() {
  try {
    await fetch(`${API_BASE}/api/found-persons`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify(state.foundPersons),
    });
  } catch (e) {
    showToast('Error guardando. Revisa tu conexión.');
  }
}

// Admin: reemplaza la lista completa de desaparecidos (resolver / eliminar / importar CSV).
async function saveMissingReportsAdmin() {
  try {
    await fetch(`${API_BASE}/api/missing-reports`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify(state.missingReports),
    });
  } catch (e) {
    showToast('Error guardando. Revisa tu conexión.');
  }
}

// Público: agrega un nuevo reporte de desaparecido (no requiere admin).
async function postNewMissingReport(report) {
  try {
    const res = await fetch(`${API_BASE}/api/missing-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (res.ok) {
      state.missingReports = await res.json();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Admin: notifica por WhatsApp (vía GoHighLevel) cuando se resuelve un reporte.
async function notifyReporter(payload) {
  try {
    await fetch(`${API_BASE}/api/notify-resolved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_API_KEY },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Falla silenciosa: no bloqueamos el flujo del admin si el webhook no responde.
  }
}

// ---------- PHOTO RESIZE ----------
function resizeImage(file, maxSize, cb) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > h && w > maxSize) { h *= maxSize / w; w = maxSize; }
      else if (h > maxSize) { w *= maxSize / h; h = maxSize; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ---------- RENDER: TABBAR ----------
function renderTabbar() {
  const tabs = [
    { id: 'search', icon: '🔍', label: 'Buscar' },
    { id: 'missing', icon: '📋', label: 'Desaparecidos' },
    { id: 'admin', icon: '🔐', label: 'Admin' },
  ];
  document.getElementById('tabbar').innerHTML = tabs.map(t => `
    <button class="tab ${state.view === t.id ? 'active' : ''}" data-tab="${t.id}">
      <span class="tab-icon">${t.icon}</span>
      <span>${t.label}</span>
    </button>
  `).join('');
  document.querySelectorAll('.tab').forEach(btn => {
    btn.onclick = () => { state.view = btn.dataset.tab; render(); };
  });
}

// ---------- RENDER: SEARCH VIEW ----------
function renderSearchView() {
  const q = normalize(state.searchQuery);
  const results = q ? state.foundPersons.filter(p =>
    normalize(p.name).includes(q) || (p.cedula && normalize(p.cedula).includes(q))
  ) : state.foundPersons;

  let html = `
    <div class="search-bar">
      <input id="searchInput" type="text" placeholder="Buscar por nombre o cédula..." value="${state.searchQuery.replace(/"/g, '&quot;')}">
    </div>
  `;

  if (state.loading) {
    html += `<div class="loading">Cargando registros...</div>`;
  } else if (results.length === 0) {
    html += `
      <div class="empty-state">
        <div class="icon">🕊️</div>
        <p>${q ? 'No encontramos a esta persona en los registros de rescatados.' : 'Aún no hay personas registradas como encontradas.'}</p>
        ${q ? `<button class="btn btn-block" id="btnReportMissing" style="margin-top:10px;">Reportar como desaparecido</button>` : ''}
      </div>
    `;
  } else {
    results.forEach(p => {
      const isDeceased = p.status === 'deceased';
      const cardClass = p.reunited ? 'card-reunited' : (isDeceased ? 'card-deceased' : 'card-alive');
      html += `
        <div class="card ${cardClass}">
          <div class="person-row">
            <div class="person-info">
              <p class="person-name">${esc(p.name)}</p>
              <p class="person-meta">Edad: ${esc(p.age) || 'N/D'}</p>
              ${p.cedula ? `<p class="person-meta">Cédula: ${esc(p.cedula)}</p>` : ''}
              <p class="person-meta">📍 Encontrado en: ${esc(p.foundLocation) || 'N/D'}</p>
              <p class="person-meta">🏥 Ubicación actual: ${esc(p.currentLocation) || 'N/D'}</p>
              ${p.notes ? `<p class="person-meta">${esc(p.notes)}</p>` : ''}
              <span class="badge ${isDeceased ? 'badge-deceased' : 'badge-alive'}">
                ${isDeceased ? '✝ Encontrado sin vida' : '✓ Encontrado con vida'}
              </span>
              ${p.reunited ? `<div class="reunited-banner">🏠 Ya está con su familia — no es necesario seguir buscándola ni compartiendo su información.</div>` : ''}
            </div>
          </div>
        </div>
      `;
    });
    if (q) {
      html += `<p style="text-align:center;color:var(--text-light);font-size:0.83rem;margin-top:6px;">¿No es la persona que buscas?</p>
      <button class="btn-outline btn btn-block" id="btnReportMissing">Reportar como desaparecido</button>`;
    }
  }

  document.getElementById('app').innerHTML = html;

  const input = document.getElementById('searchInput');
  if (input) {
    input.oninput = (e) => { state.searchQuery = e.target.value; render(); };
    if (document.activeElement !== input) {
      const len = input.value.length;
      input.focus();
      input.setSelectionRange(len, len);
    }
  }
  const btnReport = document.getElementById('btnReportMissing');
  if (btnReport) btnReport.onclick = () => openMissingForm();
}

// ---------- RENDER: MISSING VIEW ----------
function renderMissingView() {
  let html = `<div class="section-title">Personas reportadas como desaparecidas</div>
    <button class="btn btn-block" id="btnNewMissing" style="margin-bottom:14px;">+ Reportar persona desaparecida</button>`;

  if (state.loading) {
    html += `<div class="loading">Cargando...</div>`;
  } else if (state.missingReports.length === 0) {
    html += `<div class="empty-state"><div class="icon">📋</div><p>No hay reportes de personas desaparecidas todavía.</p></div>`;
  } else {
    const sorted = [...state.missingReports].sort((a, b) => (b.dateReported || '').localeCompare(a.dateReported || ''));
    sorted.forEach(m => {
      html += `
        <div class="card">
          <div class="person-row">
            ${m.photo ? `<img class="person-photo" src="${m.photo}">` : `<div class="person-photo"></div>`}
            <div class="person-info">
              <p class="person-name">${esc(m.name)}</p>
              <p class="person-meta">Edad: ${esc(m.age) || 'N/D'}</p>
              ${m.cedula ? `<p class="person-meta">Cédula: ${esc(m.cedula)}</p>` : ''}
              <p class="person-meta">📍 Visto por última vez: ${esc(m.lastSeenLocation) || 'N/D'}</p>
              ${m.description ? `<p class="person-meta">${esc(m.description)}</p>` : ''}
              ${m.reporterContact ? `<p class="person-meta">📞 Contacto: ${esc(m.reporterContact)}</p>` : ''}
              <span class="badge ${m.resolved ? 'badge-resolved' : 'badge-pending'}">
                ${m.resolved ? '✓ Resuelto' : '⏳ Buscando'}
              </span>
            </div>
          </div>
        </div>
      `;
    });
  }

  document.getElementById('app').innerHTML = html;
  document.getElementById('btnNewMissing').onclick = () => openMissingForm();
}

// ---------- MODAL: REPORT MISSING ----------
function openMissingForm() {
  let photoData = '';
  const html = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <button class="modal-close" id="modalClose">×</button>
        <h2>Reportar persona desaparecida</h2>
        <div class="form-group">
          <label>Nombre completo *</label>
          <input id="m_name" type="text" placeholder="Nombre y apellido">
        </div>
        <div class="form-group">
          <label>Edad</label>
          <input id="m_age" type="text" placeholder="Edad aproximada">
        </div>
        <div class="form-group">
          <label>Cédula (si la tienes a mano)</label>
          <input id="m_cedula" type="text" placeholder="V-12345678">
        </div>
        <div class="form-group">
          <label>Lugar donde se encontraba / fue visto por última vez *</label>
          <input id="m_location" type="text" placeholder="Ej: Edificio Las Brisas, La Guaira">
        </div>
        <div class="form-group">
          <label>Descripción adicional (ropa, señas, circunstancias)</label>
          <textarea id="m_description" placeholder="Cualquier detalle que ayude a identificarlo/a"></textarea>
        </div>
        <div class="form-group">
          <label>Fotografía</label>
          <div class="photo-upload" id="photoUploadBox">
            <span>📷 Toca para subir una foto</span>
            <input type="file" id="m_photo" accept="image/*" style="display:none;">
            <img id="photoPreview" class="photo-preview" style="display:none;">
          </div>
        </div>
        <div class="form-group">
          <label>Tu contacto (teléfono o correo)</label>
          <input id="m_contact" type="text" placeholder="Para que puedan contactarte si hay información">
        </div>
        <button class="btn btn-block" id="m_submit">Enviar reporte</button>
      </div>
    </div>
  `;
  document.getElementById('modalRoot').innerHTML = html;
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').onclick = (e) => { if (e.target.id === 'modalOverlay') closeModal(); };

  document.getElementById('photoUploadBox').onclick = (e) => {
    if (e.target.id !== 'm_photo') document.getElementById('m_photo').click();
  };
  document.getElementById('m_photo').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resizeImage(file, 400, (dataUrl) => {
      photoData = dataUrl;
      const preview = document.getElementById('photoPreview');
      preview.src = dataUrl;
      preview.style.display = 'block';
    });
  };

  async function finalizeSaveMissing(report) {
    const ok = await postNewMissingReport(report);
    if (!ok) {
      showToast('No se pudo enviar el reporte. Intenta de nuevo.');
      return;
    }
    closeModal();
    state.view = 'missing';
    state.searchQuery = '';
    render();
    showToast('Reporte enviado. Gracias.');
  }

  document.getElementById('m_submit').onclick = async () => {
    const name = document.getElementById('m_name').value.trim();
    const location = document.getElementById('m_location').value.trim();
    if (!name || !location) {
      showToast('Por favor completa nombre y lugar.');
      return;
    }
    const contact = document.getElementById('m_contact').value.trim();
    const report = {
      id: uid(),
      name,
      age: document.getElementById('m_age').value.trim(),
      cedula: document.getElementById('m_cedula').value.trim(),
      lastSeenLocation: location,
      description: document.getElementById('m_description').value.trim(),
      contact,
      reporterContact: contact,
      photo: photoData,
      dateReported: new Date().toISOString(),
      resolved: false,
    };

    const dupMatchesMissing = checkDuplicates(report, state.missingReports, 'lastSeenLocation');
    if (dupMatchesMissing.length > 0) {
      showConfirmDialog(
        `⚠️ Posible duplicado: ya hay un reporte con ${dupMatchesMissing.join(' / ')}. ¿Deseas enviar este reporte igual?`,
        'Enviar igual',
        async () => { await finalizeSaveMissing(report); }
      );
      return;
    }
    await finalizeSaveMissing(report);
  };
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

// ---------- RENDER: ADMIN VIEW ----------
function renderAdminView() {
  if (!state.adminLoggedIn) {
    document.getElementById('app').innerHTML = `
      <div class="login-box">
        <div class="alert">⚠️ Acceso solo para coordinadores/voluntarios autorizados.</div>
        <div class="form-group">
          <label>Correo</label>
          <input id="admin_email" type="email" placeholder="correo@ejemplo.com">
        </div>
        <div class="form-group">
          <label>Contraseña</label>
          <input id="admin_pass" type="password" placeholder="Contraseña">
        </div>
        <button class="btn btn-block" id="admin_login_btn">Iniciar sesión</button>
      </div>
    `;
    document.getElementById('admin_login_btn').onclick = () => {
      const email = document.getElementById('admin_email').value.trim();
      const pass = document.getElementById('admin_pass').value;
      if (email === ADMIN_EMAIL && pass === ADMIN_PASSWORD) {
        state.adminLoggedIn = true;
        render();
      } else {
        showToast('Credenciales incorrectas.');
      }
    };
    return;
  }

  let html = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <div class="section-title" style="margin:0;">Panel de administración</div>
      <button class="btn-secondary btn btn-sm" id="admin_logout">Salir</button>
    </div>
    <button class="btn btn-block" id="btnAddFound" style="margin-bottom:10px;">+ Registrar persona encontrada</button>

    <div class="card csv-box">
      <p class="section-title" style="margin-top:0;">📤 Carga masiva por CSV</p>
      <p class="person-meta" style="margin-bottom:12px;">Sube un archivo CSV para agregar varias personas a la vez. Si alguien ya existe (mismo nombre + misma cédula o mismo lugar), te avisamos antes de importar.</p>
      <button class="btn-outline btn btn-block" id="btnCsvFound" style="margin-bottom:8px;">Cargar CSV — Personas encontradas</button>
      <button class="btn-outline btn btn-block" id="btnCsvMissing" style="margin-bottom:10px;">Cargar CSV — Personas desaparecidas</button>
      <div class="row-actions">
        <button class="btn-secondary btn btn-sm" id="btnTemplateFound">Plantilla CSV encontrados</button>
        <button class="btn-secondary btn btn-sm" id="btnTemplateMissing">Plantilla CSV desaparecidos</button>
      </div>
      <input type="file" id="csvFoundInput" accept=".csv" style="display:none;">
      <input type="file" id="csvMissingInput" accept=".csv" style="display:none;">
    </div>

    <div class="section-title" style="margin-top:18px;">Personas encontradas (${state.foundPersons.length})</div>
  `;

  if (state.foundPersons.length === 0) {
    html += `<p style="color:var(--text-light); font-size:0.85rem;">Aún no hay registros.</p>`;
  } else {
    [...state.foundPersons].reverse().forEach(p => {
      const isDeceased = p.status === 'deceased';
      const cardClass = p.reunited ? 'card-reunited' : (isDeceased ? 'card-deceased' : 'card-alive');
      html += `
        <div class="card ${cardClass}">
          <p class="person-name">${esc(p.name)}</p>
          <p class="person-meta">Edad: ${esc(p.age) || 'N/D'} · Encontrado en: ${esc(p.foundLocation) || 'N/D'}</p>
          ${p.cedula ? `<p class="person-meta">Cédula: ${esc(p.cedula)}</p>` : ''}
          <p class="person-meta">Ubicación actual: ${esc(p.currentLocation) || 'N/D'}</p>
          <span class="badge ${isDeceased ? 'badge-deceased' : 'badge-alive'}">
            ${isDeceased ? '✝ Sin vida' : '✓ Con vida'}
          </span>
          ${p.reunited ? `<span class="badge badge-reunited">🏠 Con su familia</span>` : ''}
          <div class="row-actions">
            <button class="btn-outline btn btn-sm" data-edit-found="${p.id}">Editar</button>
            ${p.reunited
              ? `<button class="btn-secondary btn btn-sm" data-undo-reunited="${p.id}">Deshacer "con familia"</button>`
              : `<button class="btn-indigo btn btn-sm" data-mark-reunited="${p.id}">🏠 Marcar con su familia</button>`}
            <button class="btn-danger btn btn-sm" data-del-found="${p.id}">Eliminar</button>
          </div>
        </div>
      `;
    });
  }

  html += `<div class="section-title" style="margin-top:22px;">Reportes de desaparecidos (${state.missingReports.length})</div>`;
  if (state.missingReports.length === 0) {
    html += `<p style="color:var(--text-light); font-size:0.85rem;">No hay reportes.</p>`;
  } else {
    [...state.missingReports].reverse().forEach(m => {
      html += `
        <div class="card">
          <div class="person-row">
            ${m.photo ? `<img class="person-photo" src="${m.photo}">` : `<div class="person-photo"></div>`}
            <div class="person-info">
              <p class="person-name">${esc(m.name)}</p>
              ${m.cedula ? `<p class="person-meta">Cédula: ${esc(m.cedula)}</p>` : ''}
              <p class="person-meta">Último lugar visto: ${esc(m.lastSeenLocation) || 'N/D'}</p>
              <span class="badge ${m.resolved ? 'badge-resolved' : 'badge-pending'}">
                ${m.resolved ? '✓ Resuelto' : '⏳ Buscando'}
              </span>
              <div class="row-actions">
                ${!m.resolved ? `<button class="btn btn-sm" data-resolve-missing="${m.id}">Marcar resuelto</button>` : ''}
                <button class="btn-danger btn btn-sm" data-del-missing="${m.id}">Eliminar</button>
              </div>
            </div>
          </div>
        </div>
      `;
    });
  }

  html += `
    <div style="margin-top:24px;">
      <button class="btn-outline btn btn-block" id="btnExport">⬇ Exportar respaldo (JSON)</button>
    </div>
  `;

  document.getElementById('app').innerHTML = html;

  document.getElementById('admin_logout').onclick = () => { state.adminLoggedIn = false; render(); };
  document.getElementById('btnAddFound').onclick = () => openFoundForm();
  document.getElementById('btnExport').onclick = exportBackup;

  document.getElementById('btnCsvFound').onclick = () => document.getElementById('csvFoundInput').click();
  document.getElementById('btnCsvMissing').onclick = () => document.getElementById('csvMissingInput').click();
  document.getElementById('csvFoundInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleCsvUpload(file, 'found');
    e.target.value = '';
  };
  document.getElementById('csvMissingInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleCsvUpload(file, 'missing');
    e.target.value = '';
  };
  document.getElementById('btnTemplateFound').onclick = () => downloadTemplate('found');
  document.getElementById('btnTemplateMissing').onclick = () => downloadTemplate('missing');

  document.querySelectorAll('[data-edit-found]').forEach(btn => {
    btn.onclick = () => openFoundForm(btn.dataset.editFound);
  });
  document.querySelectorAll('[data-del-found]').forEach(btn => {
    btn.onclick = () => {
      showConfirmDialog('¿Eliminar este registro de persona encontrada?', 'Eliminar', async () => {
        state.foundPersons = state.foundPersons.filter(p => p.id !== btn.dataset.delFound);
        await saveFoundPersons();
        render();
        showToast('Registro eliminado.');
      });
    };
  });
  document.querySelectorAll('[data-mark-reunited]').forEach(btn => {
    btn.onclick = () => toggleReunited(btn.dataset.markReunited, true);
  });
  document.querySelectorAll('[data-undo-reunited]').forEach(btn => {
    btn.onclick = () => toggleReunited(btn.dataset.undoReunited, false);
  });
  document.querySelectorAll('[data-resolve-missing]').forEach(btn => {
    btn.onclick = () => openResolveForm(btn.dataset.resolveMissing);
  });
  document.querySelectorAll('[data-del-missing]').forEach(btn => {
    btn.onclick = () => {
      showConfirmDialog('¿Eliminar este reporte de persona desaparecida?', 'Eliminar', async () => {
        state.missingReports = state.missingReports.filter(m => m.id !== btn.dataset.delMissing);
        await saveMissingReportsAdmin();
        render();
        showToast('Reporte eliminado.');
      });
    };
  });
}

async function toggleReunited(id, value) {
  const p = state.foundPersons.find(p => p.id === id);
  if (!p) return;
  p.reunited = value;
  await saveFoundPersons();
  render();
  showToast(value ? '🏠 Marcado como "con su familia". Ya no es necesario seguir compartiendo su búsqueda.' : 'Se deshizo la marca de "con su familia".');
}

function exportBackup() {
  const data = { foundPersons: state.foundPersons, missingReports: state.missingReports, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `respaldo_reencuentros_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- CSV TEMPLATES ----------
function downloadTemplate(type) {
  let csvContent;
  if (type === 'found') {
    csvContent = 'nombre,edad,cedula,lugar_encontrado,ubicacion_actual,estado,notas\n' +
      'Juan Pérez,34,V-12345678,Edificio Las Brisas La Guaira,Hospital Central sala 4,con vida,Ejemplo de registro\n';
  } else {
    csvContent = 'nombre,edad,cedula,ultimo_lugar,descripcion,contacto\n' +
      'María Gómez,29,V-87654321,Edificio Las Brisas La Guaira,Cabello castaño suéter azul,0412-1234567\n';
  }
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = type === 'found' ? 'plantilla_personas_encontradas.csv' : 'plantilla_personas_desaparecidas.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- CSV ROW MAPPING ----------
function mapRowToFound(row) {
  let statusRaw = normalize(getField(row, ['estado', 'status']));
  let status = 'alive';
  if (statusRaw.includes('fallec') || statusRaw.includes('muert') || statusRaw.includes('sin_vida') || statusRaw.includes('sinvida') || statusRaw.includes('deceased')) {
    status = 'deceased';
  }
  return {
    name: getField(row, ['nombre', 'name', 'nombre_completo']),
    age: getField(row, ['edad', 'age']),
    cedula: getField(row, ['cedula', 'ci', 'cedula_de_identidad']),
    foundLocation: getField(row, ['lugar_encontrado', 'lugardondefueencontrado', 'lugar', 'found_location']),
    currentLocation: getField(row, ['ubicacion_actual', 'ubicacionactual', 'current_location', 'ubicacion']),
    status,
    notes: getField(row, ['notas', 'notes', 'observaciones']),
  };
}
function mapRowToMissing(row) {
  return {
    name: getField(row, ['nombre', 'name', 'nombre_completo']),
    age: getField(row, ['edad', 'age']),
    cedula: getField(row, ['cedula', 'ci', 'cedula_de_identidad']),
    lastSeenLocation: getField(row, ['ultimo_lugar', 'ultimolugarvisto', 'lugar', 'last_seen_location']),
    description: getField(row, ['descripcion', 'description', 'observaciones']),
    contact: getField(row, ['contacto', 'contact', 'telefono', 'email']),
  };
}

// ---------- CSV DUPLICATE CHECK ----------
function checkDuplicates(record, combinedList, locationField) {
  const matches = [];
  if (!record.name) return matches;
  combinedList.forEach(existing => {
    if (!existing.name || normalize(existing.name) !== normalize(record.name)) return;
    let matchCount = 1;
    const details = ['mismo nombre'];
    if (record.cedula && existing.cedula && normalize(record.cedula) === normalize(existing.cedula)) {
      matchCount++;
      details.push('misma cédula');
    }
    const newLoc = record[locationField];
    const exLoc = existing[locationField];
    if (newLoc && exLoc && normalize(newLoc) === normalize(exLoc)) {
      matchCount++;
      details.push('mismo lugar/edificio');
    }
    if (matchCount >= 2) {
      matches.push(details.join(' + '));
    }
  });
  return matches;
}

// ---------- CSV UPLOAD HANDLER ----------
function handleCsvUpload(file, type) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
    complete: (results) => {
      const mapped = (results.data || [])
        .map(row => type === 'found' ? mapRowToFound(row) : mapRowToMissing(row))
        .filter(r => r.name);
      if (mapped.length === 0) {
        showToast('No se encontraron filas válidas con nombre en el CSV.');
        return;
      }
      openCsvPreview(mapped, type);
    },
    error: () => showToast('Error leyendo el archivo CSV.'),
  });
}

// ---------- MODAL: CSV PREVIEW ----------
function openCsvPreview(mappedRecords, type) {
  const locationField = type === 'found' ? 'foundLocation' : 'lastSeenLocation';
  const existing = type === 'found' ? state.foundPersons : state.missingReports;
  const combinedList = [...existing];

  const rowsWithMatches = mappedRecords.map(rec => {
    const matches = checkDuplicates(rec, combinedList, locationField);
    combinedList.push(rec);
    return { record: rec, matches };
  });

  csvPreviewState = { rowsWithMatches, type, locationField };
  const dupCount = rowsWithMatches.filter(r => r.matches.length > 0).length;

  let html = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <button class="modal-close" id="modalClose">×</button>
        <h2>Revisar carga: ${type === 'found' ? 'personas encontradas' : 'personas desaparecidas'}</h2>
        <p class="person-meta" style="margin-bottom:12px;">
          ${rowsWithMatches.length} fila(s) leídas. ${dupCount > 0 ? `⚠️ ${dupCount} con posible duplicado (vienen desmarcadas — revísalas antes de incluirlas).` : 'No se detectaron duplicados.'}
        </p>
  `;

  rowsWithMatches.forEach((item, idx) => {
    const isDup = item.matches.length > 0;
    html += `
      <div class="card csv-row-card ${isDup ? 'is-dup' : ''}">
        <label class="csv-checkbox-label">
          <input type="checkbox" data-csv-row="${idx}" ${isDup ? '' : 'checked'} style="margin-top:3px; width:18px; height:18px;">
          <span style="flex:1;">
            <span class="person-name">${esc(item.record.name)}</span>
            <p class="person-meta">Edad: ${esc(item.record.age) || 'N/D'}${item.record.cedula ? ' · Cédula: ' + esc(item.record.cedula) : ''}</p>
            <p class="person-meta">${esc(item.record[locationField]) || 'Sin ubicación registrada'}</p>
            ${isDup
              ? `<span class="badge badge-pending">⚠️ Posible duplicado: ${esc(item.matches.join(' / '))}</span>`
              : `<span class="badge badge-alive">✓ Nuevo</span>`}
          </span>
        </label>
      </div>
    `;
  });

  html += `
        <button class="btn btn-block" id="csvImportSubmit" style="margin-top:10px;">Importar seleccionados</button>
      </div>
    </div>
  `;

  document.getElementById('modalRoot').innerHTML = html;
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').onclick = (e) => { if (e.target.id === 'modalOverlay') closeModal(); };

  document.getElementById('csvImportSubmit').onclick = async () => {
    const checkboxes = document.querySelectorAll('[data-csv-row]');
    let importedCount = 0;
    checkboxes.forEach(cb => {
      if (!cb.checked) return;
      const idx = parseInt(cb.dataset.csvRow, 10);
      const rec = csvPreviewState.rowsWithMatches[idx].record;
      if (type === 'found') {
        state.foundPersons.push({
          id: uid(),
          name: rec.name,
          age: rec.age,
          cedula: rec.cedula,
          foundLocation: rec.foundLocation,
          currentLocation: rec.currentLocation,
          status: rec.status || 'alive',
          notes: rec.notes,
          reunited: false,
          dateAdded: new Date().toISOString(),
        });
      } else {
        state.missingReports.push({
          id: uid(),
          name: rec.name,
          age: rec.age,
          cedula: rec.cedula,
          lastSeenLocation: rec.lastSeenLocation,
          description: rec.description,
          contact: rec.contact,
          reporterContact: rec.contact,
          photo: '',
          dateReported: new Date().toISOString(),
          resolved: false,
        });
      }
      importedCount++;
    });

    if (type === 'found') await saveFoundPersons();
    else await saveMissingReportsAdmin();

    closeModal();
    render();
    showToast(`${importedCount} persona(s) importada(s) correctamente.`);
  };
}

// ---------- MODAL: ADD/EDIT FOUND PERSON ----------
function openFoundForm(editId) {
  const editing = editId ? state.foundPersons.find(p => p.id === editId) : null;
  const html = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <button class="modal-close" id="modalClose">×</button>
        <h2>${editing ? 'Editar registro' : 'Registrar persona encontrada'}</h2>
        <div class="form-group">
          <label>Nombre completo *</label>
          <input id="f_name" type="text" value="${editing ? esc(editing.name) : ''}">
        </div>
        <div class="form-group">
          <label>Edad</label>
          <input id="f_age" type="text" value="${editing ? esc(editing.age) : ''}">
        </div>
        <div class="form-group">
          <label>Cédula (si se tiene esa información)</label>
          <input id="f_cedula" type="text" placeholder="V-12345678" value="${editing ? esc(editing.cedula) : ''}">
        </div>
        <div class="form-group">
          <label>Lugar donde fue encontrado *</label>
          <input id="f_foundLocation" type="text" value="${editing ? esc(editing.foundLocation) : ''}">
        </div>
        <div class="form-group">
          <label>Ubicación actual</label>
          <input id="f_currentLocation" type="text" placeholder="Ej: Hospital Central, sala 4" value="${editing ? esc(editing.currentLocation) : ''}">
        </div>
        <div class="form-group">
          <label>Estado</label>
          <div class="status-toggle" id="statusToggle">
            <label class="opt-alive ${(!editing || editing.status === 'alive') ? 'checked' : ''}">
              <input type="radio" name="status" value="alive" ${(!editing || editing.status === 'alive') ? 'checked' : ''}>
              <span>✓ Con vida</span>
            </label>
            <label class="opt-deceased ${editing && editing.status === 'deceased' ? 'checked' : ''}">
              <input type="radio" name="status" value="deceased" ${editing && editing.status === 'deceased' ? 'checked' : ''}>
              <span>✝ Sin vida</span>
            </label>
          </div>
        </div>
        <div class="form-group">
          <label>Notas adicionales</label>
          <textarea id="f_notes">${editing ? esc(editing.notes) : ''}</textarea>
        </div>
        <button class="btn btn-block" id="f_submit">${editing ? 'Guardar cambios' : 'Registrar'}</button>
      </div>
    </div>
  `;
  document.getElementById('modalRoot').innerHTML = html;
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').onclick = (e) => { if (e.target.id === 'modalOverlay') closeModal(); };

  document.querySelectorAll('#statusToggle label').forEach(lbl => {
    lbl.onclick = () => {
      document.querySelectorAll('#statusToggle label').forEach(l => l.classList.remove('checked'));
      lbl.classList.add('checked');
    };
  });

  async function finalizeSaveFound(record) {
    if (editing) {
      const idx = state.foundPersons.findIndex(p => p.id === editing.id);
      state.foundPersons[idx] = record;
    } else {
      state.foundPersons.push(record);
    }
    await saveFoundPersons();
    closeModal();
    render();
    showToast(editing ? 'Registro actualizado.' : 'Persona registrada.');
  }

  document.getElementById('f_submit').onclick = async () => {
    const name = document.getElementById('f_name').value.trim();
    const foundLocation = document.getElementById('f_foundLocation').value.trim();
    if (!name || !foundLocation) {
      showToast('Completa nombre y lugar donde fue encontrado.');
      return;
    }
    const status = document.querySelector('input[name="status"]:checked').value;
    const record = {
      id: editing ? editing.id : uid(),
      name,
      age: document.getElementById('f_age').value.trim(),
      cedula: document.getElementById('f_cedula').value.trim(),
      foundLocation,
      currentLocation: document.getElementById('f_currentLocation').value.trim(),
      status,
      notes: document.getElementById('f_notes').value.trim(),
      reunited: editing ? !!editing.reunited : false,
      dateAdded: editing ? editing.dateAdded : new Date().toISOString(),
    };

    const othersForCheck = state.foundPersons.filter(p => !editing || p.id !== editing.id);
    const dupMatchesFound = checkDuplicates(record, othersForCheck, 'foundLocation');
    if (dupMatchesFound.length > 0) {
      showConfirmDialog(
        `⚠️ Posible duplicado: ya existe un registro con ${dupMatchesFound.join(' / ')}. ¿Deseas guardar este registro igual?`,
        'Guardar igual',
        async () => { await finalizeSaveFound(record); }
      );
      return;
    }
    await finalizeSaveFound(record);
  };
}

// ---------- MODAL: RESOLVE MISSING REPORT ----------
function openResolveForm(missingId) {
  const report = state.missingReports.find(m => m.id === missingId);
  if (!report) return;
  const html = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <button class="modal-close" id="modalClose">×</button>
        <h2>Marcar como resuelto</h2>
        <p class="person-meta" style="margin-bottom:14px;">${esc(report.name)} — visto por última vez en: ${esc(report.lastSeenLocation) || 'N/D'}</p>
        <div class="form-group">
          <label>¿Fue encontrado con vida o sin vida? *</label>
          <div class="status-toggle" id="resolveStatusToggle">
            <label class="opt-alive checked">
              <input type="radio" name="resolveStatus" value="alive" checked>
              <span>✓ Con vida</span>
            </label>
            <label class="opt-deceased">
              <input type="radio" name="resolveStatus" value="deceased">
              <span>✝ Sin vida</span>
            </label>
          </div>
        </div>
        <div class="form-group">
          <label>Cédula (si se tiene esa información)</label>
          <input id="resolve_cedula" type="text" placeholder="V-12345678" value="${esc(report.cedula)}">
        </div>
        <div class="form-group">
          <label>¿Dónde se encuentra ahora? *</label>
          <input id="resolve_location" type="text" placeholder="Ej: Hospital Central, sala 4 / Morgue de Bello Monte">
        </div>
        <div class="form-group">
          <label>Notas adicionales (opcional)</label>
          <textarea id="resolve_notes"></textarea>
        </div>
        <button class="btn btn-block" id="resolve_submit">Confirmar y agregar a encontrados</button>
      </div>
    </div>
  `;
  document.getElementById('modalRoot').innerHTML = html;
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').onclick = (e) => { if (e.target.id === 'modalOverlay') closeModal(); };

  document.querySelectorAll('#resolveStatusToggle label').forEach(lbl => {
    lbl.onclick = () => {
      document.querySelectorAll('#resolveStatusToggle label').forEach(l => l.classList.remove('checked'));
      lbl.classList.add('checked');
    };
  });

  document.getElementById('resolve_submit').onclick = async () => {
    const location = document.getElementById('resolve_location').value.trim();
    if (!location) {
      showToast('Por favor indica dónde se encuentra ahora.');
      return;
    }
    const status = document.querySelector('input[name="resolveStatus"]:checked').value;
    const notes = document.getElementById('resolve_notes').value.trim();
    const cedula = document.getElementById('resolve_cedula').value.trim();

    const foundRecord = {
      id: uid(),
      name: report.name,
      age: report.age,
      cedula,
      foundLocation: report.lastSeenLocation,
      currentLocation: location,
      status,
      notes: notes || 'Agregado desde reporte de desaparecido resuelto.',
      reunited: false,
      dateAdded: new Date().toISOString(),
    };
    state.foundPersons.push(foundRecord);
    await saveFoundPersons();

    report.resolved = true;
    if (cedula) report.cedula = cedula;
    await saveMissingReportsAdmin();

    if (report.contact) {
      await notifyReporter({
        name: report.name,
        contact: report.contact,
        status,
        currentLocation: location,
        foundLocation: report.lastSeenLocation,
        notes,
      });
    }

    closeModal();
    render();
    showToast('Persona agregada a la lista de encontrados.');
  };
}

// ---------- UTIL ----------
function esc(str) {
  if (str === undefined || str === null) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- MAIN RENDER ----------
function render() {
  renderTabbar();
  if (state.view === 'search') renderSearchView();
  else if (state.view === 'missing') renderMissingView();
  else if (state.view === 'admin') renderAdminView();

  const app = document.getElementById('app');
  const note = document.createElement('div');
  note.className = 'footer-note';
  note.textContent = 'Herramienta comunitaria — no es un canal oficial. Para emergencias contacta a Protección Civil o Cruz Roja.';
  app.appendChild(note);
}

loadData();
