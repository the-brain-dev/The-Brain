#!/usr/bin/env bun

/**
 * Release script for the-brain
 *
 * Usage:
 *   bun run scripts/release.ts <major|minor|patch|x.y.z>
 *
 * Prerequisites:
 *   - Working directory clean (no uncommitted changes)
 *   - On `main` branch
 *   - GitHub branch protection rules allow pushes to main
 *     (requires admin access or a temporary rule exemption)
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump version in root package.json
 * 3. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 4. Commit (targeted add: package.json, bun.lock, changelogs) and tag
 * 5. Publish to npm (if public)
 * 6. Add new [Unreleased] section to changelogs
 * 7. Commit and push to main
 */

import { $ } from "bun";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
  console.error("Usage: bun run scripts/release.ts <major|minor|patch|x.y.z>");
  process.exit(1);
}

function getVersion(): string {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  return pkg.version;
}

function getChangelogs(): string[] {
  const packagesDir = "packages";
  const appsDir = "apps";
  const changelogs: string[] = [];

  for (const dir of [packagesDir, appsDir]) {
    if (!existsSync(dir)) continue;
    for (const pkg of readdirSync(dir)) {
      const changelogPath = pathJoin(dir, pkg, "CHANGELOG.md");
      if (existsSync(changelogPath)) {
        changelogs.push(changelogPath);
      }
    }
  }
  return changelogs;
}

function updateChangelogsForRelease(version: string) {
  const date = new Date().toISOString().split("T")[0];
  const changelogs = getChangelogs();

  for (const changelog of changelogs) {
    const content = readFileSync(changelog, "utf-8");

    if (!content.includes("## [Unreleased]")) {
      console.log(`  Skipping ${changelog}: no [Unreleased] section`);
      continue;
    }

    const updated = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
    writeFileSync(changelog, updated);
    console.log(`  Updated ${changelog}`);
  }
}

function addUnreleasedSection() {
  const changelogs = getChangelogs();
  const unreleasedSection = "## [Unreleased]\n\n";

  for (const changelog of changelogs) {
    const content = readFileSync(changelog, "utf-8");
    const updated = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);
    writeFileSync(changelog, updated);
    console.log(`  Added [Unreleased] to ${changelog}`);
  }
}

async function main() {
  console.log("\n=== Release Script ===\n");

  // 1. Check for uncommitted changes
  console.log("Checking for uncommitted changes...");
  const status = await $`git status --porcelain`.text();
  if (status.trim()) {
    console.error("Error: Uncommitted changes detected. Commit or stash first.");
    console.error(status);
    process.exit(1);
  }
  console.log("  Working directory clean\n");

  // 2. Bump version in root package.json
  const currentVersion = getVersion();
  console.log(`Current version: ${currentVersion}`);

  let newVersion: string;
  if (BUMP_TYPES.has(RELEASE_TARGET)) {
    await $`npm version ${RELEASE_TARGET} --no-git-tag-version`;
    newVersion = getVersion();
  } else {
    newVersion = RELEASE_TARGET;
    await $`npm version ${newVersion} --no-git-tag-version`;
  }
  console.log(`  New version: ${newVersion}\n`);

  // 3. Update changelogs
  console.log("Updating CHANGELOG.md files...");
  updateChangelogsForRelease(newVersion);
  console.log();

  // 4. Commit and tag
  console.log("Committing and tagging...");
  await $`git add package.json bun.lock packages/*/CHANGELOG.md apps/*/CHANGELOG.md`;
  await $`git commit -m "Release v${newVersion}"`;
  await $`git tag v${newVersion}`;
  console.log();

  // 5. Publish (if configured)
  console.log("Publishing to npm...");
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  if (!pkg.private) {
    await $`npm publish --workspaces --access public`;
    console.log("  Published to npm");
  } else {
    console.log("  Skipped (private package)");
  }
  console.log();

  // 6. Add new [Unreleased] sections
  console.log("Adding [Unreleased] sections for next cycle...");
  addUnreleasedSection();
  console.log();

  // 7. Commit changelog updates
  console.log("Committing changelog updates...");
  await $`git add packages/*/CHANGELOG.md apps/*/CHANGELOG.md`;
  await $`git commit -m "Add [Unreleased] section for next cycle"`;
  console.log();

  // 8. Push
  console.log("Pushing to remote...");
  await $`git push origin main`;
  await $`git push origin v${newVersion}`;
  console.log();

  console.log(`=== Released v${newVersion} ===`);
}

main().catch((err) => {
  console.error("Release failed:", err);
  process.exit(1);
});
