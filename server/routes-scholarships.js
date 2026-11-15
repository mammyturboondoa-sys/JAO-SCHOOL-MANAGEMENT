'use strict';
// Scholarships, phase 1: the school's own scholarship opportunities.
// The administrator creates and manages them. Staff, parents and students can read the ones that are published.
// Reviewers (teachers the administrator names) will be assigned individual applications in phase 2.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./security');
const A = require('./access');

const ADMIN = ['school_admin'];
const ALL = ['school_admin', 'teacher', 'parent', 'student'];
const CATEGORIES = ['academic_merit', 'talent_excellence', 'social_support', 'external'];
const STATUSES = ['draft', 'open', 'suspended', 'closed'];
const todayStr = () => new Date().toISOString().slice(0, 10);

module.exports = function (app) {
  const { h, route } = app;

  // What a reader should understand about the scholarship right now.
  const phaseOf = (s) => {
    if (s.status !== 'open') return s.status;
    const t = todayStr();
    if (s.opens_on && t < s.opens_on) return 'upcoming';
    if (s.closes_on && t > s.closes_on) return 'deadline_passed';
    return 'open';
  };
  const shape = async (c, s, withClasses = true) => ({
    id: s.id, title: s.title, description: s.description, category: s.category, sponsor: s.sponsor, eligibility_text: s.eligibility_text, benefits: s.benefits,
    required_documents: s.required_documents, renewal_conditions: s.renewal_conditions, places: s.places, min_average: s.min_average, opens_on: s.opens_on, closes_on: s.closes_on,
    status: s.status, phase: phaseOf(s),
    classes: withClasses ? await h.all('SELECT c.id, c.name, c.section FROM scholarship_classes sc JOIN classes c ON c.id = sc.class_id AND c.school_id = sc.school_id WHERE sc.scholarship_id = ? AND sc.school_id = ? ORDER BY c.name, c.section', s.id, c.schoolId) : undefined,
  });
  const load = async (c, id = c.params.id) => {
    const n = S.toInt(id);
    const s = n === null ? null : await h.get('SELECT * FROM scholarships WHERE id = ? AND school_id = ?', n, c.schoolId);
    if (!s) throw S.notFound();
    // people other than the administrator never see drafts
    if (c.user.role !== 'school_admin' && s.status === 'draft') throw S.notFound();
    if ((c.user.role === 'parent' || c.user.role === 'student') && s.status === 'suspended') throw S.notFound();
    return s;
  };

  async function fields(c, existing) {
    const b = c.body, out = {};
    const pick = (k, max, required) => { const v = b[k] === undefined && existing ? existing[k] : S.str(b[k], max); if (required && !v) throw S.bad(`${k}_required`); return v || null; };
    out.title = pick('title', 160, true); out.description = pick('description', 3000, true); out.benefits = pick('benefits', 2000, true);
    out.sponsor = pick('sponsor', 160); out.eligibility_text = pick('eligibility_text', 2000); out.required_documents = pick('required_documents', 1500); out.renewal_conditions = pick('renewal_conditions', 1500);
    out.category = b.category === undefined && existing ? existing.category : b.category;
    if (!CATEGORIES.includes(out.category)) throw S.bad('invalid_category');
    out.places = b.places === undefined ? (existing ? existing.places : 1) : S.toInt(b.places);
    if (out.places === null || out.places < 1 || out.places > 10000) throw S.bad('invalid_places');
    const scale = c.school.grade_scale || 20;
    out.min_average = b.min_average === undefined && existing ? existing.min_average : (b.min_average === undefined || b.min_average === '' || b.min_average === null ? null : Number(b.min_average));
    if (out.min_average !== null && (!Number.isFinite(out.min_average) || out.min_average < 0 || out.min_average > scale)) throw S.bad('invalid_min_average');
    for (const k of ['opens_on', 'closes_on']) {
      out[k] = b[k] === undefined && existing ? existing[k] : (b[k] ? b[k] : null);
      if (out[k] !== null && !S.isDate(out[k])) throw S.bad('invalid_date');
    }
    if (out.opens_on && out.closes_on && out.closes_on < out.opens_on) throw S.bad('invalid_date');
    out.class_ids = null;
    if (b.class_ids !== undefined) {
      if (!Array.isArray(b.class_ids) || b.class_ids.length > 100) throw S.bad('invalid_data');
      out.class_ids = [];
      for (const raw of new Set(b.class_ids.map(Number))) {
        if (!(await h.get('SELECT 1 FROM classes WHERE id = ? AND school_id = ?', raw, c.schoolId))) throw S.bad('invalid_class');
        out.class_ids.push(raw);
      }
    }
    return out;
  }
  const saveClasses = async (c, id, ids) => {
    if (ids === null) return;
    await h.run('DELETE FROM scholarship_classes WHERE scholarship_id = ? AND school_id = ?', id, c.schoolId);
    for (const cid of ids) await h.run('INSERT INTO scholarship_classes (school_id, scholarship_id, class_id) VALUES (?,?,?)', c.schoolId, id, cid);
  };

  route('GET', '/scholarships', ALL, async (c) => {
    const where = ['school_id = ?'], p = [c.schoolId];
    if (c.user.role === 'teacher') where.push("status <> 'draft'");
    if (c.user.role === 'parent' || c.user.role === 'student') where.push("status IN ('open','closed')");
    if (CATEGORIES.includes(c.query.category)) { where.push('category = ?'); p.push(c.query.category); }
    const q = S.str(c.query.q, 80);
    if (q) { where.push("(LOWER(title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(sponsor) LIKE LOWER(?) ESCAPE '\\')"); const l = `%${q.replace(/[\\%_]/g, '\\$&')}%`; p.push(l, l); }
    const rows = await h.all(`SELECT * FROM scholarships WHERE ${where.join(' AND ')} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, closes_on IS NULL, closes_on, id DESC LIMIT 200`, ...p);
    return Promise.all(rows.map((s) => shape(c, s)));
  });
  route('GET', '/scholarships/:id', ALL, async (c) => shape(c, await load(c)));

  route('POST', '/scholarships', ADMIN, async (c) => {
    const f = await fields(c, null);
    const id = await h.insert('INSERT INTO scholarships (school_id, title, description, category, sponsor, eligibility_text, benefits, required_documents, renewal_conditions, places, min_average, opens_on, closes_on, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      c.schoolId, f.title, f.description, f.category, f.sponsor, f.eligibility_text, f.benefits, f.required_documents, f.renewal_conditions, f.places, f.min_average, f.opens_on, f.closes_on, c.user.id);
    await saveClasses(c, id, f.class_ids);
    await h.audit(c.schoolId, c.user.id, 'scholarship_created', `scholarship:${id}`);
    return { id };
  });
  route('PUT', '/scholarships/:id', ADMIN, async (c) => {
    const s = await load(c);
    if (s.status === 'closed') throw S.bad('invalid_status');
    const f = await fields(c, s);
    await h.run('UPDATE scholarships SET title=?, description=?, category=?, sponsor=?, eligibility_text=?, benefits=?, required_documents=?, renewal_conditions=?, places=?, min_average=?, opens_on=?, closes_on=?, updated_at=NOW_TS WHERE id=? AND school_id=?',
      f.title, f.description, f.category, f.sponsor, f.eligibility_text, f.benefits, f.required_documents, f.renewal_conditions, f.places, f.min_average, f.opens_on, f.closes_on, s.id, c.schoolId);
    await saveClasses(c, s.id, f.class_ids);
    await h.audit(c.schoolId, c.user.id, 'scholarship_edited', `scholarship:${s.id}`);
  });
  // open (publish), suspend, close. A closed scholarship can be re-opened by creating a new one, not by editing the old record.
  route('POST', '/scholarships/:id/status', ADMIN, async (c) => {
    const s = await load(c);
    const to = c.body.status;
    if (!STATUSES.includes(to) || to === 'draft') throw S.bad('invalid_status');
    const ok = { draft: ['open'], open: ['suspended', 'closed'], suspended: ['open', 'closed'], closed: [] }[s.status];
    if (!ok.includes(to)) throw S.bad('invalid_status');
    await h.run('UPDATE scholarships SET status = ?, updated_at = NOW_TS WHERE id = ? AND school_id = ?', to, s.id, c.schoolId);
    await h.audit(c.schoolId, c.user.id, `scholarship_${to}`, `scholarship:${s.id}`);
  });
  route('DELETE', '/scholarships/:id', ADMIN, async (c) => {
    const s = await load(c);
    if (s.status !== 'draft') throw S.bad('invalid_status'); // anything that was ever published is kept for the record
    await h.run('DELETE FROM scholarship_classes WHERE scholarship_id = ? AND school_id = ?', s.id, c.schoolId);
    await h.run('DELETE FROM scholarships WHERE id = ? AND school_id = ?', s.id, c.schoolId);
    await h.audit(c.schoolId, c.user.id, 'scholarship_deleted', `scholarship:${s.id}`);
  });

  // ----- reviewers: teachers of THIS school the administrator allows to review applications -----
  route('GET', '/scholarships-reviewers', ADMIN, async (c) => h.all(`SELECT u.id, u.name, u.email, CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END is_reviewer
    FROM users u LEFT JOIN scholarship_reviewers r ON r.user_id = u.id AND r.school_id = u.school_id WHERE u.school_id = ? AND u.role = 'teacher' AND u.active = 1 ORDER BY u.name`, c.schoolId)
    .then((rows) => rows.map((r) => ({ ...r, is_reviewer: !!r.is_reviewer }))));
  route('PUT', '/scholarships-reviewers', ADMIN, async (c) => {
    if (!Array.isArray(c.body.user_ids) || c.body.user_ids.length > 200) throw S.bad('invalid_data');
    const ids = [...new Set(c.body.user_ids.map(Number))];
    for (const id of ids) if (!(await h.get("SELECT 1 FROM users WHERE id = ? AND school_id = ? AND role = 'teacher' AND active = 1", id, c.schoolId))) throw S.bad('invalid_user');
    await h.tx(async () => {
      await h.run('DELETE FROM scholarship_reviewers WHERE school_id = ?', c.schoolId);
      for (const id of ids) await h.run('INSERT INTO scholarship_reviewers (school_id, user_id, granted_by) VALUES (?,?,?)', c.schoolId, id, c.user.id);
      await h.audit(c.schoolId, c.user.id, 'scholarship_reviewers_set', `school:${c.schoolId}`, { users: ids });
    });
  });

  // =====================================================================================================
  // APPLICATIONS (phase 2)
  // Students apply for themselves; a parent applies for a linked child. Eligibility is computed here on the server from
  // the school's own data (class, APPROVED results). Nothing is guessed: no approved result means the minimum average is not met.
  // Reviewers see only the applications assigned to them. Applicants never see reviewer notes.
  // =====================================================================================================
  const MAX_DOC = 3 * 1024 * 1024, MAX_DOCS = 8;
  const classLabel = (name, section) => (name ? `${name}${section ? (section.length === 1 ? '' : ' ') + section : ''}` : null);
  const isApplicant = (c) => c.user.role === 'student' || c.user.role === 'parent';
  const sniffDoc = (buf) => (buf.length > 5 && buf.slice(0, 5).toString() === '%PDF-' ? 'application/pdf' : S.sniffImage(buf));

  async function eligibility(c, sch, student) {
    const checks = [];
    const phase = phaseOf(sch);
    checks.push({ key: 'open', ok: phase === 'open', detail: phase });
    checks.push({ key: 'active_student', ok: student.status === 'active' && !student.archived_at });
    const cls = await h.all('SELECT class_id FROM scholarship_classes WHERE scholarship_id = ? AND school_id = ?', sch.id, c.schoolId);
    if (cls.length) checks.push({ key: 'class', ok: !!student.class_id && cls.some((x) => x.class_id === student.class_id) });
    let avg = null;
    if (sch.min_average !== null) {
      avg = await app.approvedAverage(c.schoolId, student.id);
      checks.push({ key: 'min_average', ok: !!avg && avg.average >= sch.min_average, detail: avg ? { average: avg.average, required: sch.min_average, source: avg.source } : { required: sch.min_average, average: null } });
    }
    return { eligible: checks.every((x) => x.ok), checks, avg };
  }
  const myStudent = async (c, studentId) => {
    if (c.user.role === 'student') { if (c.user.student_id == null) throw S.forbidden(); return A.getVisibleStudent(h, c.user, c.user.student_id); }
    if (c.user.role === 'parent') return A.getVisibleStudent(h, c.user, studentId);
    throw S.forbidden();
  };

  route('GET', '/scholarships/:id/eligibility', ['student', 'parent'], async (c) => {
    const sch = await load(c);
    const st = await myStudent(c, c.query.student_id);
    const e = await eligibility(c, sch, st);
    const existing = await h.get('SELECT id, status FROM scholarship_applications WHERE scholarship_id = ? AND student_id = ? AND school_id = ?', sch.id, st.id, c.schoolId);
    return { eligible: e.eligible, checks: e.checks, application: existing || null };
  });

  const APP_SELECT = `SELECT a.*, sc.title, sc.category, sc.places, st.full_name student_name, st.student_code, cl.name cname, cl.section csection, ap.name applied_by_name, dm.name decided_by_name
    FROM scholarship_applications a JOIN scholarships sc ON sc.id = a.scholarship_id AND sc.school_id = a.school_id JOIN students st ON st.id = a.student_id AND st.school_id = a.school_id
    LEFT JOIN classes cl ON cl.id = st.class_id AND cl.school_id = st.school_id JOIN users ap ON ap.id = a.applied_by AND ap.school_id = a.school_id LEFT JOIN users dm ON dm.id = a.decided_by AND dm.school_id = a.school_id`;
  const appShape = (a) => ({ id: a.id, scholarship: { id: a.scholarship_id, title: a.title, category: a.category }, student: { id: a.student_id, full_name: a.student_name, student_code: a.student_code, class_label: classLabel(a.cname, a.csection) },
    status: a.status, motivation: a.motivation, submitted_at: a.submitted_at, average_at_submission: a.average_at_submission, average_source: a.average_source,
    decision_reason: a.decision_reason, decided_at: a.decided_at, decided_by_name: a.decided_by_name, applied_by_name: a.applied_by_name, created_at: a.created_at });

  // Which applications may this person see?
  async function scopeOf(c) {
    if (c.user.role === 'school_admin') return { where: 'a.school_id = ?', params: [c.schoolId], admin: true };
    if (c.user.role === 'teacher') return { where: 'a.school_id = ? AND a.status <> \'draft\' AND EXISTS (SELECT 1 FROM scholarship_reviews r WHERE r.application_id = a.id AND r.school_id = a.school_id AND r.reviewer_id = ?)', params: [c.schoolId, c.user.id], reviewer: true };
    const sc = A.studentScope(c.user);
    return { where: `a.school_id = ? AND a.student_id IN (SELECT s.id FROM students s WHERE ${sc.where})`, params: [c.schoolId, ...sc.params], applicant: true };
  }
  async function loadApp(c, id = c.params.id) {
    const n = S.toInt(id), sc = await scopeOf(c);
    const a = n === null ? null : await h.get(`${APP_SELECT} WHERE ${sc.where} AND a.id = ?`, ...sc.params, n);
    if (!a) throw S.notFound();
    return { a, sc };
  }
  const docsOf = (c, id) => h.all('SELECT id, original_name, mime, size, created_at FROM scholarship_documents WHERE application_id = ? AND school_id = ? ORDER BY id', id, c.schoolId);

  route('GET', '/scholarship-applications', ALL, async (c) => {
    const sc = await scopeOf(c), where = [sc.where], p = [...sc.params];
    if (S.toInt(c.query.scholarship_id) !== null) { where.push('a.scholarship_id = ?'); p.push(Number(c.query.scholarship_id)); }
    if (['draft', 'submitted', 'under_review', 'approved', 'rejected', 'waitlisted'].includes(c.query.status)) { where.push('a.status = ?'); p.push(c.query.status); }
    const q = S.str(c.query.q, 80);
    if (q && !sc.applicant) { where.push("(LOWER(st.full_name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(st.student_code) LIKE LOWER(?) ESCAPE '\\')"); const l = `%${q.replace(/[\\%_]/g, '\\$&')}%`; p.push(l, l); }
    const rows = await h.all(`${APP_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC, a.id DESC LIMIT 300`, ...p);
    return rows.map((a) => { const x = appShape(a); if (sc.reviewer) { delete x.decision_reason; } return x; });
  });

  route('POST', '/scholarship-applications', ['student', 'parent'], async (c) => {
    const sch = await load(c, c.body.scholarship_id);
    const st = await myStudent(c, c.body.student_id);
    if (sch.status !== 'open') throw S.bad('not_open');
    if (await h.get('SELECT 1 FROM scholarship_applications WHERE scholarship_id = ? AND student_id = ? AND school_id = ?', sch.id, st.id, c.schoolId)) throw S.bad('already_applied');
    const e = await eligibility(c, sch, st);
    if (!e.eligible) throw S.bad('not_eligible', { checks: e.checks });
    const motivation = S.str(c.body.motivation, 3000) || null;
    const id = await h.insert('INSERT INTO scholarship_applications (school_id, scholarship_id, student_id, applied_by, motivation) VALUES (?,?,?,?,?)', c.schoolId, sch.id, st.id, c.user.id, motivation);
    await h.audit(c.schoolId, c.user.id, 'scholarship_application_started', `scholarship_application:${id}`, { scholarship_id: sch.id, student_id: st.id });
    return { id };
  });
  route('GET', '/scholarship-applications/:id', ALL, async (c) => {
    const { a, sc } = await loadApp(c);
    const out = appShape(a);
    out.documents = await docsOf(c, a.id);
    out.can_edit = !!sc.applicant && a.status === 'draft';
    if (sc.reviewer) delete out.decision_reason;
    if (sc.admin || sc.reviewer) {
      const rv = await h.all(`SELECT r.reviewer_id, u.name reviewer_name, r.recommendation, r.note, r.reviewed_at, r.assigned_at FROM scholarship_reviews r JOIN users u ON u.id = r.reviewer_id AND u.school_id = r.school_id
        WHERE r.application_id = ? AND r.school_id = ? ${sc.reviewer ? 'AND r.reviewer_id = ?' : ''} ORDER BY r.assigned_at`, ...[a.id, c.schoolId, ...(sc.reviewer ? [c.user.id] : [])]);
      out.reviews = rv;
      out.can_review = !!sc.reviewer && a.status === 'under_review';
    }
    if (sc.admin) {
      out.can_assign = ['submitted', 'under_review'].includes(a.status);
      out.can_decide = ['submitted', 'under_review', 'waitlisted'].includes(a.status);
      out.places = a.places; out.approved_count = (await h.get("SELECT COUNT(*) n FROM scholarship_applications WHERE scholarship_id = ? AND school_id = ? AND status = 'approved'", a.scholarship_id, c.schoolId)).n;
    }
    return out;
  });
  route('PUT', '/scholarship-applications/:id', ['student', 'parent'], async (c) => {
    const { a } = await loadApp(c);
    if (a.status !== 'draft') throw S.bad('invalid_status');
    await h.run('UPDATE scholarship_applications SET motivation = ?, updated_at = NOW_TS WHERE id = ? AND school_id = ?', S.str(c.body.motivation, 3000) || null, a.id, c.schoolId);
  });
  route('DELETE', '/scholarship-applications/:id', ['student', 'parent'], async (c) => {
    const { a } = await loadApp(c);
    if (a.status !== 'draft') throw S.bad('invalid_status');
    for (const d of await h.all('SELECT path FROM scholarship_documents WHERE application_id = ? AND school_id = ?', a.id, c.schoolId)) { try { fs.unlinkSync(d.path); } catch { /* already gone */ } }
    await h.run('DELETE FROM scholarship_documents WHERE application_id = ? AND school_id = ?', a.id, c.schoolId);
    await h.run('DELETE FROM scholarship_applications WHERE id = ? AND school_id = ?', a.id, c.schoolId);
  });

  // family notices: the student's own account and linked parent accounts (stored in-app notifications only)
  async function tellFamily(c, a, kind) {
    const ids = new Set();
    for (const u of await h.all("SELECT id FROM users WHERE school_id = ? AND role = 'student' AND student_id = ? AND active = 1", c.schoolId, a.student_id)) ids.add(u.id);
    for (const u of await h.all(`SELECT DISTINCT g.user_id id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id JOIN users u ON u.id = g.user_id AND u.school_id = g.school_id
      WHERE sg.school_id = ? AND sg.student_id = ? AND u.role = 'parent' AND u.active = 1`, c.schoolId, a.student_id)) ids.add(u.id);
    for (const id of ids) await app.notify(c.schoolId, id, kind, { title: a.title, student: a.student_name }, '#/scholarships?tab=applications');
  }

  route('POST', '/scholarship-applications/:id/submit', ['student', 'parent'], async (c) => {
    const { a } = await loadApp(c);
    if (a.status !== 'draft') throw S.bad('invalid_status');
    const sch = await h.get('SELECT * FROM scholarships WHERE id = ? AND school_id = ?', a.scholarship_id, c.schoolId);
    const st = await h.get('SELECT * FROM students WHERE id = ? AND school_id = ?', a.student_id, c.schoolId);
    const e = await eligibility(c, sch, st);
    if (!e.eligible) throw S.bad('not_eligible', { checks: e.checks });
    if (!a.motivation) throw S.bad('motivation_required');
    await h.run("UPDATE scholarship_applications SET status = 'submitted', submitted_at = NOW_TS, average_at_submission = ?, average_source = ?, updated_at = NOW_TS WHERE id = ? AND school_id = ?", e.avg ? e.avg.average : null, e.avg ? e.avg.source : null, a.id, c.schoolId);
    await h.audit(c.schoolId, c.user.id, 'scholarship_application_submitted', `scholarship_application:${a.id}`);
    await tellFamily(c, a, 'scholarship_received');
  });

  // ----- documents (private files; only the applicant side, the administrator and an assigned reviewer can open them) -----
  route('POST', '/scholarship-applications/:id/documents', ['student', 'parent'], async (c) => {
    const { a } = await loadApp(c);
    if (a.status !== 'draft') throw S.bad('invalid_status');
    if (typeof c.body.data !== 'string') throw S.bad('invalid_file');
    const buf = Buffer.from(c.body.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length === 0 || buf.length > MAX_DOC) throw S.bad('file_too_large');
    const mime = sniffDoc(buf);
    if (!mime) throw S.bad('invalid_file_type');
    if ((await h.get('SELECT COUNT(*) n FROM scholarship_documents WHERE application_id = ? AND school_id = ?', a.id, c.schoolId)).n >= MAX_DOCS) throw S.bad('too_many_files');
    const name = S.str(String(c.body.name || 'document').split(/[\\/]/).pop(), 120) || 'document';
    const dir = path.join(app.dataDir, 'uploads', String(c.schoolId), 'scholarships');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.randomBytes(16).toString('hex'));
    fs.writeFileSync(file, buf);
    const id = await h.insert('INSERT INTO scholarship_documents (school_id, application_id, original_name, mime, size, path, uploaded_by) VALUES (?,?,?,?,?,?,?)', c.schoolId, a.id, name, mime, buf.length, file, c.user.id);
    return { id };
  }).bodyLimit = 5 * 1024 * 1024;
  route('GET', '/scholarship-applications/:id/documents/:doc', ALL, async (c) => {
    const { a } = await loadApp(c);
    const did = S.toInt(c.params.doc);
    const d = did === null ? null : await h.get('SELECT * FROM scholarship_documents WHERE id = ? AND application_id = ? AND school_id = ?', did, a.id, c.schoolId);
    if (!d) throw S.notFound();
    await h.audit(c.schoolId, c.user.id, 'scholarship_document_viewed', `scholarship_application:${a.id}`, { document: d.id });
    const ascii = d.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return { __raw: true, body: fs.readFileSync(d.path), headers: { 'Content-Type': d.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${ascii}"` } };
  });
  route('DELETE', '/scholarship-applications/:id/documents/:doc', ['student', 'parent'], async (c) => {
    const { a } = await loadApp(c);
    if (a.status !== 'draft') throw S.bad('invalid_status');
    const did = S.toInt(c.params.doc);
    const d = did === null ? null : await h.get('SELECT * FROM scholarship_documents WHERE id = ? AND application_id = ? AND school_id = ?', did, a.id, c.schoolId);
    if (!d) throw S.notFound();
    await h.run('DELETE FROM scholarship_documents WHERE id = ? AND school_id = ?', d.id, c.schoolId);
    try { fs.unlinkSync(d.path); } catch { /* already gone */ }
  });

  // ----- administrator: assign reviewers, decide -----
  route('PUT', '/scholarship-applications/:id/reviewers', ADMIN, async (c) => {
    const { a } = await loadApp(c);
    if (!['submitted', 'under_review'].includes(a.status)) throw S.bad('invalid_status');
    if (!Array.isArray(c.body.user_ids) || c.body.user_ids.length > 20) throw S.bad('invalid_data');
    const ids = [...new Set(c.body.user_ids.map(Number))];
    for (const id of ids) if (!(await h.get('SELECT 1 FROM scholarship_reviewers WHERE user_id = ? AND school_id = ?', id, c.schoolId))) throw S.bad('invalid_user');
    await h.tx(async () => {
      for (const r of await h.all('SELECT reviewer_id FROM scholarship_reviews WHERE application_id = ? AND school_id = ?', a.id, c.schoolId)) {
        if (!ids.includes(r.reviewer_id)) await h.run('DELETE FROM scholarship_reviews WHERE application_id = ? AND reviewer_id = ? AND school_id = ?', a.id, r.reviewer_id, c.schoolId);
      }
      for (const id of ids) await h.run('INSERT OR IGNORE INTO scholarship_reviews (school_id, application_id, reviewer_id, assigned_by) VALUES (?,?,?,?)', c.schoolId, a.id, id, c.user.id);
      if (ids.length && a.status === 'submitted') await h.run("UPDATE scholarship_applications SET status = 'under_review', updated_at = NOW_TS WHERE id = ? AND school_id = ?", a.id, c.schoolId);
      await h.audit(c.schoolId, c.user.id, 'scholarship_reviewers_assigned', `scholarship_application:${a.id}`, { users: ids });
    });
    if (ids.length && a.status === 'submitted') await tellFamily(c, a, 'scholarship_under_review');
  });
  route('POST', '/scholarship-applications/:id/review', ['teacher'], async (c) => {
    const { a, sc } = await loadApp(c);
    if (!sc.reviewer || a.status !== 'under_review') throw S.bad('invalid_status');
    if (!['recommend', 'not_recommend', 'undecided'].includes(c.body.recommendation)) throw S.bad('invalid_data');
    await h.run('UPDATE scholarship_reviews SET recommendation = ?, note = ?, reviewed_at = NOW_TS WHERE application_id = ? AND reviewer_id = ? AND school_id = ?', c.body.recommendation, S.str(c.body.note, 2000) || null, a.id, c.user.id, c.schoolId);
    await h.audit(c.schoolId, c.user.id, 'scholarship_review_saved', `scholarship_application:${a.id}`);
  });
  route('POST', '/scholarship-applications/:id/decision', ADMIN, async (c) => {
    const { a } = await loadApp(c);
    if (!['submitted', 'under_review', 'waitlisted'].includes(a.status)) throw S.bad('invalid_status');
    const d = c.body.decision, reason = S.str(c.body.reason, 2000) || null;
    if (!['approved', 'rejected', 'waitlisted'].includes(d)) throw S.bad('invalid_decision');
    if (d !== 'approved' && !reason) throw S.bad('reason_required');
    if (d === 'waitlisted' && a.status === 'waitlisted') throw S.bad('invalid_status');
    if (d === 'approved' && (await h.get("SELECT COUNT(*) n FROM scholarship_applications WHERE scholarship_id = ? AND school_id = ? AND status = 'approved'", a.scholarship_id, c.schoolId)).n >= a.places) throw S.bad('no_places_left');
    await h.run('UPDATE scholarship_applications SET status = ?, decision_reason = ?, decided_by = ?, decided_at = NOW_TS, updated_at = NOW_TS WHERE id = ? AND school_id = ?', d, reason, c.user.id, a.id, c.schoolId);
    await h.audit(c.schoolId, c.user.id, `scholarship_application_${d}`, `scholarship_application:${a.id}`);
    await tellFamily(c, a, `scholarship_${d}`);
  });
};
