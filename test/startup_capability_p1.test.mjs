import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createStartupSkillFile,
  deleteStartupContextFile,
  deleteStartupSkill,
  listStartupContextFiles,
  listStartupSkillFolders,
  readStartupContextFile,
  readStartupSkillFile,
} from "../src/context_room.mjs";

function makeRoot(prefix = "context-room-startup-p1-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function startupContextSettings() {
  return {
    startupContext: {
      enabled: true,
      projectOnly: false,
      fileNames: [],
      globalPaths: ["~/.codex/AGENTS.md"],
    },
  };
}

function startupSkillSettings({ projectOnly = true } = {}) {
  return {
    startupSkills: {
      enabled: true,
      projectOnly,
      folderNames: ["skills"],
    },
  };
}

test("startup context and skill discovery refuse final symlinks and hard links outside project-only mode", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const root = path.join(home, "work", "project");
    fs.mkdirSync(root, { recursive: true });
    const external = path.join(home, "outside.md");
    fs.writeFileSync(external, "# Outside\n");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const globalPath = path.join(home, ".codex", "AGENTS.md");
    fs.symlinkSync(external, globalPath);

    const contextSettings = startupContextSettings();
    assert.deepEqual(listStartupContextFiles(root, contextSettings), []);
    assert.throws(() => readStartupContextFile(root, 1, contextSettings), /not found/i);
    fs.unlinkSync(globalPath);
    fs.linkSync(external, globalPath);
    assert.deepEqual(listStartupContextFiles(root, contextSettings), []);
    assert.equal(fs.readFileSync(external, "utf8"), "# Outside\n");

    const skillsRoot = path.join(home, "skills");
    const unsafeSkill = path.join(skillsRoot, "unsafe");
    fs.mkdirSync(unsafeSkill, { recursive: true });
    fs.symlinkSync(external, path.join(unsafeSkill, "SKILL.md"));
    const skillSettings = startupSkillSettings({ projectOnly: false });
    const folder = listStartupSkillFolders(root, skillSettings).find((item) => item.absolutePath === skillsRoot);
    assert.ok(folder);
    assert.deepEqual(folder.skills, []);
    assert.throws(() => readStartupSkillFile(root, folder.order, "unsafe", skillSettings), /not found/i);
    assert.equal(fs.readFileSync(external, "utf8"), "# Outside\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup context deletion claims the exact file and preserves a concurrent replacement", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  const originalOpenSync = fs.openSync;
  try {
    const root = path.join(home, "project");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(home, ".codex", "AGENTS.md");
    fs.writeFileSync(target, "# Original\n");
    const settings = startupContextSettings();
    const [startup] = listStartupContextFiles(root, settings);
    assert.ok(startup);

    let replaced = false;
    fs.openSync = function patchedOpenSync(filePath, ...args) {
      if (!replaced
        && path.resolve(String(filePath)) === target
        && fs.existsSync(path.join(root, ".context-room", "memory-webapp-backups"))) {
        replaced = true;
        fs.writeFileSync(target, "# Concurrent replacement\n");
      }
      return originalOpenSync.call(fs, filePath, ...args);
    };
    assert.throws(
      () => deleteStartupContextFile(root, startup.startupContext.order, settings),
      (error) => error?.code === "file_revision_conflict",
    );
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(target, "utf8"), "# Concurrent replacement\n");
  } finally {
    fs.openSync = originalOpenSync;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup context deletion refuses a symlink swap without touching its target", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  const originalOpenSync = fs.openSync;
  try {
    const root = path.join(home, "project");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(home, ".codex", "AGENTS.md");
    const sentinel = path.join(home, "sentinel.md");
    fs.writeFileSync(target, "# Original\n");
    fs.writeFileSync(sentinel, "# Sentinel\n");
    const settings = startupContextSettings();
    const [startup] = listStartupContextFiles(root, settings);

    let swapped = false;
    fs.openSync = function patchedOpenSync(filePath, ...args) {
      if (!swapped
        && path.resolve(String(filePath)) === target
        && fs.existsSync(path.join(root, ".context-room", "memory-webapp-backups"))) {
        swapped = true;
        fs.unlinkSync(target);
        fs.symlinkSync(sentinel, target);
      }
      return originalOpenSync.call(fs, filePath, ...args);
    };
    assert.throws(() => deleteStartupContextFile(root, startup.startupContext.order, settings));
    assert.equal(swapped, true);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "# Sentinel\n");
  } finally {
    fs.openSync = originalOpenSync;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup skill creation is anchored to the discovered parent capability", () => {
  const root = makeRoot();
  const skillsRoot = path.join(root, "skills");
  const originalSkillsRoot = path.join(root, "skills-original");
  const external = makeRoot("context-room-startup-external-");
  fs.mkdirSync(skillsRoot);
  const settings = startupSkillSettings();
  const [folder] = listStartupSkillFolders(root, settings);
  assert.ok(folder);

  const originalLstatSync = fs.lstatSync;
  let folderReads = 0;
  let swapped = false;
  fs.lstatSync = function patchedLstatSync(filePath, ...args) {
    const result = originalLstatSync.call(fs, filePath, ...args);
    if (path.resolve(String(filePath)) === skillsRoot) {
      folderReads += 1;
      if (!swapped && folderReads === 4) {
        swapped = true;
        fs.renameSync(skillsRoot, originalSkillsRoot);
        fs.symlinkSync(external, skillsRoot, "dir");
      }
    }
    return result;
  };
  try {
    assert.throws(
      () => createStartupSkillFile(root, folder.order, "outside-write", settings),
      (error) => ["file_revision_conflict", "managed_context_room_state_unsafe"].includes(error?.code),
    );
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(external, "outside-write")), false);
    assert.equal(fs.existsSync(path.join(originalSkillsRoot, "outside-write")), false);
  } finally {
    fs.lstatSync = originalLstatSync;
    if (fs.lstatSync(skillsRoot).isSymbolicLink()) fs.unlinkSync(skillsRoot);
    if (fs.existsSync(originalSkillsRoot)) fs.renameSync(originalSkillsRoot, skillsRoot);
  }
});

test("startup skill deletion restores a claimed directory when its tree contains a symlink", () => {
  const root = makeRoot();
  const skillsRoot = path.join(root, "skills");
  const skillRoot = path.join(skillsRoot, "alpha");
  const external = makeRoot("context-room-startup-external-");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "# Alpha\n");
  fs.writeFileSync(path.join(external, "sentinel.txt"), "sentinel\n");
  fs.symlinkSync(path.join(external, "sentinel.txt"), path.join(skillRoot, "scripts", "outside.txt"));
  const settings = startupSkillSettings();
  const [folder] = listStartupSkillFolders(root, settings);

  assert.throws(
    () => deleteStartupSkill(root, folder.order, "alpha", settings),
    (error) => error?.code === "managed_context_room_state_unsafe",
  );
  assert.equal(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8"), "sentinel\n");
  assert.equal(fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8"), "# Alpha\n");
  assert.equal(fs.lstatSync(path.join(skillRoot, "scripts", "outside.txt")).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(skillsRoot).filter((name) => name.startsWith(".context-room-startup-delete-")), []);
});

test("startup skill deletion never follows a concurrent swap of its private claim", () => {
  const root = makeRoot();
  const skillsRoot = path.join(root, "skills");
  const skillRoot = path.join(skillsRoot, "alpha");
  const external = makeRoot("context-room-startup-external-");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "# Alpha\n");
  fs.writeFileSync(path.join(external, "sentinel.txt"), "sentinel\n");
  const settings = startupSkillSettings();
  const [folder] = listStartupSkillFolders(root, settings);

  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  let preservedClaim = "";
  fs.lstatSync = function patchedLstatSync(filePath, ...args) {
    const resolved = path.resolve(String(filePath));
    if (!swapped
      && path.dirname(resolved) === skillsRoot
      && path.basename(resolved).startsWith(".context-room-startup-delete-")
      && fs.existsSync(path.join(root, ".context-room", "memory-webapp-backups"))) {
      swapped = true;
      preservedClaim = `${resolved}.attacker-preserved`;
      fs.renameSync(resolved, preservedClaim);
      fs.symlinkSync(external, resolved, "dir");
    }
    return originalLstatSync.call(fs, filePath, ...args);
  };
  try {
    assert.throws(
      () => deleteStartupSkill(root, folder.order, "alpha", settings),
      (error) => error?.code === "filesystem_recovery_required",
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8"), "sentinel\n");
  assert.equal(fs.readFileSync(path.join(preservedClaim, "SKILL.md"), "utf8"), "# Alpha\n");
});
