#!/usr/bin/env node
// Bump the published plugin version and record it in versions.json.
//
// .github/workflows/release.yml requires the pushed tag to equal manifest.json#version,
// so the bump has to exist in the commit the tag points at. Creating a dedicated
// `chore(release): X.Y.Z` commit right before tagging keeps feature commits free of
// version guessing and never rewrites already-pushed history.
//
// usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>

import { readFile, writeFile } from "node:fs/promises";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const USAGE = "usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>";

function parseVersion(text) {
  const match = SEMVER.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function resolveTarget(current, argument) {
  const [major, minor, patch] = current;
  if (argument === "patch") return `${major}.${minor}.${patch + 1}`;
  if (argument === "minor") return `${major}.${minor + 1}.0`;
  if (argument === "major") return `${major + 1}.0.0`;
  return argument;
}

const argument = process.argv[2];
if (!argument) fail(`${USAGE}（当前版本见 manifest.json）`);

const manifestText = await readFile("manifest.json", "utf8");
const manifest = JSON.parse(manifestText);
if (typeof manifest.version !== "string" || !parseVersion(manifest.version)) {
  fail(`manifest.json 的 version 不是 X.Y.Z：${String(manifest.version)}`);
}
if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion.trim()) {
  fail("manifest.json 缺少 minAppVersion，无法写入 versions.json");
}

const current = parseVersion(manifest.version);
const targetText = resolveTarget(current, argument);
const target = parseVersion(targetText);
if (!target) fail(`${USAGE}，收到 "${argument}"`);
if (compareVersions(target, current) <= 0) {
  fail(`新版本 ${targetText} 必须大于当前版本 ${manifest.version}`);
}

// Replace only the value so the file keeps its key order and formatting.
const versionPattern = /("version"\s*:\s*)"[^"]*"/;
if (!versionPattern.test(manifestText)) fail('manifest.json 里没有 "version" 字段');
const nextManifestText = manifestText.replace(versionPattern, `$1"${targetText}"`);
if (nextManifestText === manifestText) fail("manifest.json 没有被改写，请检查 version 字段");
await writeFile("manifest.json", nextManifestText, "utf8");

// versions.json maps released version -> minimum Obsidian version; newest entry first.
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const nextVersions = { [targetText]: manifest.minAppVersion };
for (const [version, minAppVersion] of Object.entries(versions)) {
  if (version !== targetText) nextVersions[version] = minAppVersion;
}
await writeFile("versions.json", `${JSON.stringify(nextVersions, null, 2)}\n`, "utf8");

console.log(`✓ manifest.json  ${manifest.version} → ${targetText}`);
console.log(`✓ versions.json ${targetText} → Obsidian ≥ ${manifest.minAppVersion}`);
console.log("");
console.log("接着执行：");
console.log(`  git add manifest.json versions.json`);
console.log(`  git commit -m "chore(release): ${targetText}"`);
console.log(`  git push && git tag ${targetText} && git push origin ${targetText}`);
