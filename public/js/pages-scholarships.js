// Scholarships (phase 1): the school's own scholarship opportunities.
import { state, t, h, get, post, put, del, qs, load, field, input, select, textarea, toast, fail, modal, badge, empty, confirmDialog, fmtDate, navigate } from './ui.js';

const CATS = ['academic_merit', 'talent_excellence', 'social_support', 'external'];
const phaseKind = { open: 'green', upcoming: 'blue', deadline_passed: 'neutral', draft: 'neutral', suspended: 'gold', closed: 'neutral' };
const classLabel = (c) => `${c.name}${c.section ? (c.section.length === 1 ? '' : ' ') + c.section : ''}`;
const isAdmin = () => state.user.role === 'school_admin';

export async function scholarshipsPage(ctx, view) {
  const tab = ctx.query.tab === 'applications' ? 'applications' : 'opportunities';
  const bar = h('div', { class: 'tabs', role: 'tablist' }, ['opportunities', 'applications'].map((k) => h('a', { class: 'tab', role: 'tab', 'aria-selected': String(k === tab), href: `#/scholarships${k === 'applications' ? '?tab=applications' : ''}` }, t(`sch.tab_${k}`))));
  const panel = h('div');
  view.replaceChildren(h('div', { class: 'page-head' }, h('div', h('h1', t('nav.scholarships')), h('p', t('sch.subtitle')))), bar, panel);
  if (tab === 'applications') return applicationsTab(panel);
  return opportunitiesTab(panel);
}

function opportunitiesTab(view) {
  const f = { category: '', q: '' };
  const list = h('div');
  const run = () => load(list, () => get(`/scholarships${qs(f)}`), (rows) => rows.length ? h('div', rows.map((s) => card(s, run))) : empty(t('sch.none')));
  const catSel = select([['', t('common.all')], ...CATS.map((c) => [c, t(`sch.cat_${c}`)])], '', { 'aria-label': t('sch.category'), onchange: (e) => { f.category = e.target.value; run(); } });
  const q = input({ placeholder: t('sch.search'), 'aria-label': t('sch.search'), onchange: (e) => { f.q = e.target.value; run(); } });
  view.replaceChildren(
    h('div', { class: 'card', style: { display: 'flex', gap: '.5rem', alignItems: 'end', flexWrap: 'wrap' } }, h('div', { style: { flex: '1 1 12rem' } }, field(t('sch.search'), q)), h('div', { style: { flex: '1 1 12rem' } }, field(t('sch.category'), catSel)),
      isAdmin() ? h('button', { class: 'btn btn-primary', onclick: () => edit(null, run) }, t('sch.new')) : null, isAdmin() ? h('button', { class: 'btn', onclick: reviewers }, t('sch.reviewers')) : null), list);
  run();
}

function card(s, refresh) {
  const act = async (status, label) => { if (!(await confirmDialog(label, t('common.confirm')))) return; try { await post(`/scholarships/${s.id}/status`, { status }); toast(t('common.saved')); refresh(); } catch (e) { fail(e); } };
  const row = (k, v) => (v ? h('p', { style: { margin: '.25rem 0', whiteSpace: 'pre-wrap' } }, h('strong', `${t(k)}: `), v) : null);
  return h('section', { class: 'card', style: { margin: '.6rem 0' } },
    h('div', { style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' } }, h('h2', { style: { flex: '1 1 14rem', margin: 0 } }, s.title), badge(t(`sch.cat_${s.category}`), 'blue'), badge(t(`sch.phase_${s.phase}`), phaseKind[s.phase])),
    h('p', { style: { whiteSpace: 'pre-wrap' } }, s.description),
    row('sch.benefits', s.benefits), row('sch.sponsor', s.sponsor), row('sch.eligibility', s.eligibility_text),
    s.min_average != null ? row('sch.min_average', `${s.min_average}`) : null,
    s.classes && s.classes.length ? row('sch.classes', s.classes.map(classLabel).join(', ')) : null,
    row('sch.documents', s.required_documents), row('sch.renewal', s.renewal_conditions), row('sch.places', String(s.places)),
    s.opens_on || s.closes_on ? row('sch.dates', `${s.opens_on ? fmtDate(s.opens_on) : '—'} → ${s.closes_on ? fmtDate(s.closes_on) : '—'}`) : null,
    ['student', 'parent'].includes(state.user.role) && s.phase === 'open' ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => apply(s) }, t('sch.apply'))) : null,
    isAdmin() ? h('div', { class: 'actions' },
      s.status !== 'closed' ? h('button', { class: 'btn btn-sm', onclick: () => edit(s, refresh) }, t('common.edit')) : null,
      ['draft', 'suspended'].includes(s.status) ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => act('open', t('sch.publish')) }, t('sch.publish')) : null,
      s.status === 'open' ? h('button', { class: 'btn btn-sm', onclick: () => act('suspended', t('sch.suspend')) }, t('sch.suspend')) : null,
      ['open', 'suspended'].includes(s.status) ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => act('closed', t('sch.close')) }, t('sch.close')) : null,
      s.status === 'draft' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await confirmDialog(t('sch.delete'), t('common.remove'))) { try { await del(`/scholarships/${s.id}`); refresh(); } catch (e) { fail(e); } } } }, t('common.remove')) : null) : null);
}

async function edit(s, refresh) {
  const classes = await get('/classes').then((r) => (Array.isArray(r) ? r : r.rows || [])).catch(() => []);
  const v = (k) => (s && s[k] != null ? s[k] : '');
  const title = input({ value: v('title'), maxlength: 160 }), desc = textarea({ rows: 3, maxlength: 3000 }), ben = textarea({ rows: 2, maxlength: 2000 }), spons = input({ value: v('sponsor'), maxlength: 160 });
  const elig = textarea({ rows: 2, maxlength: 2000 }), docs = textarea({ rows: 2, maxlength: 1500 }), ren = textarea({ rows: 2, maxlength: 1500 });
  desc.value = v('description'); ben.value = v('benefits'); elig.value = v('eligibility_text'); docs.value = v('required_documents'); ren.value = v('renewal_conditions');
  const cat = select(CATS.map((c) => [c, t(`sch.cat_${c}`)]), s ? s.category : 'academic_merit'), places = input({ type: 'number', min: 1, value: s ? s.places : 1 }), min = input({ type: 'number', min: 0, step: '0.01', value: v('min_average') });
  const opens = input({ type: 'date', value: v('opens_on') }), closes = input({ type: 'date', value: v('closes_on') });
  const chosen = new Set((s ? s.classes : []).map((c) => c.id));
  const boxes = classes.map((c) => ({ c, el: h('input', { type: 'checkbox', id: `sc${c.id}`, checked: chosen.has(c.id) }) }));
  modal({ title: s ? t('common.edit') : t('sch.new'), wide: true, body: h('div', field(t('sch.title'), title, { required: true }), h('div', { class: 'grid grid-2' }, field(t('sch.category'), cat, { required: true }), field(t('sch.sponsor'), spons)),
    field(t('sch.description'), desc, { required: true }), field(t('sch.benefits'), ben, { required: true }), field(t('sch.eligibility'), elig),
    h('div', { class: 'grid grid-3' }, field(t('sch.places'), places, { required: true }), field(t('sch.min_average'), min), h('span')), h('div', { class: 'grid grid-2' }, field(t('sch.opens_on'), opens), field(t('sch.closes_on'), closes)),
    h('h3', t('sch.classes')), h('p', { class: 'muted small' }, t('sch.classes_hint')), h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.8rem' } }, boxes.map(({ c, el }) => h('span', { class: 'check' }, el, h('label', { for: el.id }, classLabel(c))))),
    field(t('sch.documents'), docs), field(t('sch.renewal'), ren)),
    actions: [{ label: t('common.cancel'), class: 'btn-ghost', onclick: (c) => c() }, { label: t('common.save'), class: 'btn-primary', onclick: async (close) => {
      const data = { title: title.value, description: desc.value, benefits: ben.value, sponsor: spons.value, eligibility_text: elig.value, category: cat.value, places: Number(places.value), min_average: min.value === '' ? null : Number(min.value), opens_on: opens.value, closes_on: closes.value, required_documents: docs.value, renewal_conditions: ren.value, class_ids: boxes.filter((b) => b.el.checked).map((b) => b.c.id) };
      try { if (s) await put(`/scholarships/${s.id}`, data); else await post('/scholarships', data); close(); toast(t('common.saved')); refresh(); } catch (e) { fail(e); } } }] });
}

async function reviewers() {
  const rows = await get('/scholarships-reviewers').catch((e) => { fail(e); return null; });
  if (!rows) return;
  const boxes = rows.map((u) => ({ u, el: h('input', { type: 'checkbox', id: `rv${u.id}`, checked: u.is_reviewer }) }));
  modal({ title: t('sch.reviewers'), body: h('div', h('div', { class: 'notice' }, t('sch.reviewers_note')), rows.length ? boxes.map(({ u, el }) => h('div', { class: 'check' }, el, h('label', { for: el.id }, `${u.name} · ${u.email}`))) : empty(t('disc.no_staff'))),
    actions: [{ label: t('common.cancel'), class: 'btn-ghost', onclick: (c) => c() }, { label: t('common.save'), class: 'btn-primary', onclick: async (c) => { try { await put('/scholarships-reviewers', { user_ids: boxes.filter((b) => b.el.checked).map((b) => b.u.id) }); c(); toast(t('common.saved')); } catch (e) { fail(e); } } }] });
}

// ---------- applications ----------
const appKind = { draft: 'neutral', submitted: 'blue', under_review: 'gold', approved: 'green', rejected: 'red', waitlisted: 'gold' };
const CHECK_KEYS = { open: 'sch.chk_open', active_student: 'sch.chk_active', class: 'sch.chk_class', min_average: 'sch.chk_average' };

async function apply(s) {
  let studentId;
  const body = h('div');
  const showChecks = async () => {
    try {
      const e = await get(`/scholarships/${s.id}/eligibility${qs({ student_id: studentId })}`);
      body.replaceChildren(h('div', h('h3', s.title), e.application ? h('div', { class: 'notice' }, t('sch.already_applied'), ' ', h('a', { href: `#/scholarships/applications/${e.application.id}` }, t('sch.open_application'))) : null,
        h('ul', { class: 'checks' }, e.checks.map((c) => h('li', { style: { margin: '.3rem 0' } }, badge(c.ok ? '✓' : '✕', c.ok ? 'green' : 'red'), ' ', t(CHECK_KEYS[c.key]),
          c.key === 'min_average' ? ` — ${c.detail && c.detail.average != null ? t('sch.avg_detail', { avg: c.detail.average, req: c.detail.required, src: c.detail.source }) : t('sch.avg_none', { req: c.detail.required })}` : ''))),
        e.eligible && !e.application ? h('p', { class: 'muted small' }, t('sch.motivation_next')) : (!e.eligible ? h('p', { class: 'notice notice-gold' }, t('sch.not_eligible_note')) : null)));
      return e;
    } catch (ex) { fail(ex); return null; }
  };
  let children = [];
  if (state.user.role === 'parent') { try { children = (await get('/students?page_size=60&sort=name')).rows; } catch { children = []; } if (!children.length) return toast(t('sch.no_children'), 'error'); studentId = children[0].id; }
  const pick = children.length > 1 ? select(children.map((c) => [c.id, c.full_name]), studentId, { 'aria-label': t('sch.child'), onchange: (ev) => { studentId = ev.target.value; showChecks(); } }) : null;
  const motivation = textarea({ rows: 4, maxlength: 3000, placeholder: t('sch.motivation_ph') });
  const first = await showChecks();
  if (!first) return;
  modal({ title: t('sch.apply'), wide: true, body: h('div', pick ? field(t('sch.child'), pick) : null, body, field(t('sch.motivation'), motivation, { required: true })),
    actions: [{ label: t('common.cancel'), class: 'btn-ghost', onclick: (c) => c() }, { label: t('sch.start_application'), class: 'btn-primary', onclick: async (c) => {
      try { const r = await post('/scholarship-applications', { scholarship_id: s.id, student_id: studentId, motivation: motivation.value }); c(); navigate(`/scholarships/applications/${r.id}`); } catch (ex) { fail(ex); } } }] });
}

function applicationsTab(panel) {
  const f = { status: '', q: '' };
  const list = h('div');
  const run = () => load(list, () => get(`/scholarship-applications${qs(f)}`), (rows) => rows.length ? h('div', rows.map((a) => h('a', { class: 'card', href: `#/scholarships/applications/${a.id}`, style: { display: 'block', margin: '.5rem 0', padding: '.7rem 1rem' } },
    h('div', { style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' } }, h('strong', { style: { flex: '1 1 14rem' } }, `${a.scholarship.title} · ${a.student.full_name}`), badge(t(`sch.app_${a.status}`), appKind[a.status])),
    h('div', { class: 'muted small' }, [a.student.class_label, a.submitted_at ? `${t('sch.submitted_on')} ${fmtDate(a.submitted_at.slice(0, 10))}` : null].filter(Boolean).join(' · '))))) : empty(t('sch.no_applications')));
  const applicant = ['student', 'parent'].includes(state.user.role);
  panel.append(h('div', { class: 'card', style: { display: 'flex', gap: '.5rem', alignItems: 'end', flexWrap: 'wrap' } },
    h('div', { style: { flex: '1 1 12rem' } }, field(t('sch.status'), select([['', t('common.all')], ...Object.keys(appKind).filter((k) => !(state.user.role === 'teacher' && k === 'draft')).map((k) => [k, t(`sch.app_${k}`)])], '', { onchange: (e) => { f.status = e.target.value; run(); } }))),
    !applicant ? h('div', { style: { flex: '1 1 12rem' } }, field(t('sch.search'), input({ placeholder: t('sch.search_student'), onchange: (e) => { f.q = e.target.value; run(); } }))) : null,
    state.user.role === 'teacher' ? h('p', { class: 'muted small' }, t('sch.reviewer_scope')) : null), list);
  run();
}

export async function applicationPage(ctx, view) {
  const id = ctx.params.id, box = h('div');
  const role = state.user.role;
  const run = () => load(box, () => get(`/scholarship-applications/${id}`), (a) => {
    const act = async (fn) => { try { await fn(); toast(t('common.saved')); run(); } catch (e) { fail(e); } };
    const motivation = textarea({ rows: 5, maxlength: 3000, value: a.motivation || '' }); motivation.value = a.motivation || '';
    const parts = [h('div', { class: 'card', style: { display: 'flex', gap: '.6rem', flexWrap: 'wrap', alignItems: 'center' } },
      h('div', { style: { flex: '1 1 14rem' } }, h('h1', { style: { marginBottom: '.2rem' } }, a.scholarship.title), h('p', { class: 'muted', style: { margin: 0 } }, `${a.student.full_name} · ${[a.student.student_code, a.student.class_label].filter(Boolean).join(' · ')}`)), badge(t(`sch.app_${a.status}`), appKind[a.status]))];
    parts.push(h('div', { class: 'card' }, h('h2', t('sch.motivation')), a.can_edit ? h('div', motivation, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => act(() => put(`/scholarship-applications/${a.id}`, { motivation: motivation.value })) }, t('common.save')))) : h('p', { style: { whiteSpace: 'pre-wrap' } }, a.motivation || '—'),
      a.average_at_submission != null ? h('p', { class: 'muted small' }, t('sch.avg_at_submission', { avg: a.average_at_submission, src: a.average_source || '' })) : null));
    // documents
    const file = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', 'aria-label': t('sch.add_document') });
    parts.push(h('div', { class: 'card' }, h('h2', t('sch.app_documents')), a.documents.length ? a.documents.map((d) => h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', padding: '.25rem 0' } },
      h('a', { href: `/api/scholarship-applications/${a.id}/documents/${d.id}`, download: d.original_name, style: { flex: 1 } }, d.original_name), h('span', { class: 'muted small' }, `${Math.ceil(d.size / 1024)} KB`),
      a.can_edit ? h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await confirmDialog(t('sch.remove_document'), t('common.remove'))) act(() => del(`/scholarship-applications/${a.id}/documents/${d.id}`)); } }, t('common.remove')) : null)) : h('p', { class: 'muted' }, t('sch.no_documents')),
      a.can_edit ? h('div', { class: 'actions' }, file, h('button', { class: 'btn', onclick: () => act(async () => { const f = file.files[0]; if (!f) throw new Error('invalid_file'); if (f.size > 3 * 1024 * 1024) throw Object.assign(new Error('file_too_large'), { code: 'file_too_large' });
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); await post(`/scholarship-applications/${a.id}/documents`, { name: f.name, data }); }) }, t('sch.add_document'))) : null,
      a.can_edit ? h('p', { class: 'muted small' }, t('sch.doc_hint')) : null));
    if (a.can_edit) parts.push(h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: async () => { if (await confirmDialog(t('sch.submit_confirm'), t('sch.submit'), false)) act(() => post(`/scholarship-applications/${a.id}/submit`)); } }, t('sch.submit')),
      h('button', { class: 'btn btn-ghost', onclick: async () => { if (await confirmDialog(t('sch.delete_draft'), t('common.remove'))) { try { await del(`/scholarship-applications/${a.id}`); navigate('/scholarships?tab=applications'); } catch (e) { fail(e); } } } }, t('sch.delete_application'))));
    if (a.decision_reason || a.decided_at) parts.push(h('div', { class: 'card' }, h('h2', t('sch.decision')), h('p', badge(t(`sch.app_${a.status}`), appKind[a.status])), a.decision_reason ? h('p', { style: { whiteSpace: 'pre-wrap' } }, a.decision_reason) : null));
    // reviewers' view and the administrator's tools
    if (a.reviews) parts.push(h('div', { class: 'card' }, h('h2', t('sch.reviews')), a.reviews.length ? a.reviews.map((r) => h('div', { style: { padding: '.3rem 0' } }, h('strong', r.reviewer_name), ' ', r.recommendation ? badge(t(`sch.rec_${r.recommendation}`), r.recommendation === 'recommend' ? 'green' : r.recommendation === 'not_recommend' ? 'red' : 'neutral') : badge(t('sch.rec_pending'), 'neutral'), r.note ? h('p', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, r.note) : null)) : h('p', { class: 'muted' }, t('sch.no_reviewers_assigned'))));
    if (a.can_review) {
      const rec = select([['recommend', t('sch.rec_recommend')], ['not_recommend', t('sch.rec_not_recommend')], ['undecided', t('sch.rec_undecided')]], (a.reviews[0] && a.reviews[0].recommendation) || 'recommend'), note = textarea({ rows: 3, maxlength: 2000 }); note.value = (a.reviews[0] && a.reviews[0].note) || '';
      parts.push(h('div', { class: 'card' }, h('h2', t('sch.your_review')), field(t('sch.recommendation'), rec), field(t('sch.note_private'), note), h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => act(() => post(`/scholarship-applications/${a.id}/review`, { recommendation: rec.value, note: note.value })) }, t('common.save')))));
    }
    if (a.can_assign) parts.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => {
      let pool; try { pool = await get('/scholarships-reviewers'); } catch (e) { return fail(e); }
      pool = pool.filter((u) => u.is_reviewer); const have = new Set(a.reviews.map((r) => r.reviewer_id));
      const boxes = pool.map((u) => ({ u, el: h('input', { type: 'checkbox', id: `ar${u.id}`, checked: have.has(u.id) }) }));
      modal({ title: t('sch.assign_reviewers'), body: pool.length ? h('div', boxes.map(({ u, el }) => h('div', { class: 'check' }, el, h('label', { for: el.id }, u.name)))) : h('div', { class: 'notice' }, t('sch.no_reviewers_named')),
        actions: [{ label: t('common.cancel'), class: 'btn-ghost', onclick: (c) => c() }, { label: t('common.save'), class: 'btn-primary', onclick: (c) => { c(); act(() => put(`/scholarship-applications/${a.id}/reviewers`, { user_ids: boxes.filter((b) => b.el.checked).map((b) => b.u.id) })); } }] });
    } }, t('sch.assign_reviewers'))));
    if (a.can_decide) parts.push(h('div', { class: 'card' }, h('h2', t('sch.decision')), h('p', { class: 'muted small' }, t('sch.places_left', { n: Math.max(0, a.places - a.approved_count), total: a.places })), h('div', { class: 'actions' }, ['approved', 'waitlisted', 'rejected'].filter((d) => !(d === 'waitlisted' && a.status === 'waitlisted')).map((d) => h('button', { class: `btn ${d === 'approved' ? 'btn-primary' : d === 'rejected' ? 'btn-danger' : ''}`, onclick: () => {
      const reason = textarea({ rows: 3, maxlength: 2000 });
      modal({ title: t(`sch.decide_${d}`), body: h('div', h('p', { class: 'muted small' }, t('sch.reason_shown')), field(t('sch.reason'), reason, { required: d !== 'approved' })), actions: [{ label: t('common.cancel'), class: 'btn-ghost', onclick: (c) => c() },
        { label: t('common.confirm'), class: 'btn-primary', onclick: (c) => { if (d !== 'approved' && !reason.value.trim()) return toast(t('err.reason_required'), 'error'); c(); act(() => post(`/scholarship-applications/${a.id}/decision`, { decision: d, reason: reason.value })); } }] });
    } }, t(`sch.decide_${d}`)))))
    );
    return h('div', parts);
  });
  view.replaceChildren(h('a', { href: '#/scholarships?tab=applications', class: 'small' }, `← ${t('sch.tab_applications')}`), box);
  run();
}
