#!/usr/bin/env node
// HRSR v0 checker. No dependencies. Apache-2.0.
//
//   node hrsr-validate.mjs report.json [--level L0|L1|L2|L3] [--files <dir>]
//
// Exit 0: the level was reached. Exit 1: it was not. Exit 2: usage error.
// A passing check shows the record is complete and consistent. It does not show the
// observer was present, the photos are honest, or the review was careful.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const LEVELS = ["L0", "L1", "L2", "L3"];
const TOOL_KINDS = ["ai_drafting", "ai_transcription", "ai_image_assist", "other_software", "manual"];
const ACTIONS = ["read_all", "edited", "removed_line", "added_line", "excluded_photo", "blurred_photo", "approved_text_for_release"];
const DISPOSITIONS = ["used", "excluded", "blurred_then_used"];

// Words a report under this standard does not use about a condition, a site or a person.
const VERDICT_PATTERNS = [
  /\bnon-?compliant\b/i, /\bcompliant\b/i, /\bin compliance\b/i, /\bout of compliance\b/i,
  /\bviolations?\b/i, /\bviolat(?:es|ed|ing)\b/i, /\bunsafe\b/i, /\bis safe\b/i, /\bare safe\b/i,
  /\bapproved\b/i, /\bcertified\b/i, /\bpass(?:es|ed)? inspection\b/i, /\bfail(?:s|ed)? inspection\b/i,
];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function validateReport(report, { level = "L0" } = {}) {
  const problems = [];
  const bad = (code, where, msg) => problems.push({ code, where, msg });
  if (!LEVELS.includes(level)) throw new Error("level must be one of " + LEVELS.join(", "));
  if (!isObj(report)) return { ok: false, reached: null, problems: [{ code: "not_object", where: "", msg: "the record must be a JSON object" }] };

  const need = (obj, key, where, type) => {
    const v = obj?.[key];
    const okType = type === "array" ? Array.isArray(v) : type === "object" ? isObj(v) : typeof v === type && (type !== "string" || v.length > 0);
    if (!okType) bad("missing_or_wrong_type", `${where}${key}`, `${key} is required and must be a${type === "array" ? "n array" : " " + type}`);
    return v;
  };
  const time = (v, where) => { if (typeof v !== "string" || !ISO.test(v) || Number.isNaN(Date.parse(v))) bad("bad_time", where, "must be an ISO 8601 date-time"); };

  // L0: structure
  if (report.spec_version !== "hrsr-0") bad("spec_version", "spec_version", 'must be "hrsr-0"');
  need(report, "report_id", "", "string");
  time(report.created_at, "created_at");
  const obs = need(report, "observation", "", "object");
  if (obs) { time(obs.start, "observation.start"); time(obs.end, "observation.end"); need(obs, "site_label", "observation.", "string"); }
  const observer = need(report, "observer", "", "object");
  if (observer) {
    need(observer, "name", "observer.", "string");
    if (observer.credential !== undefined) {
      const c = observer.credential;
      for (const k of ["issuer", "type", "id", "verify_url"]) if (!isObj(c) || typeof c[k] !== "string" || !c[k]) bad("credential_incomplete", `observer.credential.${k}`, "a claimed credential needs issuer, type, id and verify_url");
    }
  }
  const tools = need(report, "tools", "", "array") || [];
  tools.forEach((t, i) => {
    if (!isObj(t) || !t.name || !TOOL_KINDS.includes(t.kind) || !t.purpose) bad("tool_incomplete", `tools[${i}]`, "each tool needs name, a known kind and a purpose");
  });
  const inputs = need(report, "inputs", "", "object");
  const notes = inputs ? need(inputs, "notes", "inputs.", "array") || [] : [];
  const photos = inputs ? need(inputs, "photos", "inputs.", "array") || [] : [];
  const fin = need(report, "final", "", "object");
  // L0 holds each nested record to the schema's required fields, so a record that fails the schema is not "documented".
  notes.forEach((n, i) => {
    if (!isObj(n)) { bad("note_incomplete", `inputs.notes[${i}]`, "each note must be an object"); return; }
    if (!["voice_note", "text_note"].includes(n.kind)) bad("note_incomplete", `inputs.notes[${i}].kind`, "kind must be voice_note or text_note");
    time(n.captured_at, `inputs.notes[${i}].captured_at`);
  });
  photos.forEach((p, i) => {
    if (!isObj(p)) { bad("photo_incomplete", `inputs.photos[${i}]`, "each photo must be an object"); return; }
    if (typeof p.id !== "string" || !p.id) bad("photo_incomplete", `inputs.photos[${i}].id`, "id is required");
    if (typeof p.location_shared !== "boolean") bad("photo_incomplete", `inputs.photos[${i}].location_shared`, "location_shared must be true or false");
    time(p.captured_at, `inputs.photos[${i}].captured_at`);
  });
  if (fin && !["md", "pdf", "txt"].includes(fin.format)) bad("final_incomplete", "final.format", "format must be md, pdf or txt");
  const limits = report.limits_statement;
  if (typeof limits !== "string" || limits.trim().length < 40) bad("limits_statement", "limits_statement", "a limits statement of at least 40 characters is required");
  else if (!/not an inspection/i.test(limits) || !/compliance determination/i.test(limits)) bad("limits_statement_content", "limits_statement", 'the limits statement must say the report is "not an inspection" and not a "compliance determination"');
  const ai = need(report, "ai_disclosure", "", "object");
  if (ai) { if (typeof ai.ai_used !== "boolean") bad("ai_disclosure", "ai_disclosure.ai_used", "ai_used must be true or false"); need(ai, "statement", "ai_disclosure.", "string"); }
  const log = need(report, "review_log", "", "array") || [];
  const sign = need(report, "signoff", "", "object");
  log.forEach((e, i) => {
    if (!isObj(e)) { bad("log_entry_incomplete", `review_log[${i}]`, "each review entry must be an object"); return; }
    if (!e.by_name || !["human", "tool"].includes(e.by_kind) || !ACTIONS.includes(e.action)) bad("log_entry_incomplete", `review_log[${i}]`, "each review entry needs a name, human or tool, and a known action");
    time(e.at, `review_log[${i}].at`);
  });
  if (sign) { need(sign, "name", "signoff.", "string"); need(sign, "statement", "signoff.", "string"); time(sign.signed_at, "signoff.signed_at"); }
  if (report.anchoring !== undefined && (!isObj(report.anchoring) || !["none", "list", "ledger"].includes(report.anchoring.level))) bad("anchoring_level", "anchoring.level", "must be none, list or ledger");

  // L1: fingerprints
  const l1 = [];
  const l1bad = (code, where, msg) => l1.push({ code, where, msg });
  notes.forEach((n, i) => { if (!isObj(n) || !HEX64.test(n.sha256 || "")) l1bad("fingerprint", `inputs.notes[${i}].sha256`, "needs a 64-character lowercase SHA-256"); });
  photos.forEach((p, i) => { if (!isObj(p) || !HEX64.test(p.sha256 || "")) l1bad("fingerprint", `inputs.photos[${i}].sha256`, "needs a 64-character lowercase SHA-256"); });
  if (fin && !HEX64.test(fin.sha256 || "")) l1bad("fingerprint", "final.sha256", "needs a 64-character lowercase SHA-256");

  // L2: human review
  const l2 = [];
  const l2bad = (code, where, msg) => l2.push({ code, where, msg });
  const humanLog = log.filter((e) => isObj(e) && e.by_kind === "human");
  log.forEach((e, i) => {
    if (!isObj(e) || !ACTIONS.includes(e.action) || !e.by_name || !["human", "tool"].includes(e.by_kind)) l2bad("log_entry", `review_log[${i}]`, "each entry needs a time, a name, human or tool, and a known action");
    else time(e.at, `review_log[${i}].at`);
  });
  for (let i = 1; i < log.length; i++) if (Date.parse(log[i].at) < Date.parse(log[i - 1].at)) l2bad("log_order", `review_log[${i}]`, "entries must be in time order");
  if (!humanLog.some((e) => e.action === "read_all")) l2bad("no_read_all", "review_log", "a human read_all entry is required");
  const last = log[log.length - 1];
  if (!last || last.by_kind !== "human" || last.action !== "approved_text_for_release") l2bad("no_human_approval", "review_log", "the last entry must be a human approving the text for release");
  if (log.some((e) => e.action === "approved_text_for_release" && e.by_kind !== "human")) l2bad("tool_approved", "review_log", "a tool is never the approver");
  if (sign && last && Date.parse(sign.signed_at) < Date.parse(last.at)) l2bad("signoff_early", "signoff.signed_at", "the signoff cannot be earlier than the last review entry");
  if (sign && last && last.action === "approved_text_for_release" && last.by_kind === "human" && sign.name !== last.by_name) l2bad("signer_not_approver", "signoff.name", "the signer must be the human who approved the text for release");
  const aiTools = tools.filter((t) => isObj(t) && String(t.kind).startsWith("ai_"));
  if (aiTools.length && ai && ai.ai_used !== true) l2bad("ai_not_disclosed", "ai_disclosure.ai_used", "AI tools are listed, so ai_used must be true");
  photos.forEach((p, i) => {
    if (!isObj(p) || !DISPOSITIONS.includes(p.disposition) || !p.disposition_by) l2bad("photo_disposition", `inputs.photos[${i}]`, "each photo needs a disposition and who set it");
    if (isObj(p) && (p.disposition === "excluded" || p.disposition === "blurred_then_used")) {
      const act = p.disposition === "excluded" ? "excluded_photo" : "blurred_photo";
      if (!log.some((e) => e.action === act && String(e.note || "").includes(p.id))) l2bad("photo_not_logged", `inputs.photos[${i}]`, `a ${act} log entry naming ${p.id} is required`);
    }
  });
  const textFields = [];
  if (typeof report.summary === "string") textFields.push(["summary", report.summary]);
  (report.findings || []).forEach((f, i) => { if (isObj(f) && typeof f.observation === "string") textFields.push([`findings[${i}].observation`, f.observation]); });
  (report.notices || []).forEach((n, i) => { if (isObj(n) && typeof n.what_in_plain_words === "string") textFields.push([`notices[${i}].what_in_plain_words`, n.what_in_plain_words]); });
  for (const [where, text] of textFields) for (const re of VERDICT_PATTERNS) { const m = text.match(re); if (m) l2bad("verdict_language", where, `verdict word "${m[0]}": say what was seen, not what to conclude`); }

  // L3: anchored with consent
  const l3 = [];
  const a = report.anchoring;
  if (!isObj(a) || !["list", "ledger"].includes(a.level)) l3.push({ code: "not_anchored", where: "anchoring.level", msg: "anchoring.level must be list or ledger" });
  else {
    if (!HEX64.test(a.root_sha256 || "")) l3.push({ code: "root", where: "anchoring.root_sha256", msg: "needs a 64-character lowercase SHA-256" });
    if (!a.client_consent_ref) l3.push({ code: "consent", where: "anchoring.client_consent_ref", msg: "anchoring needs a reference to the client's written agreement" });
  }

  const l0ok = problems.length === 0;
  const l1ok = l0ok && l1.length === 0;
  const l2ok = l1ok && l2.length === 0;
  const l3ok = l2ok && l3.length === 0;
  const reached = l3ok ? "L3" : l2ok ? "L2" : l1ok ? "L1" : l0ok ? "L0" : null;
  const need_ = { L0: [], L1: l1, L2: [...l1, ...l2], L3: [...l1, ...l2, ...l3] }[level];
  const all = [...problems, ...need_];
  const rank = (l) => (l ? LEVELS.indexOf(l) : -1);
  return { ok: rank(reached) >= rank(level) && all.length === 0, reached, level_asked: level, problems: all };
}

export function verifyFiles(report, dir) {
  const problems = [];
  const check = (entry, where) => {
    if (!isObj(entry) || !entry.file) return;
    const p = path.resolve(dir, entry.file);
    if (!p.startsWith(path.resolve(dir) + path.sep)) { problems.push({ code: "path_escape", where, msg: "file path leaves the folder" }); return; }
    if (!fs.existsSync(p)) { problems.push({ code: "file_missing", where, msg: `${entry.file} not found` }); return; }
    const realDir = fs.realpathSync(dir);
    const realPath = fs.realpathSync(p);
    if (!realPath.startsWith(realDir + path.sep)) { problems.push({ code: "path_escape", where, msg: "file path leaves the folder through a link" }); return; }
    const got = sha256(fs.readFileSync(realPath));
    if (got !== entry.sha256) problems.push({ code: "fingerprint_mismatch", where, msg: `${entry.file} does not match its recorded fingerprint` });
  };
  (report.inputs?.notes || []).forEach((n, i) => check(n, `inputs.notes[${i}]`));
  (report.inputs?.photos || []).forEach((p, i) => check(p, `inputs.photos[${i}]`));
  check(report.final, "final");
  return { ok: problems.length === 0, problems };
}

function cli(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--level" && args[args.indexOf(a) - 1] !== "--files");
  const li = args.indexOf("--level");
  const fi = args.indexOf("--files");
  const level = li >= 0 ? args[li + 1] : "L0";
  const dir = fi >= 0 ? args[fi + 1] : null;
  if (!file || !LEVELS.includes(level) || (fi >= 0 && !dir)) { console.error("usage: node hrsr-validate.mjs report.json [--level L0|L1|L2|L3] [--files <dir>]"); return 2; }
  let report;
  try { report = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("cannot read the record: " + e.message); return 2; }
  const r = validateReport(report, { level });
  const v = dir ? verifyFiles(report, dir) : { ok: true, problems: [] };
  const problems = [...r.problems, ...v.problems];
  for (const p of problems) console.log(`${p.code}  ${p.where}  ${p.msg}`);
  console.log(`level asked ${level}; level reached ${r.reached ?? "none"}; ${problems.length} problem(s)`);
  if (report.conformance_claimed && r.reached && LEVELS.indexOf(report.conformance_claimed) > LEVELS.indexOf(r.reached)) { console.log(`the record claims ${report.conformance_claimed} but reaches ${r.reached}`); return 1; }
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) process.exit(cli(process.argv));
