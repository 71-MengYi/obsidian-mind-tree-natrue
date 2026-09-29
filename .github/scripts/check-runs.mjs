#!/usr/bin/env node
/**
 * 看一眼 GitHub 上的 Actions 运行状态和最新 Release —— 用来回答"CI 到底有没有工作"。
 *
 * 用法（在仓库根目录）：
 *   node .github/scripts/check-runs.mjs
 *
 * 不需要登录，也不需要装 gh。设置 GH_TOKEN 可以避免 API 限流。
 */
import { readFile } from "node:fs/promises";

const REPOSITORY = "71-MengYi/obsidian-mind-tree-natrue";
const RUN_LIMIT = 6;

const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "mind-tree-nature-ci-check",
  ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {})
};

async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}（${path}）`);
  return response.json();
}

function shortTime(value) {
  return typeof value === "string" ? value.replace("T", " ").replace("Z", "") : "?";
}

console.log(`仓库 ${REPOSITORY}`);
console.log(`运行记录页 https://github.com/${REPOSITORY}/actions\n`);

console.log(`=== 最近 ${RUN_LIMIT} 次工作流运行 ===`);
const runs = await api(`/actions/runs?per_page=${RUN_LIMIT}`);
if (!runs.workflow_runs?.length) {
  console.log("  一次都没有。工作流只在匹配事件发生时才运行：");
  console.log("  · push 标签（形如 1.2.0）");
  console.log("  · 在 Actions 页面手动 Run workflow");
  console.log("  · 推送分支（CI 工作流）");
} else {
  for (const run of runs.workflow_runs) {
    const mark = run.conclusion === "success" ? "✅" : run.status === "in_progress" ? "⏳" : "❌";
    console.log(`  ${mark} #${run.run_number} ${run.name} | ${run.event} | ${run.head_branch} | ${run.status}/${run.conclusion} | ${shortTime(run.created_at)}`);
    console.log(`     ${run.html_url}`);
  }

  const newest = runs.workflow_runs[0];
  if (newest.conclusion === "startup_failure") {
    console.log(`\n  ❗ ${newest.name} 是 startup_failure：工作流在启动阶段就被拒，没有任何 job 跑过。`);
    console.log("     原因只写在运行页面顶部的红色横幅里（API 读不到），点开上面的链接就能看到，");
    console.log("     常见两类：工作流文件本身不合法；或仓库 Actions 设置不允许所用的 action。");
  }
  const failed = runs.workflow_runs.filter((run) => run.conclusion && !["success", "skipped"].includes(run.conclusion));
  if (failed.length && failed[0].conclusion !== "startup_failure") {
    console.log(`\n  ❗ 有失败的运行，打开 ${failed[0].html_url} 看具体哪一步失败。`);
  }
}

console.log("\n=== 最新 Release（插件用户实际装到的东西）===");
let latest = null;
try {
  latest = await api("/releases/latest");
} catch (error) {
  console.log(`  读取失败：${error.message}`);
}
if (latest) {
  console.log(`  tag ${latest.tag_name} | 草稿 ${latest.draft} | 预发布 ${latest.prerelease} | ${shortTime(latest.published_at)}`);
  console.log(`  ${latest.html_url}`);
  const names = ["main.js", "manifest.json", "styles.css"];
  for (const name of names) {
    const asset = latest.assets.filter((item) => item.name === name);
    if (asset.length !== 1) {
      console.log(`  ❌ ${name}：${asset.length} 个（插件要求恰好 1 个）`);
      continue;
    }
    const digest = typeof asset[0].digest === "string" && /^sha256:[0-9a-f]{64}$/i.test(asset[0].digest);
    console.log(`  ${digest ? "✅" : "❌"} ${name.padEnd(14)} ${String(asset[0].size).padStart(9)} bytes  ${digest ? asset[0].digest.slice(0, 19) + "…" : "缺少 sha256 digest"}`);
  }

  let localVersion = null;
  try {
    localVersion = JSON.parse(await readFile("manifest.json", "utf8")).version;
  } catch {
    console.log("  （当前目录没有 manifest.json，跳过本地版本对比）");
  }
  if (localVersion) {
    console.log(`\n  本地 manifest.json 版本：${localVersion}`);
    if (localVersion === latest.tag_name) console.log("  ✅ 本地版本已经发布出去了。");
    else console.log(`  ❗ 本地版本 ${localVersion} 还没有对应的最新 Release（线上最新是 ${latest.tag_name}），说明这一次发布没成功。`);
  }
}
