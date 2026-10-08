#!/usr/bin/env node
/**
 * 发布后自检：用与插件内置更新器（src/services/updates/release-client.ts）完全相同的规则
 * 校验线上 Release 的资产；客户端保存、替换和重新加载仍需单独验证。
 *
 * 用法（在仓库根目录）：
 *   node .github/scripts/verify-release.mjs 1.1.1
 *
 * GitHub Actions 会在 .github/workflows/release.yml 发布完成后自动调用它。
 * 有 GH_TOKEN 环境变量时会带上（只是为了避免 API 限流）。
 */
import { createHash } from "node:crypto";

const REPOSITORY = "71-MengYi/obsidian-mind-tree-natrue";
const PLUGIN_ID = "mind-tree-nature";
const FILES = ["styles.css", "main.js", "manifest.json"];
const LIMITS = { "manifest.json": 64 * 1024, "main.js": 10 * 1024 * 1024, "styles.css": 2 * 1024 * 1024 };
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[a-fA-F0-9]{64}$/;
const ATTEMPTS = 5;

const expected = process.argv[2];

/** 自检不通过。不用 process.exit()：那会在还有 fetch 连接时打断 libuv，报出误导性的崩溃。 */
class CheckFailed extends Error {}
const fail = (message) => { throw new CheckFailed(message); };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 资产刚上传时 CDN 可能还没生效，所以失败要重试几次。 */
async function retry(what, task) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof CheckFailed) throw error;
      last = error;
      if (attempt < ATTEMPTS) await sleep(1500 * attempt);
    }
  }
  fail(`${what} 连续 ${ATTEMPTS} 次失败：${last instanceof Error ? last.message : String(last)}`);
}

async function api(path) {
  return retry(`GET ${path}`, async () => {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "mind-tree-nature-release-check",
        ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

async function main() {
  if (!expected || !VERSION.test(expected)) {
    fail(`需要一个严格 X.Y.Z 形式的版本号，收到 ${JSON.stringify(expected ?? "")}`);
  }

  const release = await api("/releases/latest");
  if (release.draft !== false || release.prerelease !== false) fail("releases/latest 还是草稿或预发布，插件会拒绝它");
  if (!Number.isSafeInteger(release.id) || release.id <= 0) fail("release id 异常");
  if (release.tag_name !== expected) fail(`releases/latest 指向 ${release.tag_name}，不是刚发布的 ${expected}（请确认该版本已被标记为 Latest）`);
  if (!VERSION.test(release.tag_name)) fail(`标签 ${release.tag_name} 不是严格 X.Y.Z 形式`);
  if (!Array.isArray(release.assets)) fail("release 缺少 assets 字段");

  const assets = {};
  for (const name of FILES) {
    const matches = release.assets.filter((asset) => asset && typeof asset === "object" && asset.name === name);
    if (matches.length !== 1) fail(`${name} 在 release 里出现了 ${matches.length} 次，插件要求恰好 1 次`);
    const asset = matches[0];
    const url = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
    if (asset.browser_download_url !== url) fail(`${name} 的下载地址是 ${asset.browser_download_url}，插件要求 ${url}`);
    if (asset.state !== "uploaded") fail(`${name} 的状态是 ${asset.state}`);
    if (!Number.isSafeInteger(asset.size) || asset.size < (name === "styles.css" ? 0 : 1) || asset.size > LIMITS[name]) {
      fail(`${name} 大小 ${asset.size} 超出插件允许的范围（上限 ${LIMITS[name]} 字节）`);
    }
    if (typeof asset.digest !== "string" || !DIGEST.test(asset.digest)) {
      fail(`${name} 没有 sha256 digest，插件会直接拒绝这个 release`);
    }
    assets[name] = { size: asset.size, digest: asset.digest.slice(7).toLowerCase(), url };
  }

  /** 下载资产并验证字节大小、SHA-256 和 UTF-8 编码。 */
  async function download(name) {
    const bytes = await retry(`下载 ${name}`, async () => {
      const response = await fetch(assets[name].url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength === 0) throw new Error("内容为空");
      return buffer;
    });
    const hex = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== assets[name].size) fail(`${name} 实际大小 ${bytes.byteLength} 与 API 报告的 ${assets[name].size} 不一致`);
    if (hex !== assets[name].digest) fail(`${name} 实际 SHA-256 是 ${hex}，与资产 digest 不一致`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail(`${name} 不是合法的 UTF-8 文本`);
    }
    console.log(`  ok  ${name.padEnd(14)} ${String(bytes.byteLength).padStart(9)} bytes  sha256:${hex.slice(0, 12)}…`);
    return text;
  }

  const manifestText = await download("manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail("manifest.json 不是合法 JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest.json 顶层必须是对象");
  if (manifest.id !== PLUGIN_ID) fail(`manifest.json 的 id 是 ${manifest.id}，应为 ${PLUGIN_ID}`);
  if (manifest.version !== release.tag_name) fail(`manifest.json 的 version 是 ${manifest.version}，与标签 ${release.tag_name} 不一致`);
  if (typeof manifest.minAppVersion !== "string" || !VERSION.test(manifest.minAppVersion)) {
    fail(`minAppVersion ${manifest.minAppVersion} 不是严格 X.Y.Z 形式`);
  }
  if (typeof manifest.isDesktopOnly !== "boolean") fail("manifest.json 缺少 isDesktopOnly");
  for (const key of ["name", "author", "description"]) {
    if (typeof manifest[key] !== "string" || !manifest[key].trim()) fail(`manifest.json 的 ${key} 缺失或为空`);
  }

  await download("main.js");
  await download("styles.css");

  console.log(`\nrelease ${release.tag_name} 通过自检：${FILES.join(" / ")} 三个资产齐全、digest 一致，`);
  console.log(`发布资产检查通过：${release.html_url}；客户端安装与重载需另行验证。`);
}

try {
  await main();
} catch (error) {
  if (error instanceof CheckFailed) console.error(`::error::${error.message}`);
  else console.error(`::error::自检脚本意外出错：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
