import {
  createRequest, analyzeRequest, approvalBlockers, approveRequest,
  markSent, recordOutcome, getMetrics, findSimilarQuotes, FIELD_LABELS,
} from './core.mjs';
import { saveDrawing, getDrawing } from './files.mjs';

const STORAGE_KEY = 'autoparts-fastquote-v1';
const ROLE_KEY = 'autoparts-fastquote-role-v1';
const root = document.getElementById('app');
const statuses = {
  received: ['접수', 'primary'], needs_review: ['확인 필요', 'warning'],
  approved: ['승인 완료', 'success'], sent: ['발송 완료', 'primary'],
  won: ['수주', 'success'], lost: ['실주', 'danger'],
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function money(value) { return Number(value || 0).toLocaleString('ko-KR') + '원'; }
function dateTime(value) { return value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function ago(value) {
  const hours = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 3_600_000));
  return hours < 24 ? `${hours}시간 경과` : `${Math.floor(hours / 24)}일 경과`;
}
function badge(status) { const [label, tone] = statuses[status] || ['접수', 'primary']; return `<span class="badge ${tone}">${label}</span>`; }

function sampleRequests() {
  const now = Date.now();
  const at = hours => new Date(now - hours * 3_600_000).toISOString();
  const a = { ...createRequest({ customer: '샘플 협력사 A', part: '샤프트', aiAllowed: true, fileName: '샘플_샤프트.pdf' }, at(2), 'DEMO-101'), demo: true, demoText: 'SHAFT S45C Ø12 x 80 mm 공차 ±0.05 수량 100EA' };
  const b = { ...createRequest({ customer: '샘플 협력사 B', part: '브라켓', aiAllowed: true, fileName: '샘플_브라켓.pdf' }, at(18), 'DEMO-102'), demo: true, fields: { material: 'SUS304', dimensions: '32 x 58 mm', tolerance: '', quantity: '80' }, status: 'needs_review', notes: '공차 표기 확인 필요' };
  let c = { ...createRequest({ customer: '샘플 협력사 C', part: '샤프트', aiAllowed: false, fileName: '샘플_완료.pdf' }, at(48), 'DEMO-103'), demo: true, fields: { material: 'S45C', dimensions: 'Ø12 x 80 mm', tolerance: '±0.05', quantity: '100' }, price: 520000, leadDays: 7 };
  c = recordOutcome(markSent(approveRequest(c, 'owner', at(26)), 'staff', at(25)), 'won', at(10));
  return [a, b, c];
}

function loadRequests() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : sampleRequests();
  } catch { return sampleRequests(); }
}
const state = {
  requests: loadRequests(),
  role: localStorage.getItem(ROLE_KEY) === 'owner' ? 'owner' : 'staff',
  view: 'list', selectedId: null, search: '', filter: 'all', modal: null,
  busy: false, pdfUrl: null, pdfId: null, toastTimer: null,
};
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.requests)); }
  catch { notify('브라우저 저장 공간이 부족합니다. 자료를 백업해 주세요.'); }
}
function updateRequest(request) {
  const index = state.requests.findIndex(item => item.id === request.id);
  if (index >= 0) state.requests[index] = request;
  persist(); render();
}
function current() { return state.requests.find(item => item.id === state.selectedId); }
function notify(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = message;
  document.body.append(el); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.remove(), 3600);
}

function renderShell() {
  const viewName = state.view === 'metrics' ? '성과 현황' : state.view === 'guide' ? '사용 안내' : state.view === 'detail' ? '견적 상세' : '견적 요청';
  root.innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span><span>빠른견적</span></div>
      <div class="nav-label">WORKSPACE</div>
      <nav class="nav" aria-label="주 메뉴">
        <button class="${['list','detail'].includes(state.view) ? 'active' : ''}" data-nav="list"><span class="nav-icon" aria-hidden="true">▦</span>견적 요청</button>
        <button class="${state.view === 'metrics' ? 'active' : ''}" data-nav="metrics"><span class="nav-icon" aria-hidden="true">◫</span>성과 현황</button>
        <button class="${state.view === 'guide' ? 'active' : ''}" data-nav="guide"><span class="nav-icon" aria-hidden="true">ⓘ</span>사용 안내</button>
      </nav>
      <div class="sidebar-foot"><strong>사내 시범용 웹앱</strong>도면과 견적 정보는 이 브라우저에 저장됩니다. 다른 PC와 공유되지 않습니다.</div>
    </aside>
    <div class="main">
      <header class="topbar"><div class="breadcrumb">업무센터 <span aria-hidden="true"> / </span> <strong>${viewName}</strong></div>
        <div class="top-actions"><select class="role-switch" id="role-switch" aria-label="시연 역할 전환"><option value="staff" ${state.role === 'staff' ? 'selected' : ''}>사무직원 모드</option><option value="owner" ${state.role === 'owner' ? 'selected' : ''}>대표 모드</option></select><span class="avatar" aria-hidden="true">${state.role === 'owner' ? '대' : '사'}</span></div>
      </header>
      <main class="content" id="page-content">${state.view === 'detail' ? renderDetail() : state.view === 'metrics' ? renderMetrics() : state.view === 'guide' ? renderGuide() : renderList()}</main>
    </div>
  </div>${renderModal()}`;
}

function renderDemoNotice() {
  const count = state.requests.filter(item => item.demo).length;
  if (!count) return '';
  return `<div class="notice"><div><strong>시연 데이터 ${count}건</strong><br>샘플 협력사와 수치는 기능 시연용입니다. 실제 성과로 해석하지 마세요. 새 견적은 이 브라우저에만 저장됩니다.</div><button class="btn ghost small" data-action="remove-demo">시연 데이터 지우기</button></div>`;
}

function renderStats() {
  const m = getMetrics(state.requests);
  const pending = state.requests.filter(item => ['received', 'needs_review'].includes(item.status)).length;
  return `<div class="stats">
    <div class="stat"><div class="stat-label">전체 견적 요청</div><div class="stat-value">${m.requests}<span style="font-size:16px">건</span></div><div class="stat-foot">등록된 모든 견적</div></div>
    <div class="stat"><div class="stat-label">검토 대기</div><div class="stat-value">${pending}<span style="font-size:16px">건</span></div><div class="stat-foot">접수 · 확인 필요</div></div>
    <div class="stat"><div class="stat-label">평균 회신시간</div><div class="stat-value">${m.averageHours ?? '—'}${m.averageHours === null ? '' : '<span style="font-size:16px">시간</span>'}</div><div class="stat-foot">목표 <strong>4시간</strong></div></div>
    <div class="stat"><div class="stat-label">요청 대비 수주율</div><div class="stat-value">${m.winRate}<span style="font-size:16px">%</span></div><div class="stat-foot">목표 <strong>50%</strong></div></div>
  </div>`;
}

function filtered() {
  return [...state.requests].filter(item => {
    const q = state.search.toLowerCase();
    return (!q || `${item.customer} ${item.part} ${item.id}`.toLowerCase().includes(q)) && (state.filter === 'all' || item.status === state.filter);
  }).sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}
function renderList() {
  const rows = filtered();
  return `<div class="page-head"><div><div class="eyebrow">QUOTE WORKSPACE</div><h1>견적 요청을 한눈에</h1><p class="subhead">도면 접수부터 최종 발송까지, 놓치는 견적 없이 관리하세요.</p></div><button class="btn primary" data-action="new">새 견적 등록</button></div>
    ${renderDemoNotice()}${renderStats()}
    <section class="card"><div class="toolbar"><div class="toolbar-title"><h2>견적 요청 목록</h2><span class="count">${rows.length}</span></div><div class="filters"><input class="search" id="search" type="search" placeholder="거래처 · 품목 검색" value="${escapeHtml(state.search)}" aria-label="견적 검색"><select class="filter-select" id="status-filter" aria-label="상태 필터"><option value="all">전체 상태</option>${Object.entries(statuses).map(([key, [label]]) => `<option value="${key}" ${state.filter === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>견적 번호 · 품목</th><th>거래처</th><th>접수 시각</th><th>상태</th><th>경과 시간</th><th class="text-right">최종 금액</th></tr></thead><tbody>${rows.map(item => `<tr data-open="${escapeHtml(item.id)}" tabindex="0"><td><div class="cell-main">${escapeHtml(item.part)}</div><div class="cell-sub">${escapeHtml(item.id)}${item.demo ? ' · 시연' : ''}</div></td><td>${escapeHtml(item.customer)}</td><td>${dateTime(item.receivedAt)}</td><td>${badge(item.status)}</td><td class="muted">${item.sentAt ? '회신 완료' : ago(item.receivedAt)}</td><td class="text-right price">${item.price ? money(item.price) : '—'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><div class="empty-symbol">▤</div><strong>표시할 견적이 없습니다</strong>새 견적을 등록하거나 검색 조건을 바꿔 보세요.</div>`}
    </section>`;
}

function renderDetail() {
  const item = current();
  if (!item) { state.view = 'list'; return renderList(); }
  const blockers = approvalBlockers(item);
  const similar = findSimilarQuotes(item, state.requests);
  const isOwner = state.role === 'owner';
  return `<div class="page-head"><div><button class="btn ghost small" data-nav="list">목록으로 돌아가기</button><div class="eyebrow" style="margin-top:14px">${escapeHtml(item.id)} ${item.demo ? '· 시연 데이터' : ''}</div><h1>${escapeHtml(item.part)} 견적 검토</h1><p class="subhead">${escapeHtml(item.customer)} · ${dateTime(item.receivedAt)} 접수</p></div><div class="button-row">${badge(item.status)}<span class="badge ${item.aiAllowed ? 'primary' : 'warning'}">${item.aiAllowed ? '자동 판독 허용' : '직접 검토'}</span></div></div>
    ${item.demo ? renderDemoNotice() : ''}
    <div class="detail-grid">
      <section class="card pdf-pane"><div class="pane-head"><div><h3>원본 도면</h3><small>${escapeHtml(item.fileName || '도면 없음')}</small></div>${item.fileName && !item.demo ? '<span class="badge">브라우저 내부 파일</span>' : ''}</div><div id="pdf-slot" class="pdf-empty">${item.demo ? '시연용 기록입니다.<br>실제 PDF 파일은 포함되어 있지 않습니다.' : '도면을 불러오는 중입니다.'}</div></section>
      <div class="stack">
        <section class="card card-pad"><div class="section-head"><h2>도면 검토표</h2>${item.aiAllowed && !['approved','sent','won','lost'].includes(item.status) ? `<button class="btn outline small" data-action="analyze" ${state.busy ? 'disabled' : ''}>${state.busy ? '판독 중…' : '도면 텍스트 판독'}</button>` : ''}</div>
          ${!item.aiAllowed ? '<div class="notice warning"><div><strong>자동 판독을 사용하지 않습니다.</strong><br>거래처 도면의 처리 허용 여부에 따라 대표가 직접 확인합니다.</div></div>' : '<p class="small-text muted">읽을 수 있는 PDF 텍스트의 형식만 찾아 채웁니다. 모든 값은 대표가 원본과 대조해야 합니다.</p>'}
          <div class="field-grid">${Object.entries(FIELD_LABELS).map(([key, label]) => `<div class="field"><label for="field-${key}">${label} *</label><input id="field-${key}" data-field="${key}" value="${escapeHtml(item.fields?.[key] || '')}" placeholder="직접 확인 후 입력" ${isOwner && !['approved','sent','won','lost'].includes(item.status) ? '' : 'disabled'}><div class="field-note">${item.evidence?.[key] ? `판독 근거: ${escapeHtml(item.evidence[key])}` : '확인 필요 · 원본 도면과 대조'}</div></div>`).join('')}</div>
          <hr class="divider"><div class="field"><label for="notes">확인 메모</label><textarea id="notes" data-prop="notes" placeholder="고객에게 확인할 내용이나 가공 조건을 적어 주세요.">${escapeHtml(item.notes || '')}</textarea></div>
        </section>
        <section class="card card-pad"><div class="section-head"><h2>유사 견적 근거</h2><span class="badge">${similar.length}건</span></div>${similar.length ? `<div class="similar-list">${similar.map(past => `<div class="similar"><div><strong>${escapeHtml(past.part)} · ${escapeHtml(past.customer)}</strong><small>${escapeHtml(past.fields?.material || '재질 미확인')} / ${escapeHtml(past.fields?.dimensions || '치수 미확인')} / 납기 ${escapeHtml(past.leadDays)}일</small></div><span class="price">${money(past.price)}</span></div>`).join('')}</div><p class="field-note">과거 승인 이력의 참고값입니다. 현재 가격을 자동 확정하지 않습니다.</p>` : '<p class="small-text muted">조건이 연결된 과거 승인 견적이 없습니다. 대표가 직접 산출해 주세요.</p>'}</section>
        <section class="card card-pad"><div class="section-head"><h2>최종 견적</h2><span class="badge ${item.approvedAt ? 'success' : ''}">${item.approvedAt ? '대표 승인됨' : '대표 승인 전'}</span></div>
          <div class="field-grid"><div class="field"><label for="price">최종 가격 (원) *</label><input id="price" data-prop="price" type="number" min="1" step="1" value="${escapeHtml(item.price)}" placeholder="대표 입력" ${isOwner && !item.approvedAt ? '' : 'disabled'}></div><div class="field"><label for="leadDays">납기 (일) *</label><input id="leadDays" data-prop="leadDays" type="number" min="1" step="1" value="${escapeHtml(item.leadDays)}" placeholder="대표 입력" ${isOwner && !item.approvedAt ? '' : 'disabled'}></div></div>
          ${blockers.length && !item.approvedAt ? `<div class="blockers" style="margin-top:16px"><strong>승인 전 확인</strong><br>${blockers.map(escapeHtml).join(' · ')}</div>` : ''}
          ${item.sentAt ? `<hr class="divider"><div class="field"><label for="outcomeReason">수주·실주 메모</label><input id="outcomeReason" data-prop="outcomeReason" value="${escapeHtml(item.outcomeReason || '')}" placeholder="예: 납기 조건 변경"></div>` : ''}
          <div class="action-bar"><span class="small-text muted">${item.approvedAt ? `승인 ${dateTime(item.approvedAt)}` : '가격·납기는 대표가 최종 결정합니다.'}</span><div class="button-row">
            ${!item.approvedAt && isOwner ? '<button class="btn outline" data-action="save-review">입력 저장·검토</button>' : ''}
            ${!item.approvedAt && isOwner ? `<button class="btn primary" data-action="approve" ${blockers.length ? 'disabled' : ''}>대표 승인</button>` : ''}
            ${item.status === 'approved' ? `<button class="btn outline" data-action="copy-quote">발송용 내용 복사</button>${!isOwner ? '<button class="btn primary" data-action="sent">발송 완료 기록</button>' : ''}` : ''}
            ${item.status === 'sent' ? '<button class="btn outline" data-action="lost">실주 기록</button><button class="btn primary" data-action="won">수주 기록</button>' : ''}
          </div></div>
        </section>
      </div>
    </div>
    <section class="card card-pad" style="margin-top:18px"><h2>진행 이력</h2><div class="timeline"><div class="timeline-item"><strong>접수</strong>${dateTime(item.receivedAt)}</div><div class="timeline-item"><strong>대표 승인</strong>${dateTime(item.approvedAt)}</div><div class="timeline-item"><strong>발송</strong>${dateTime(item.sentAt)}</div></div></section>`;
}

function renderMetrics() {
  const m = getMetrics(state.requests);
  const counts = Object.entries(statuses).map(([key, [label]]) => ({ label, count: state.requests.filter(item => item.status === key).length }));
  return `<div class="page-head"><div><div class="eyebrow">PERFORMANCE</div><h1>견적 성과 현황</h1><p class="subhead">접수부터 발송까지의 실제 기록으로 시간을 계산합니다.</p></div></div>${renderDemoNotice()}${renderStats()}
    <div class="detail-grid"><section class="card card-pad"><h2>진행 상태</h2>${counts.map(item => `<div class="chart-row"><span>${item.label}</span><div class="bar-track"><div class="bar-fill" style="width:${m.requests ? Math.max(0, item.count / m.requests * 100) : 0}%"></div></div><strong>${item.count}건</strong></div>`).join('')}</section>
    <section class="card card-pad"><h2>측정 기준</h2><p class="small-text">평균 회신시간 = 발송된 견적의 (발송 시각 − 접수 시각) 평균</p><p class="small-text">수주율 = 수주 건수 ÷ 같은 기간 견적 요청 건수 × 100</p><hr class="divider"><p class="small-text muted">기준값: 평균 2일 · 수주율 35%<br>목표값: 평균 4시간 · 수주율 50%</p><p class="small-text muted">시연 데이터가 포함된 경우 이 화면의 수치는 실제 사업 성과가 아닙니다.</p></section></div>`;
}

function renderGuide() {
  return `<div class="page-head"><div><div class="eyebrow">GETTING STARTED</div><h1>사용 안내</h1><p class="subhead">작은 팀이 견적을 놓치지 않도록 만든 시범 버전입니다.</p></div></div>
    <div class="detail-grid"><section class="card card-pad"><h2>견적 처리 흐름</h2><ol class="small-text" style="line-height:2"><li>사무직원이 거래처·품목·PDF 도면을 등록합니다.</li><li>허용된 도면만 텍스트 판독을 시도합니다.</li><li>대표가 도면과 검토표를 대조하고 가격·납기를 승인합니다.</li><li>사무직원이 승인된 내용을 기존 채널로 발송하고 결과를 기록합니다.</li></ol><div class="notice warning"><div><strong>자동 판독의 범위</strong><br>이 버전은 새 AI API 없이 PDF의 텍스트를 규칙으로 찾아냅니다. 이미지로 스캔된 도면, 복잡한 도형·공차는 직접 확인해야 합니다.</div></div></section>
    <section class="card card-pad"><h2>저장과 권한</h2><p class="small-text">견적 내용은 브라우저 저장소에, 첨부 PDF는 같은 브라우저의 IndexedDB에 보관됩니다. 서버로 도면을 업로드하지 않습니다.</p><p class="small-text">역할 전환은 시연용이며 실제 사용자 인증이 아닙니다. 고객사의 실운영에는 계정·권한·백업 체계를 별도로 붙여야 합니다.</p><p class="small-text muted">창의 사생활 보호 모드나 브라우저 데이터 삭제 시 기록이 사라질 수 있습니다. 현재 버전에는 여러 PC 간 공유가 없습니다.</p></section></div>`;
}

function renderModal() {
  if (!state.modal) return '';
  if (state.modal === 'new') return `<div class="modal-backdrop" data-backdrop="true"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">새 견적 등록</h2><p>거래처 요청과 도면을 등록합니다. PDF는 이 브라우저에만 보관됩니다.</p><form id="new-form"><div class="field-grid"><div class="field"><label for="new-customer">거래처 *</label><input id="new-customer" name="customer" required maxlength="80" placeholder="예: ○○정밀"></div><div class="field"><label for="new-part">품목 *</label><input id="new-part" name="part" required maxlength="80" placeholder="예: 브라켓"></div><div class="field full"><label for="new-file">도면 PDF *</label><input id="new-file" name="file" type="file" accept="application/pdf,.pdf" required><span class="field-note">최대 20MB · PDF 텍스트만 판독 가능</span></div><div class="field full"><label class="check-row"><input type="checkbox" name="aiAllowed">거래처가 도면의 자동 텍스트 판독을 허용함</label><span class="field-note">허용하지 않으면 대표의 직접 검토 경로로 진행합니다.</span></div></div><div class="modal-actions"><button type="button" class="btn outline" data-action="close-modal">취소</button><button type="submit" class="btn primary">견적 등록</button></div></form></div></div>`;
  if (state.modal === 'approve') return `<div class="modal-backdrop" data-backdrop="true"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">최종 견적을 승인할까요?</h2><p>대표가 원본 도면, 사양, 가격과 납기를 모두 확인했는지 점검해 주세요. 승인 후 사무직원이 발송용 내용을 복사할 수 있습니다.</p><div class="modal-actions"><button class="btn outline" data-action="close-modal">취소</button><button class="btn primary" data-action="confirm-approve">승인 확정</button></div></div></div>`;
  return '';
}

async function hydratePdf() {
  if (state.view !== 'detail') return;
  const item = current();
  const slot = document.getElementById('pdf-slot');
  if (!item || !slot || item.demo) return;
  try {
    if (state.pdfId !== item.id) {
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = null; state.pdfId = item.id;
      const file = await getDrawing(item.id);
      if (!file || state.selectedId !== item.id) { slot.textContent = '저장된 도면을 찾을 수 없습니다. 원본 파일을 확인해 주세요.'; return; }
      state.pdfUrl = URL.createObjectURL(file);
    }
    const frame = document.createElement('iframe'); frame.className = 'pdf-frame'; frame.title = `${item.part} 원본 도면 PDF`; frame.src = state.pdfUrl;
    slot.replaceWith(frame);
  } catch { slot.textContent = '브라우저에서 PDF를 열지 못했습니다. 원본 파일을 직접 확인해 주세요.'; }
}

function render() { renderShell(); hydratePdf(); }

async function extractPdfText(file) {
  const pdfjs = await import('./vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const chunks = [];
  for (let pageNo = 1; pageNo <= Math.min(pdf.numPages, 10); pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    chunks.push(content.items.map(item => item.str || '').join(' '));
  }
  return chunks.join(' ');
}

function quoteText(item) {
  return `견적서 초안\n거래처: ${item.customer}\n품목: ${item.part}\n재질: ${item.fields.material}\n치수: ${item.fields.dimensions}\n공차: ${item.fields.tolerance}\n수량: ${item.fields.quantity}\n최종 가격: ${money(item.price)}\n납기: ${item.leadDays}일\n대표 승인: ${dateTime(item.approvedAt)}\n\n본 내용은 승인된 견적의 발송용 초안입니다.`;
}

root.addEventListener('click', async event => {
  const nav = event.target.closest('[data-nav]');
  if (nav) { state.view = nav.dataset.nav; state.selectedId = null; render(); return; }
  const row = event.target.closest('[data-open]');
  if (row) { state.selectedId = row.dataset.open; state.view = 'detail'; render(); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) { if (event.target.dataset.backdrop) { state.modal = null; render(); } return; }
  const item = current();
  try {
    if (action === 'new') { state.modal = 'new'; render(); document.getElementById('new-customer')?.focus(); }
    if (action === 'close-modal') { state.modal = null; render(); }
    if (action === 'remove-demo') { state.requests = state.requests.filter(request => !request.demo); persist(); render(); notify('시연 데이터를 지웠습니다.'); }
    if (action === 'analyze' && item) {
      if (!item.aiAllowed) throw new Error('자동 판독이 허용되지 않은 도면입니다.');
      state.busy = true; render();
      const file = item.demo ? null : await getDrawing(item.id);
      if (!file && !item.demoText) throw new Error('PDF 파일을 찾을 수 없습니다.');
      const text = item.demoText || await extractPdfText(file);
      const updated = analyzeRequest(item, text);
      state.busy = false; updateRequest(updated);
      notify(text.trim() ? '텍스트 판독을 마쳤습니다. 원본과 대조해 주세요.' : '읽을 수 있는 텍스트가 없어 직접 입력이 필요합니다.');
    }
    if (action === 'save-review' && item) {
      if (state.role !== 'owner' || item.approvedAt) throw new Error('대표가 승인 전 견적만 수정할 수 있습니다.');
      const fields = Object.fromEntries(Object.keys(FIELD_LABELS).map(key => [key, document.getElementById(`field-${key}`)?.value.trim() || '']));
      const updated = {
        ...item, fields, notes: document.getElementById('notes')?.value.trim() || '',
        price: document.getElementById('price')?.value.trim() || '',
        leadDays: document.getElementById('leadDays')?.value.trim() || '',
        status: 'needs_review',
      };
      updateRequest(updated);
      notify(approvalBlockers(updated).length ? '입력값을 저장했습니다. 남은 확인 항목을 점검해 주세요.' : '입력값을 저장했습니다. 대표 승인이 가능합니다.');
    }
    if (action === 'approve' && item) { if (state.role !== 'owner') throw new Error('대표 모드에서 승인해 주세요.'); state.modal = 'approve'; render(); }
    if (action === 'confirm-approve' && item) { const approved = approveRequest(item, state.role); state.modal = null; updateRequest(approved); notify('대표 승인이 기록됐습니다.'); }
    if (action === 'copy-quote' && item) { await navigator.clipboard.writeText(quoteText(item)); notify('발송용 견적 내용이 복사됐습니다.'); }
    if (action === 'sent' && item) { updateRequest(markSent(item, state.role)); notify('발송 시각을 기록했습니다.'); }
    if (action === 'won' && item) { updateRequest(recordOutcome(item, 'won')); notify('수주로 기록했습니다.'); }
    if (action === 'lost' && item) { updateRequest(recordOutcome(item, 'lost')); notify('실주로 기록했습니다.'); }
  } catch (error) { state.busy = false; render(); notify(error.message || '작업을 완료하지 못했습니다.'); }
});

root.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.modal) { state.modal = null; render(); }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open]')) { event.preventDefault(); state.selectedId = event.target.dataset.open; state.view = 'detail'; render(); }
});
root.addEventListener('input', event => {
  if (event.target.id === 'search') { const pos = event.target.selectionStart; state.search = event.target.value; render(); const input = document.getElementById('search'); input?.focus(); input?.setSelectionRange(pos, pos); }
});
root.addEventListener('change', event => {
  if (event.target.id === 'role-switch') { state.role = event.target.value === 'owner' ? 'owner' : 'staff'; localStorage.setItem(ROLE_KEY, state.role); render(); return; }
  if (event.target.id === 'status-filter') { state.filter = event.target.value; render(); return; }
  const item = current(); if (!item) return;
  if (event.target.dataset.field) {
    if (state.role !== 'owner' || ['approved','sent','won','lost'].includes(item.status)) return;
    const fields = { ...item.fields, [event.target.dataset.field]: event.target.value.trim() };
    updateRequest({ ...item, fields, status: item.status === 'received' ? 'needs_review' : item.status });
  }
  if (event.target.dataset.prop) {
    const prop = event.target.dataset.prop;
    if (['price','leadDays'].includes(prop) && (state.role !== 'owner' || item.approvedAt)) return;
    updateRequest({ ...item, [prop]: event.target.value.trim() });
  }
});
root.addEventListener('submit', async event => {
  if (event.target.id !== 'new-form') return;
  event.preventDefault();
  const form = event.target; const data = new FormData(form); const file = data.get('file');
  if (!(file instanceof File) || file.size === 0 || !/\.pdf$/i.test(file.name) || file.type && file.type !== 'application/pdf') { notify('PDF 도면 파일을 선택해 주세요.'); return; }
  if (file.size > 20 * 1024 * 1024) { notify('20MB 이하의 PDF를 선택해 주세요.'); return; }
  try {
    const id = `Q-${Date.now().toString(36).toUpperCase()}`;
    const request = createRequest({ customer: data.get('customer'), part: data.get('part'), aiAllowed: data.get('aiAllowed') === 'on', fileName: file.name }, new Date().toISOString(), id);
    await saveDrawing(id, file);
    state.requests.unshift(request); persist(); state.modal = null; state.selectedId = id; state.view = 'detail'; render(); notify('견적을 등록했습니다.');
  } catch (error) { notify(error.message || '견적 등록에 실패했습니다.'); }
});

render();
