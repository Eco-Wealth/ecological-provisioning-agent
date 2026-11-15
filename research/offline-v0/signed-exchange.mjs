/**
 * Experimental offline signed journal exchange.
 *
 * DSSE v1 pre-authenticated payload, single Ed25519 SPKI signer, full local
 * journal replay, and optional independently pinned publisher key / history.
 * A matching signature proves key possession over bytes, NOT actor identity,
 * authority, honest time, independent sampling, or ecological benefit.
 *
 * Zero runtime dependencies beyond Node.js and the public research modules.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonical, exportBundle, readJournal, serializeJournal, validateJournal } from './journal.mjs';
import { hasFailures, validTime, verifyBundle } from './verify.mjs';
import { inspectExchange, inspectMeasurements } from './measurement.mjs';

export const SIGNED_EXCHANGE_FORMAT = 'ecowealth-offline-signed-exchange-v0';
export const CHECKPOINT_FORMAT = 'ecowealth-offline-checkpoint-v0';
export const CHECKPOINT_PAYLOAD_TYPE = 'application/vnd.ecowealth.offline-checkpoint-v0+json';
const HEX = /^[a-f0-9]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const word = (x, limit = 256) => typeof x === 'string' && x.length > 0 && x.length <= limit;
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failIn = findings => findings.some(x => x.status === 'FAIL');
const MAX_PACKAGE_BYTES = 70 * 1024 * 1024;

/** DSSE PAE: bind the payload's type to its raw bytes (no invented signing delimiter). */
export function pae(type, payload) {
  if (!word(type, 200) || !Buffer.isBuffer(payload))
    throw new TypeError('invalid DSSE payload type or bytes');
  const typeBytes = Buffer.from(type, 'utf8');
  return Buffer.concat([
    Buffer.from('DSSEv1 ' + typeBytes.length + ' ', 'ascii'), typeBytes,
    Buffer.from(' ' + payload.length + ' ', 'ascii'), payload
  ]);
}
function decode64(text, maxBytes) {
  if (typeof text !== 'string' || text.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
      !B64.test(text)) throw new TypeError('invalid canonical base64');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== text)
    throw new TypeError('invalid canonical base64 encoding');
  return bytes;
}

/** Accept signing keys only in memory; no key creation, persistence or deployment. */
export function signJournal(entries, signingKey, issuedAt) {
  const { head, entries: count } = validateJournal(entries);
  if (!validTime(issuedAt) || Date.parse(issuedAt) < Date.parse(entries.at(-1).recordedAt))
    throw new TypeError('declared signing time predates journal head or is invalid');
  const key = typeof signingKey === 'string' ? createPrivateKey(signingKey) : signingKey;
  if (!key || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')
    throw new TypeError('Ed25519 signing key required');
  const bundle = exportBundle(entries);
  if (hasFailures(verifyBundle(bundle)) ||
      failIn(inspectMeasurements(bundle).findings))
    throw new TypeError('refusing to sign a structurally invalid research bundle');
  const publicKeySpki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const keySha256 = digest(publicKeySpki);
  const checkpoint = {
    format: CHECKPOINT_FORMAT, publisher: bundle.provenance.source,
    journalHead: head, entryCount: count, sequence: count - 1,
    issuedAt, signerKeySha256: keySha256
  };
  const body = Buffer.from(canonical(checkpoint), 'utf8');
  return {
    format: SIGNED_EXCHANGE_FORMAT,
    journal: serializeJournal(entries),
    publicKeySpki: publicKeySpki.toString('base64'),
    envelope: {
      payloadType: CHECKPOINT_PAYLOAD_TYPE,
      payload: body.toString('base64'),
      signatures: [{ keyid: keySha256, sig: sign(null, pae(CHECKPOINT_PAYLOAD_TYPE, body), key).toString('base64') }]
    }
  };
}

/** Require canonical complete JSON for byte-consistent importing and duplicate-key rejection. */
export function serializeSignedExchange(exchange) {
  const text = canonical(exchange) + '\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_PACKAGE_BYTES)
    throw new TypeError('signed exchange exceeds bounded size');
  return text;
}
export function readSignedExchange(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PACKAGE_BYTES)
    throw new TypeError('signed exchange exceeds bounded size');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new TypeError('signed exchange is not JSON'); }
  if (serializeSignedExchange(parsed) !== text)
    throw new TypeError('signed exchange JSON is not canonical or contains duplicate keys');
  return parsed;
}

/**
 * Optional out-of-band trust:
 *   { publisher: 'expected string', publicKeySha256: 'sha256(SPKI DER)',
 *     anchor: { sequence: 0, head: '<independently saved genesis hash>' } }
 * A self-declared key or head never becomes trust merely by being correctly signed.
 */
export function inspectSignedExchange(exchange, trust = {}) {
  const findings = [];
  const add = (ruleId, status, reason) => findings.push({ ruleId, status, reason });
  const report = { format: SIGNED_EXCHANGE_FORMAT, experimental: true, findings };
  if (!keys(exchange, ['format', 'journal', 'publicKeySpki', 'envelope']) ||
      exchange.format !== SIGNED_EXCHANGE_FORMAT || !word(exchange.journal, 70 * 1024 * 1024) ||
      !keys(exchange.envelope, ['payloadType', 'payload', 'signatures']) ||
      exchange.envelope.payloadType !== CHECKPOINT_PAYLOAD_TYPE ||
      !Array.isArray(exchange.envelope.signatures) || exchange.envelope.signatures.length !== 1) {
    add('SP001', 'FAIL', 'invalid signed exchange envelope and version');
    return report;
  }
  let entries, bundle, head, key, keySha256, payload, checkpoint, sig;
  try {
    entries = readJournal(exchange.journal);
    ({ head } = validateJournal(entries));
    bundle = exportBundle(entries);
    if (hasFailures(verifyBundle(bundle)) || failIn(inspectMeasurements(bundle).findings)) {
      add('SP002', 'FAIL', 'journal exports an invalid research bundle or measurement');
      return report;
    }
    add('SP002', 'PASS', 'full hash-linked journal and bounded bundle checks passed; truth unverified');
  } catch (e) {
    add('SP002', 'FAIL', 'journal replay failed: ' + (e instanceof Error ? e.message : String(e)));
    return report;
  }
  try {
    const publicBytes = decode64(exchange.publicKeySpki, 160);
    key = createPublicKey({ key: publicBytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' ||
        !key.export({ format: 'der', type: 'spki' }).equals(publicBytes))
      throw new TypeError('noncanonical or non-Ed25519 SPKI');
    keySha256 = digest(publicBytes);
    const raw = decode64(exchange.envelope.payload, 4096);
    checkpoint = JSON.parse(raw.toString('utf8'));
    if (canonical(checkpoint) !== raw.toString('utf8') ||
        !keys(checkpoint, ['format','publisher','journalHead','entryCount','sequence','issuedAt','signerKeySha256']) ||
        checkpoint.format !== CHECKPOINT_FORMAT || !word(checkpoint.publisher) ||
        !HEX.test(checkpoint.journalHead) || !HEX.test(checkpoint.signerKeySha256) ||
        checkpoint.signerKeySha256 !== keySha256 ||
        !Number.isSafeInteger(checkpoint.entryCount) ||
        !Number.isSafeInteger(checkpoint.sequence) ||
        !validTime(checkpoint.issuedAt))
      throw new TypeError('invalid versioned canonical checkpoint');
    if (checkpoint.publisher !== bundle.provenance.source ||
        checkpoint.journalHead !== head ||
        checkpoint.entryCount !== entries.length ||
        checkpoint.sequence !== entries.length - 1 ||
        Date.parse(checkpoint.issuedAt) < Date.parse(entries.at(-1).recordedAt))
      throw new TypeError('signed checkpoint does not bind actual journal source, sequence and head');
    const signature = exchange.envelope.signatures[0];
    if (!keys(signature, ['keyid', 'sig']) || signature.keyid !== keySha256)
      throw new TypeError('invalid signing key hint');
    sig = decode64(signature.sig, 64);
    if (sig.length !== 64 ||
        !verify(null, pae(CHECKPOINT_PAYLOAD_TYPE, raw), key, sig))
      throw new TypeError('invalid Ed25519 signature');
    payload = checkpoint;
    add('SP003', 'PASS', 'Ed25519 DSSE signature binds signed checkpoint to replayed journal and public key');
  } catch (e) {
    add('SP003', 'FAIL', 'signature or signed checkpoint verification failed: ' + (e instanceof Error ? e.message : String(e)));
    return report;
  }

  if (!object(trust) || Object.keys(trust).some(k => !['publisher','publicKeySha256','anchor'].includes(k))) {
    add('SP004', 'FAIL', 'malformed local out-of-band trust policy');
  } else if (Object.hasOwn(trust, 'publisher') && trust.publisher !== payload.publisher ||
             Object.hasOwn(trust, 'publicKeySha256') && trust.publicKeySha256 !== keySha256) {
    add('SP004', 'FAIL', 'publisher or signer does not match independently pinned identity');
  } else if (word(trust.publisher) && HEX.test(trust.publicKeySha256)) {
    add('SP004', 'PASS', 'declared publisher matched caller-pinned name and signer fingerprint');
  } else {
    add('SP004', 'UNKNOWN', 'no complete independently pinned publisher-to-key binding');
  }
  if (object(trust) && Object.hasOwn(trust, 'anchor')) {
    const anchor = trust.anchor;
    if (!keys(anchor, ['sequence','head']) || !Number.isSafeInteger(anchor.sequence) ||
        anchor.sequence < 0 || anchor.sequence >= entries.length ||
        !HEX.test(anchor.head) || entries[anchor.sequence].hash !== anchor.head)
      add('SP005', 'FAIL', 'journal does not preserve independently supplied historical anchor');
    else add('SP005', 'PASS', 'history contains exact externally supplied prior sequence and digest');
  } else {
    add('SP005', 'UNKNOWN', 'no independently stored journal anchor; self-consistent wholesale rewrite possible');
  }
  add('SP006', 'UNKNOWN', 'signature cannot independently verify clock, real publisher identity, authority or ecological truth');
  if (!failIn(findings)) {
    report.bundle = bundle;
    report.checkpoint = payload;
  }
  return report;
}

function verifiedMeasurementHashes(bundle) {
  const available = new Map();
  const duplicate = new Set();
  for (const e of bundle.evidence) {
    if (!object(e) || !word(e.id)) continue;
    if (available.has(e.id)) { duplicate.add(e.id); continue; }
    if (e.access === 'inline' && typeof e.text === 'string' &&
        HEX.test(e.sha256) && digest(Buffer.from(e.text, 'utf8')) === e.sha256)
      available.set(e.id, e.sha256);
  }
  for (const id of duplicate) available.delete(id);
  const output = new Map();
  for (const a of bundle.attestations) {
    if (!object(a) || !object(a.measurement) || !Array.isArray(a.measurement.evidenceRefs)) continue;
    for (const id of a.measurement.evidenceRefs) {
      const sha = available.get(id);
      if (sha) {
        if (!output.has(sha)) output.set(sha, new Set());
        output.get(sha).add(id);
      }
    }
  }
  return output;
}

/** Reproduce bounded comparisons while preserving provenance and uncertainty. */
export function inspectSignedPair(publisherExchange, challengerExchange, { publisher = {}, challenger = {} } = {}) {
  const first = inspectSignedExchange(publisherExchange, publisher);
  const second = inspectSignedExchange(challengerExchange, challenger);
  const findings = [];
  const add = (ruleId, status, reason) => findings.push({ ruleId, status, reason });
  const report = { experimental: true, publisher: first, challenger: second, findings, comparisons: [], reusedEvidence: [] };
  if (!first.bundle || !second.bundle) {
    add('PX001', 'FAIL', 'cannot compare a journal with failed signature, journal or configured trust/anchor checks');
    return report;
  }
  if (first.checkpoint.publisher === second.checkpoint.publisher) {
    add('PX001', 'FAIL', 'publisher and challenger claim the same source namespace');
    return report;
  }
  add('PX001', 'PASS', 'each journal replayed and checkpoint signature verified; source authority remains conditional');
  if (first.checkpoint.signerKeySha256 === second.checkpoint.signerKeySha256)
    add('PX002', 'WARN', 'both source names use one signing key; publisher independence not demonstrated');
  else add('PX002', 'PASS', 'different signing public keys; actual human/institution independence still unverified');
  const pHashes = verifiedMeasurementHashes(first.bundle);
  const cHashes = verifiedMeasurementHashes(second.bundle);
  for (const [hash, ids] of pHashes) {
    if (cHashes.has(hash)) report.reusedEvidence.push({
      sha256: hash, publisherEvidenceIds: [...ids].sort(), challengerEvidenceIds: [...cHashes.get(hash)].sort()
    });
  }
  if (report.reusedEvidence.length)
    add('PX003', 'WARN', 'identical verified inline evidence bytes reused across publishers; not independent corroboration');
  else add('PX003', 'UNKNOWN', 'no identical inline measurement evidence found; sampling independence unverified');
  const comparison = inspectExchange(first.bundle, second.bundle);
  report.comparisons = comparison.comparisons;
  add('PX004', 'UNKNOWN', 'scientific, legal, delegated authority, causality and real-world observations remain unverified');
  return report;
}


/**
 * Detect a bounded signed-history split for one declared publisher/key.
 * Both complete histories must be present; without independently pinned keys
 * this is evidence of a *key's* incompatible signatures, not actor attribution.
 */
export function inspectSignedHistoryConflict(firstExchange, secondExchange, trust = {}) {
  const first = inspectSignedExchange(firstExchange, trust);
  const second = inspectSignedExchange(secondExchange, trust);
  const findings = [];
  const add = (ruleId, status, reason) => findings.push({ ruleId, status, reason });
  const report = { experimental: true, first, second, findings };
  if (!first.bundle || !second.bundle) {
    add('HF001', 'FAIL', 'both signed complete journal histories must pass the configured verification gates');
    return report;
  }
  if (first.checkpoint.publisher !== second.checkpoint.publisher ||
      first.checkpoint.signerKeySha256 !== second.checkpoint.signerKeySha256) {
    add('HF001', 'UNKNOWN', 'journals have different declared publishers or signing keys; fork cannot be attributed to one key');
    return report;
  }
  add('HF001', 'PASS', 'same declared publisher and signing key; external actor identity still unverified');
  let a, b;
  try {
    a = readJournal(firstExchange.journal);
    b = readJournal(secondExchange.journal);
  } catch {
    add('HF002', 'FAIL', 'journal could not be re-read after successful verification');
    return report;
  }
  const min = Math.min(a.length, b.length);
  let divergence = -1;
  for (let i = 0; i < min; i++) {
    if (a[i].hash !== b[i].hash) { divergence = i; break; }
  }
  if (divergence >= 0) {
    add('HF002', 'WARN', 'one signing key endorsed incompatible history at sequence ' + divergence);
    report.firstDivergentSequence = divergence;
  } else if (a.length === b.length) {
    add('HF002', 'PASS', 'same signed journal head and full history; duplicate publication only');
  } else {
    add('HF002', 'PASS', 'one fully signed journal is an exact append-only extension of the other');
  }
  if (!object(trust) || !word(trust.publisher) || !HEX.test(trust.publicKeySha256))
    add('HF003', 'UNKNOWN', 'publisher-to-key identity is not independently pinned');
  else add('HF003', 'PASS', 'same signer matched caller-pinned publisher-to-key binding');
  return report;
}
