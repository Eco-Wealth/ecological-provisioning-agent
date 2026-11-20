/**
 * Offline release-truth pins for the parts of the public kernel that can sign, spend or hold a key.
 * No network, wallet, signing or live calls. These checks describe shipped bounds, not security assurance.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("the license is the exact Apache-2.0 text, without omitted patent or liability clauses", () => {
  // Fingerprint of the canonical 202-line Apache-2.0 text shipped by the system's common-license catalog.
  const license = read("LICENSE");
  assert.equal(sha256(license), "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
  assert.match(license, /3\. Grant of Patent License/);
  assert.match(license, /8\. Limitation of Liability/);
});

test("agent client can only be installed with its pinned dependency graph", () => {
  const pkg = json("packages/agent-client/package.json");
  const lock = json("packages/agent-client/package-lock.json");
  assert.equal(pkg.dependencies.viem, "2.57.10");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(lock.packages["node_modules/viem"].version, pkg.dependencies.viem);
  assert.match(lock.packages["node_modules/viem"].integrity, /^sha512-/);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(entry.integrity ?? "", /^sha512-/, name + " must pin an immutable package digest");
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, name + " must resolve from the public registry");
  }
  const readme = read("README.md");
  assert.match(readme, /npm ci --ignore-scripts --prefix packages\/agent-client/);
  assert.doesNotMatch(readme, /npm install --prefix packages\/agent-client viem/);
});

test("the agent client documents its actual payment command and retains its conservative defaults", () => {
  const agent = read("packages/agent-client/vealth-agent.mjs");
  const truth = read("docs/truth-boundaries.md");
  const security = read("SECURITY.md");
  for (const text of [truth, security]) {
    assert.match(text, /spend-402/);
    assert.match(text, /VEALTH_AGENT_KEY/);
    assert.match(text, /worker sidecar/i);
    assert.match(text, /steward/i);
    assert.match(text, /protocol bot/i);
  }
  assert.match(agent, /const DEFAULT_MAX_SPEND_USDC = "0\.25";/);
  assert.match(agent, /const DEFAULT_DAY_BUDGET_USDC = "5";/);
  assert.match(agent, /const DEFAULT_PAY_HOSTS = \["vealth\.net", "localhost", "127\.0\.0\.1", "\[::1\]"\];/);
  assert.match(truth, /\$0\.25 for one run/);
  assert.match(truth, /\$5 a day/);
  assert.match(truth, /day-spend\.jsonl/);
});

test("the steward records an owner-only wallet and only signed, bounded board posts", () => {
  const steward = read("packages/steward-agent/steward.mjs");
  const truth = read("docs/truth-boundaries.md");
  assert.match(steward, /export const POSTS_PER_DAY = 10;/);
  assert.match(steward, /key: path\.join\(dir, "wallet\.key"\)/);
  assert.match(steward, /fs\.writeFileSync\(p\.key, [^\n]*mode: 0o600, flag: "wx"/);
  assert.match(truth, /ten posts a day/);
  assert.match(truth, /~\/\.vealth-steward\/wallet\.key/);
});

test("the scope rule for future contributions is clear about live powers", () => {
  const text = read("CONTRIBUTING.md");
  assert.match(text, /Anything new that signs, spends, posts or calls a live service/);
  assert.match(text, /starts off or dry/);
  assert.match(text, /Keep every limit that exists/);
  // A failed boundary scan must not be mistaken for proof that an unknown new command is safe.
  assert.doesNotMatch(read("docs/truth-boundaries.md"), /unconditional permission to spend/i);
});
