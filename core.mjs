export const FIELD_LABELS = {
  material: '재질',
  dimensions: '치수',
  tolerance: '공차',
  quantity: '수량',
};

const REQUIRED_FIELDS = Object.keys(FIELD_LABELS);
const COMPLETED = new Set(['approved', 'sent', 'won', 'lost']);

export function createRequest(input, now = new Date().toISOString(), id = crypto.randomUUID()) {
  const customer = String(input.customer ?? '').trim();
  const part = String(input.part ?? '').trim();
  if (!customer || !part) throw new Error('거래처와 품목을 입력해 주세요.');
  return {
    id,
    customer,
    part,
    aiAllowed: input.aiAllowed === true,
    fileName: input.fileName || '',
    receivedAt: now,
    status: 'received',
    fields: { material: '', dimensions: '', tolerance: '', quantity: '' },
    evidence: {},
    analysisType: 'none',
    notes: '',
    price: '',
    leadDays: '',
    approvedAt: null,
    sentAt: null,
    outcomeAt: null,
  };
}

export function extractSpecs(rawText = '') {
  const text = String(rawText).replace(/\s+/g, ' ').trim();
  const material = text.match(/\b(?:S45C|SS400|SUS\s?304|SUS\s?316|AL\s?6061|A6061|SCM\s?440|SKD\s?11)\b/i);
  const dimensions = text.match(/(?:Ø|Φ|⌀|직경\s*)?\s?\d+(?:\.\d+)?\s?(?:mm)?\s?[xX×*]\s?\d+(?:\.\d+)?(?:\s?[xX×*]\s?\d+(?:\.\d+)?)?\s?(?:mm)?/i);
  const tolerance = text.match(/(?:공차\s*)?±\s?\d+(?:\.\d+)?\s?(?:mm)?/i);
  const quantity = text.match(/(?:수량|주문\s?수량|QTY)\s*[:：]?\s*(\d[\d,]*)\s*(?:EA|PCS|개)?/i);
  const fields = {
    material: material?.[0].replace(/\s/g, '').toUpperCase() || '',
    dimensions: dimensions?.[0].trim() || '',
    tolerance: tolerance?.[0].replace(/^공차\s*/i, '').replace(/\s+/g, '') || '',
    quantity: quantity?.[1].replace(/,/g, '') || '',
  };
  const evidence = {
    material: material?.[0] || '',
    dimensions: dimensions?.[0] || '',
    tolerance: tolerance?.[0] || '',
    quantity: quantity?.[0] || '',
  };
  return { fields, evidence, missing: REQUIRED_FIELDS.filter(key => !fields[key]) };
}

export function analyzeRequest(request, text) {
  if (!request.aiAllowed) throw new Error('이 도면은 자동 판독이 허용되지 않았습니다.');
  if (COMPLETED.has(request.status)) throw new Error('승인된 견적은 다시 판독할 수 없습니다.');
  const result = extractSpecs(text);
  return {
    ...request,
    fields: { ...request.fields, ...Object.fromEntries(Object.entries(result.fields).filter(([, value]) => value)) },
    evidence: result.evidence,
    analysisType: 'text-pattern',
    status: 'needs_review',
  };
}

export function approvalBlockers(request) {
  const blockers = [];
  for (const key of REQUIRED_FIELDS) {
    if (!String(request.fields?.[key] ?? '').trim()) blockers.push(`${FIELD_LABELS[key]} 확인 필요`);
  }
  if (!Number.isFinite(Number(request.price)) || Number(request.price) <= 0) blockers.push('최종 가격 입력 필요');
  if (!Number.isInteger(Number(request.leadDays)) || Number(request.leadDays) <= 0) blockers.push('납기 일수 입력 필요');
  return blockers;
}

export function approveRequest(request, role, now = new Date().toISOString()) {
  if (role !== 'owner') throw new Error('대표만 최종 견적을 승인할 수 있습니다.');
  const blockers = approvalBlockers(request);
  if (blockers.length) throw new Error(blockers.join(' · '));
  return { ...request, status: 'approved', approvedAt: now };
}

export function markSent(request, role, now = new Date().toISOString()) {
  if (role !== 'staff') throw new Error('사무직원만 견적 발송을 기록할 수 있습니다.');
  if (request.status !== 'approved') throw new Error('대표 승인 후 발송을 기록할 수 있습니다.');
  return { ...request, status: 'sent', sentAt: now };
}

export function recordOutcome(request, outcome, now = new Date().toISOString()) {
  if (!['won', 'lost'].includes(outcome)) throw new Error('수주 또는 실주를 선택해 주세요.');
  if (request.status !== 'sent') throw new Error('발송된 견적만 결과를 기록할 수 있습니다.');
  return { ...request, status: outcome, outcomeAt: now };
}

export function getMetrics(requests) {
  const sent = requests.filter(request => request.sentAt && request.receivedAt);
  const hours = sent.map(request => (Date.parse(request.sentAt) - Date.parse(request.receivedAt)) / 3_600_000).filter(value => Number.isFinite(value) && value >= 0);
  const won = requests.filter(request => request.status === 'won').length;
  return {
    requests: requests.length,
    sent: sent.length,
    won,
    averageHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
    winRate: requests.length ? Math.round((won / requests.length) * 1000) / 10 : 0,
  };
}

export function findSimilarQuotes(request, allRequests) {
  const part = String(request.part || '').trim().toLowerCase();
  const material = String(request.fields?.material || '').trim().toLowerCase();
  return allRequests
    .filter(item => item.id !== request.id && COMPLETED.has(item.status) && Number(item.price) > 0)
    .map(item => ({
      item,
      score: (part && item.part?.trim().toLowerCase() === part ? 2 : 0) +
        (material && item.fields?.material?.trim().toLowerCase() === material ? 1 : 0),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.approvedAt || 0) - Date.parse(a.approvedAt || 0))
    .slice(0, 3)
    .map(entry => entry.item);
}
