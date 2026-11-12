#!/usr/bin/env node

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_FILE_NAME = "海报提示词.txt";
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".gif",
  ".avif",
  ".heic",
  ".heif",
]);
const CLIENT_PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const DEFAULT_CDP_URL = "http://127.0.0.1:9223";
const DEFAULT_CDP_STARTUP_TIMEOUT_MS = 30 * 1000;
const DEFAULT_LOGIN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120 * 1000;
const DEFAULT_SEND_CONFIRM_TIMEOUT_MS = 90 * 1000;
const DEFAULT_GENERATION_TIMEOUT_MIN = 7;
const DEFAULT_GENERATION_TIMEOUT_MS = DEFAULT_GENERATION_TIMEOUT_MIN * 60 * 1000;
const DEFAULT_MAX_GENERATION_RETRIES = 2;
const DEFAULT_MAX_DOWNLOAD_RETRIES = 3;
const DEFAULT_DOWNLOAD_WAIT_SECONDS = 20;
const DEFAULT_GENERATION_RECOVERY_WAIT_MS = 90 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_BATCH_INTERVAL_MS = 15 * 1000;
const DEFAULT_EXAMPLE_WAVE_SIZE = 4;
const DEFAULT_EXAMPLE_WAVE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_EXAMPLE_WAVE_JITTER_MS = 30 * 1000;
const DEFAULT_EXAMPLE_MAX_ACTIVE_WINDOWS = 4;
const EXAMPLE_ANALYSIS_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const EXAMPLE_ANALYSIS_REQUIRED_FIELDS = [
  "template_info",
  "selection_tags",
  "retrieval_text",
  "generation_blueprint",
  "scoring_notes",
];
const DEFAULT_GENERATION_SUFFIX =
  "替换成参考图的客户的人像。保留人像脸部和发型，其他身体姿势，表情，动作，服装等最好保留json里面原有的。依次发我";
const CHATGPT_PROFILE_DIR_NAME = ".chrome-chatgpt-debug-profile";
const GENERATION_FINAL_FAILURE_STATUSES = new Set(["generation_failed", "download_failed"]);
const GENERATION_DOWNLOAD_ONLY_STATUSES = new Set([
  "generated",
  "generated_seen",
  "refresh_recovered",
  "downloading",
  "download_failed",
]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
let manifestSaveQueue = Promise.resolve();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dirs = workspacePaths(path.resolve(options.root ?? ROOT_DIR));

  if (options.selfTest) {
    await runSelfTests();
    return;
  }

  if (options.dryRun) {
    if (options.analyzeExamplesResume) {
      await printExampleResumeDryRunSummary({ dirs, options });
    } else if (options.generateFromJson) {
      await printGenerationDryRunSummary({ dirs, options });
    } else {
      const promptFile = path.resolve(dirs.root, options.promptFile ?? PROMPT_FILE_NAME);
      const prompt = await loadPrompt(promptFile);
      const renamePlan = await buildRenamePlan(dirs.exampleDir);
      printDryRunSummary({ dirs, promptFile, prompt, renamePlan, options });
    }
    return;
  }

  await ensureSupportDirs(dirs);
  setupRunLogging(dirs);

  if (options.openOnly) {
    await runBrowserSmokeTest({ dirs, options });
    return;
  }
  if (options.cleanupTabsOnly) {
    await runTabCleanup({ dirs, options });
    return;
  }
  if (options.analyzeExamplesResume) {
    const manifest = await createExampleResumeManifest({ dirs, options });
    const failedTasks = await runExampleResumeWorkflow({ dirs, options, manifest });
    if (failedTasks.length > 0) {
      const missing = failedTasks.map((task) => task.index).join(", ");
      throw new Error(`Example analysis failed for image index(es): ${missing}`);
    }
    return;
  }
  if (options.generateFromJson) {
    const manifest = options.resumeCurrent || options.collectImagesOnly
      ? await loadCurrentGenerationManifestForResume({ dirs, options })
      : await createGenerationManifest({ dirs, options });
    const failedTasks = options.collectImagesOnly
      ? await runGenerationImageCollectionWorkflow({ dirs, options, manifest })
      : await runGenerationWorkflow({ dirs, options, manifest });
    if (failedTasks.length > 0) {
      const missing = failedTasks.map((task) => task.index).join(", ");
      throw new Error(`处理结束，但以下序号失败：${missing}。其他对话链接已经保留。`);
    }
    return;
  }
  if (options.resumeCurrent) {
    const manifest = await loadCurrentManifestForResume({ dirs, options });
    const failedTasks = await runWorkflow({ dirs, options, manifest });
    if (failedTasks.length > 0) {
      const missing = failedTasks.map((task) => task.index).join(", ");
      throw new Error(`补跑结束，但以下序号仍然失败：${missing}。其他成功结果已经保留。`);
    }
    return;
  }

  const promptFile = path.resolve(dirs.root, options.promptFile ?? PROMPT_FILE_NAME);
  const prompt = await loadPrompt(promptFile);
  const renamePlan = await buildRenamePlan(dirs.exampleDir);
  if (renamePlan.length === 0) {
    throw new Error("“例图”文件夹里没有找到图片。请先放入需要分析的图片。");
  }

  const renameMap = await applyRenamePlan(renamePlan);
  const manifest = await createManifest({ dirs, options, prompt, promptFile, renameMap });
  const failedTasks = await runWorkflow({ dirs, options, manifest });

  if (failedTasks.length > 0) {
    const missing = failedTasks.map((task) => task.index).join(", ");
    throw new Error(`处理结束，但以下序号仍然失败：${missing}。其他成功结果已经保留。`);
  }
}

function parseArgs(args) {
  const options = {
    autoOpenBrowser: true,
    analyzeExamplesResume: false,
    cdpUrl: process.env.CHATGPT_CDP_URL || DEFAULT_CDP_URL,
    cleanupExistingTabs: true,
    cleanupTabsOnly: false,
    collectImagesOnly: false,
    connectExisting: false,
    dryRun: false,
    generateFromJson: false,
    generationSuffix: process.env.PORTRAIT_GENERATION_SUFFIX || DEFAULT_GENERATION_SUFFIX,
    generationTimeoutMin: Number.parseFloat(process.env.PORTRAIT_GENERATION_TIMEOUT_MIN || DEFAULT_GENERATION_TIMEOUT_MIN),
    generationTimeoutMs: Math.round(
      Number.parseFloat(process.env.PORTRAIT_GENERATION_TIMEOUT_MIN || DEFAULT_GENERATION_TIMEOUT_MIN) * 60 * 1000,
    ),
    headless: false,
    batchIntervalMs: DEFAULT_BATCH_INTERVAL_MS,
    batchIntervalRangeMs: null,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    maxGenerationRetries: Number.parseInt(process.env.PORTRAIT_MAX_GENERATION_RETRIES || DEFAULT_MAX_GENERATION_RETRIES, 10),
    maxDownloadRetries: Number.parseInt(process.env.PORTRAIT_MAX_DOWNLOAD_RETRIES || DEFAULT_MAX_DOWNLOAD_RETRIES, 10),
    downloadWaitSeconds: Number.parseInt(process.env.PORTRAIT_DOWNLOAD_WAIT_SECONDS || DEFAULT_DOWNLOAD_WAIT_SECONDS, 10),
    generationRecoveryWaitMs: Number.parseInt(
      process.env.PORTRAIT_GENERATION_RECOVERY_WAIT_MS || DEFAULT_GENERATION_RECOVERY_WAIT_MS,
      10,
    ),
    maxParallel: DEFAULT_MAX_PARALLEL,
    openOnly: false,
    promptFile: process.env.PORTRAIT_JSON_PROMPT_FILE || null,
    jsonTextDir: process.env.PORTRAIT_JSON_TEXT_DIR || null,
    top4Json: process.env.PORTRAIT_TOP4_JSON || null,
    clientPhotoDir: process.env.PORTRAIT_CLIENT_PHOTO_DIR || null,
    generationOutputDir: process.env.PORTRAIT_GENERATION_OUTPUT_DIR || null,
    analysisExampleDir: process.env.EXAMPLE_ANALYZE_DIR || null,
    analysisOutputDir: process.env.EXAMPLE_ANALYZE_OUTPUT_DIR || null,
    startIndex: process.env.EXAMPLE_ANALYZE_START_INDEX
      ? Number.parseInt(process.env.EXAMPLE_ANALYZE_START_INDEX, 10)
      : null,
    overwrite: false,
    waveSize: Number.parseInt(process.env.EXAMPLE_ANALYZE_WAVE_SIZE || DEFAULT_EXAMPLE_WAVE_SIZE, 10),
    waveIntervalMs: Number.parseInt(
      process.env.EXAMPLE_ANALYZE_WAVE_INTERVAL_MS || DEFAULT_EXAMPLE_WAVE_INTERVAL_MS,
      10,
    ),
    waveJitterMs: Number.parseInt(
      process.env.EXAMPLE_ANALYZE_WAVE_JITTER_MS || DEFAULT_EXAMPLE_WAVE_JITTER_MS,
      10,
    ),
    maxActiveWindows: Number.parseInt(
      process.env.EXAMPLE_ANALYZE_MAX_ACTIVE_WINDOWS || DEFAULT_EXAMPLE_MAX_ACTIVE_WINDOWS,
      10,
    ),
    uploadTimeoutMs: Number.parseInt(process.env.EXAMPLE_ANALYZE_UPLOAD_TIMEOUT_MS || DEFAULT_UPLOAD_TIMEOUT_MS, 10),
    sendConfirmTimeoutMs: Number.parseInt(
      process.env.EXAMPLE_ANALYZE_SEND_CONFIRM_TIMEOUT_MS || DEFAULT_SEND_CONFIRM_TIMEOUT_MS,
      10,
    ),
    skipExisting: process.env.EXAMPLE_ANALYZE_SKIP_EXISTING
      ? parseBoolean(process.env.EXAMPLE_ANALYZE_SKIP_EXISTING, "EXAMPLE_ANALYZE_SKIP_EXISTING")
      : true,
    responseTimeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS,
    resumeCurrent: false,
    root: process.env.WORKFLOW_ROOT,
    selfTest: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      index += 1;
      if (!args[index]) throw new Error(`${arg} 缺少参数值`);
      return args[index];
    };

    if (arg === "--cleanup-tabs-only") options.cleanupTabsOnly = true;
    else if (arg === "--analyze-examples-resume" || arg === "--examples-analyze") {
      options.analyzeExamplesResume = true;
    }
    else if (arg === "--collect-images-only") options.collectImagesOnly = true;
    else if (arg === "--connect-existing") options.connectExisting = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--generate-from-json") options.generateFromJson = true;
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--batch-interval-ms" || arg === "--launch-interval-ms") {
      options.batchIntervalMs = Number.parseInt(readValue(), 10);
    }
    else if (arg === "--batch-interval-range-ms" || arg === "--launch-interval-range-ms") {
      options.batchIntervalRangeMs = parseIntervalRange(readValue(), arg);
    }
    else if (arg === "--no-auto-open-browser") options.autoOpenBrowser = false;
    else if (arg === "--keep-open-tabs") options.cleanupExistingTabs = false;
    else if (arg === "--open-only") options.openOnly = true;
    else if (arg === "--resume-current" || arg === "--resume") options.resumeCurrent = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--cdp-url") options.cdpUrl = readValue();
    else if (arg === "--login-timeout-ms") options.loginTimeoutMs = Number.parseInt(readValue(), 10);
    else if (arg === "--max-attempts") options.maxAttempts = Number.parseInt(readValue(), 10);
    else if (arg === "--generation-suffix") options.generationSuffix = readValue();
    else if (arg === "--generation-timeout-ms") {
      options.generationTimeoutMs = Number.parseInt(readValue(), 10);
      options.generationTimeoutMin = options.generationTimeoutMs / 60_000;
    }
    else if (arg === "--generation-timeout-min") {
      options.generationTimeoutMin = Number.parseFloat(readValue());
      options.generationTimeoutMs = Math.round(options.generationTimeoutMin * 60 * 1000);
    }
    else if (arg === "--max-generation-retries") options.maxGenerationRetries = Number.parseInt(readValue(), 10);
    else if (arg === "--max-download-retries") options.maxDownloadRetries = Number.parseInt(readValue(), 10);
    else if (arg === "--download-wait-seconds") options.downloadWaitSeconds = Number.parseInt(readValue(), 10);
    else if (arg === "--generation-recovery-wait-ms") options.generationRecoveryWaitMs = Number.parseInt(readValue(), 10);
    else if (arg === "--json-text-dir") options.jsonTextDir = readValue();
    else if (arg === "--top4-json") options.top4Json = readValue();
    else if (arg === "--client-photo-dir") options.clientPhotoDir = readValue();
    else if (arg === "--example-dir") options.analysisExampleDir = readValue();
    else if (arg === "--output-dir") {
      const value = readValue();
      options.generationOutputDir = value;
      options.analysisOutputDir = value;
    }
    else if (arg === "--start-index") options.startIndex = Number.parseInt(readValue(), 10);
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--wave-size") options.waveSize = Number.parseInt(readValue(), 10);
    else if (arg === "--wave-interval-ms") options.waveIntervalMs = Number.parseInt(readValue(), 10);
    else if (arg === "--wave-jitter-ms") options.waveJitterMs = Number.parseInt(readValue(), 10);
    else if (arg === "--max-active-windows") options.maxActiveWindows = Number.parseInt(readValue(), 10);
    else if (arg === "--upload-timeout-ms") options.uploadTimeoutMs = Number.parseInt(readValue(), 10);
    else if (arg === "--send-confirm-timeout-ms") options.sendConfirmTimeoutMs = Number.parseInt(readValue(), 10);
    else if (arg === "--skip-existing") {
      if (args[index + 1] && !args[index + 1].startsWith("--")) {
        options.skipExisting = parseBoolean(readValue(), "--skip-existing");
      } else {
        options.skipExisting = true;
      }
    }
    else if (arg === "--no-skip-existing") options.skipExisting = false;
    else if (arg === "--max-parallel") {
      const value = readValue();
      options.maxParallel =
        value === "0" || value === "all" ? Number.POSITIVE_INFINITY : Number.parseInt(value, 10);
    } else if (arg === "--prompt-file") options.promptFile = readValue();
    else if (arg === "--response-timeout-ms") options.responseTimeoutMs = Number.parseInt(readValue(), 10);
    else if (arg === "--root") options.root = readValue();
    else throw new Error(`未知参数：${arg}`);
  }

  if (!Number.isInteger(options.loginTimeoutMs) || options.loginTimeoutMs < 60_000) {
    throw new Error("--login-timeout-ms 至少需要 60000");
  }
  if (!Number.isInteger(options.batchIntervalMs) || options.batchIntervalMs < 0) {
    throw new Error("--batch-interval-ms 必须是大于或等于 0 的整数");
  }
  if (
    options.batchIntervalRangeMs &&
    (!Number.isInteger(options.batchIntervalRangeMs.minMs) ||
      !Number.isInteger(options.batchIntervalRangeMs.maxMs) ||
      options.batchIntervalRangeMs.minMs < 0 ||
      options.batchIntervalRangeMs.maxMs < options.batchIntervalRangeMs.minMs)
  ) {
    throw new Error("--batch-interval-range-ms 必须是类似 180000-300000 的毫秒范围");
  }
  if (!Number.isInteger(options.responseTimeoutMs) || options.responseTimeoutMs < 60_000) {
    throw new Error("--response-timeout-ms 至少需要 60000");
  }
  if (!Number.isInteger(options.generationTimeoutMs) || options.generationTimeoutMs < 60_000) {
    throw new Error("--generation-timeout-ms 至少需要 60000");
  }
  if (!Number.isFinite(options.generationTimeoutMin) || options.generationTimeoutMin <= 0) {
    options.generationTimeoutMin = options.generationTimeoutMs / 60_000;
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error("--max-attempts 必须是大于 0 的整数");
  }
  if (!Number.isInteger(options.maxGenerationRetries) || options.maxGenerationRetries < 0) {
    throw new Error("--max-generation-retries 必须是大于或等于 0 的整数");
  }
  if (!Number.isInteger(options.maxDownloadRetries) || options.maxDownloadRetries < 1) {
    throw new Error("--max-download-retries 必须是大于 0 的整数");
  }
  if (!Number.isInteger(options.downloadWaitSeconds) || options.downloadWaitSeconds < 0) {
    throw new Error("--download-wait-seconds 必须是大于或等于 0 的整数");
  }
  if (!Number.isInteger(options.generationRecoveryWaitMs) || options.generationRecoveryWaitMs < 60_000) {
    throw new Error("--generation-recovery-wait-ms must be at least 60000.");
  }
  if (
    options.maxParallel !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(options.maxParallel) || options.maxParallel < 1)
  ) {
    throw new Error("--max-parallel 必须是大于 0 的整数，或使用 all/0 表示全部并发");
  }

  if (options.analyzeExamplesResume) {
    if (options.generateFromJson) {
      throw new Error("--analyze-examples-resume cannot be combined with --generate-from-json.");
    }
    if (options.startIndex !== null && (!Number.isInteger(options.startIndex) || options.startIndex < 1)) {
      throw new Error("--start-index must be a positive integer.");
    }
    if (!Number.isInteger(options.waveSize) || options.waveSize < 1) {
      throw new Error("--wave-size must be a positive integer.");
    }
    if (!Number.isInteger(options.waveIntervalMs) || options.waveIntervalMs < 0) {
      throw new Error("--wave-interval-ms must be 0 or a positive integer.");
    }
    if (!Number.isInteger(options.waveJitterMs) || options.waveJitterMs < 0) {
      throw new Error("--wave-jitter-ms must be 0 or a positive integer.");
    }
    if (!Number.isInteger(options.maxActiveWindows) || options.maxActiveWindows < 1) {
      throw new Error("--max-active-windows must be a positive integer.");
    }
    if (!Number.isInteger(options.uploadTimeoutMs) || options.uploadTimeoutMs < 10_000) {
      throw new Error("--upload-timeout-ms must be at least 10000.");
    }
    if (!Number.isInteger(options.sendConfirmTimeoutMs) || options.sendConfirmTimeoutMs < 10_000) {
      throw new Error("--send-confirm-timeout-ms must be at least 10000.");
    }
  }

  return options;
}

function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

function parseIntervalRange(value, optionName) {
  const match = String(value).trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!match) throw new Error(`${optionName} 必须是类似 180000-300000 的毫秒范围`);
  const minMs = Number.parseInt(match[1], 10);
  const maxMs = Number.parseInt(match[2], 10);
  if (maxMs < minMs) throw new Error(`${optionName} 的结束值不能小于开始值`);
  return { minMs, maxMs };
}

function workspacePaths(root) {
  return {
    root,
    exampleDir: path.join(root, "例图"),
    customerDir: path.join(root, "客户照片"),
    outputRootDir: path.join(root, "输出结果"),
    imageResultRootDir: path.join(root, "图片结果"),
    recordsDir: path.join(root, "运行记录"),
    screenshotsDir: path.join(root, "运行记录", "screenshots"),
    profileDir: resolveWorkflowProfileDir(root),
  };
}

function resolveWorkflowProfileDir(root) {
  const configured = process.env.CHATGPT_PROFILE_DIR;
  if (configured && configured.trim()) return path.resolve(root, configured.trim());
  return path.join(root, CHATGPT_PROFILE_DIR_NAME);
}

async function ensureSupportDirs(dirs) {
  await Promise.all([
    fs.mkdir(dirs.recordsDir, { recursive: true }),
    fs.mkdir(dirs.screenshotsDir, { recursive: true }),
    fs.mkdir(dirs.profileDir, { recursive: true }),
  ]);
}

async function loadPrompt(file) {
  let prompt;
  try {
    prompt = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`没有找到提示词文件：${file}`);
    }
    throw error;
  }

  const normalized = prompt.trim();
  if (!normalized) throw new Error(`提示词文件是空的：${file}`);
  return normalized;
}

async function listImageEntries(dir, allowedExtensions = IMAGE_EXTENSIONS) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const images = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name);
    if (!allowedExtensions.has(extension.toLowerCase())) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.stat(file);
    images.push({
      file,
      name: entry.name,
      extension,
      mtimeMs: stat.mtimeMs,
    });
  }
  return images;
}

async function buildRenamePlan(exampleDir) {
  const images = await listImageEntries(exampleDir);
  images.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return naturalCompare(a.name, b.name);
  });

  return images.map((image, offset) => ({
    index: offset + 1,
    originalFile: image.file,
    originalName: image.name,
    renamedFile: path.join(exampleDir, `${offset + 1}${image.extension}`),
    renamedName: `${offset + 1}${image.extension}`,
    mtimeMs: image.mtimeMs,
  }));
}

function naturalCompare(left, right) {
  return left.localeCompare(right, "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

async function applyRenamePlan(renamePlan) {
  if (renamePlan.length === 0) return [];

  const staged = renamePlan.map((item) => ({
    ...item,
    tempFile: path.join(
      path.dirname(item.originalFile),
      `.image-json-workflow-${crypto.randomUUID()}${item.extension ?? path.extname(item.originalName)}`,
    ),
    currentFile: item.originalFile,
  }));

  try {
    for (const item of staged) {
      await fs.rename(item.originalFile, item.tempFile);
      item.currentFile = item.tempFile;
    }
    for (const item of staged) {
      await fs.rename(item.tempFile, item.renamedFile);
      item.currentFile = item.renamedFile;
    }
  } catch (error) {
    await rollbackRename(staged);
    throw new Error(`例图重新编号失败，已经尝试恢复原文件名：${error.message}`);
  }

  return staged.map(({ index, originalName, renamedName, renamedFile, mtimeMs }) => ({
    index,
    originalName,
    renamedName,
    renamedFile,
    mtimeMs,
  }));
}

async function rollbackRename(items) {
  const recoveries = [];
  for (const item of items) {
    if (!(await fileExists(item.currentFile))) continue;
    const recoveryFile = path.join(
      path.dirname(item.originalFile),
      `.image-json-workflow-rollback-${crypto.randomUUID()}${path.extname(item.originalName)}`,
    );
    await fs.rename(item.currentFile, recoveryFile).catch(() => {});
    recoveries.push({ recoveryFile, originalFile: item.originalFile });
  }
  for (const item of recoveries) {
    await fs.rename(item.recoveryFile, item.originalFile).catch(() => {});
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function printDryRunSummary({ dirs, promptFile, prompt, renamePlan, options }) {
  console.log("预览模式：不会重命名、不会创建输出文件夹、不会连接 ChatGPT。");
  console.log(`工作目录：${dirs.root}`);
  console.log(`提示词文件：${promptFile}`);
  console.log(`提示词：${prompt}`);
  console.log(`例图数量：${renamePlan.length}`);
  console.log(`并发数量：${formatParallel(options.maxParallel)}`);
  console.log(`每轮间隔：${formatDuration(options.batchIntervalMs)}`);
  console.log("");
  console.log("计划编号：");
  for (const item of renamePlan) {
    console.log(`${String(item.index).padStart(2, " ")}. ${item.originalName} -> ${item.renamedName}`);
  }
}

async function buildExampleResumePlan({ dirs, options }) {
  const exampleDir = resolveOptionalWorkspacePath(dirs.root, options.analysisExampleDir, dirs.exampleDir);
  const outputDir = await resolveExampleAnalysisOutputDir({ dirs, options });
  const maxExistingTxtIndex = await maxNumericTxtIndex(outputDir);
  const startIndex = options.startIndex ?? maxExistingTxtIndex + 1;
  const listedImages = await listNumberedExampleImages(exampleDir);
  const allImages = listedImages.images;
  const duplicateImages = listedImages.duplicates.filter((item) => item.index >= startIndex);
  const tasks = [];
  const skippedExisting = [];

  for (const image of allImages) {
    if (image.index < startIndex) continue;
    const outputFile = path.join(outputDir, `${image.index}.txt`);
    const outputExists = await fileExists(outputFile);
    const planned = {
      index: image.index,
      imageFile: image.file,
      imageName: image.name,
      outputFile,
      outputName: path.basename(outputFile),
      outputExists,
    };
    if (outputExists && options.skipExisting && !options.overwrite) {
      skippedExisting.push(planned);
      continue;
    }
    tasks.push(planned);
  }

  return {
    exampleDir,
    outputDir,
    maxExistingTxtIndex,
    startIndex,
    allImages,
    duplicateImages,
    tasks,
    skippedExisting,
    waves: chunk(tasks, options.waveSize),
  };
}

async function printExampleResumeDryRunSummary({ dirs, options }) {
  const plan = await buildExampleResumePlan({ dirs, options });
  console.log("Example JSON analysis dry-run: no browser, no ChatGPT request, no txt write.");
  console.log(`example folder: ${relativeOrAbsolute(dirs.root, plan.exampleDir)}`);
  console.log(`output folder: ${relativeOrAbsolute(dirs.root, plan.outputDir)}`);
  console.log(
    `start index: ${plan.startIndex}` +
      (options.startIndex ? " (manual)" : ` (auto from max txt ${plan.maxExistingTxtIndex || 0})`),
  );
  console.log(`overwrite: ${options.overwrite ? "yes" : "no, existing txt will be skipped"}`);
  console.log(
    `wave settings: size=${options.waveSize}, interval=${options.waveIntervalMs} ms, jitter=±${options.waveJitterMs} ms, max-active=${options.maxActiveWindows}`,
  );
  console.log(
    `timeouts: upload=${options.uploadTimeoutMs} ms, send-confirm=${options.sendConfirmTimeoutMs} ms, response=${options.responseTimeoutMs} ms`,
  );
  console.log(`skip existing txt: ${options.skipExisting ? "yes" : "no"}`);
  console.log(`numbered images found: ${plan.allImages.length}`);
  console.log(`planned images: ${plan.tasks.length}`);
  if (plan.skippedExisting.length > 0) {
    console.log(`skipped because txt exists: ${plan.skippedExisting.map((item) => item.index).join(",")}`);
  }
  if (plan.duplicateImages.length > 0) {
    console.log(
      `skipped duplicate image number(s): ${plan.duplicateImages
        .map((item) => `${item.index}(${item.name})`)
        .join(",")}`,
    );
  }
  if (plan.tasks.length === 0) {
    console.log("waves: none");
    return;
  }
  for (let index = 0; index < plan.waves.length; index += 1) {
    const wave = plan.waves[index];
    console.log(`wave ${index + 1}: ${wave.map((item) => item.index).join(",")}`);
    console.log(`  output: ${wave.map((item) => item.outputName).join(",")}`);
  }
}

async function createExampleResumeManifest({ dirs, options }) {
  const promptFile = path.resolve(dirs.root, options.promptFile ?? PROMPT_FILE_NAME);
  const prompt = await loadPrompt(promptFile);
  const plan = await buildExampleResumePlan({ dirs, options });
  await fs.mkdir(plan.outputDir, { recursive: true });
  const runId = timestampId();
  const manifest = {
    version: 1,
    workflowMode: "image-json-deconstruction-resume",
    runId,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prompt,
    promptFile: relativeForManifest(dirs.root, promptFile),
    exampleDir: relativeForManifest(dirs.root, plan.exampleDir),
    outputDir: relativeForManifest(dirs.root, plan.outputDir),
    startIndex: plan.startIndex,
    startIndexSource: options.startIndex ? "manual" : "auto",
    maxExistingTxtIndex: plan.maxExistingTxtIndex,
    overwrite: options.overwrite,
    waveSize: options.waveSize,
    waveIntervalMs: options.waveIntervalMs,
    waveJitterMs: options.waveJitterMs,
    maxActiveWindows: options.maxActiveWindows,
    uploadTimeoutMs: options.uploadTimeoutMs,
    sendConfirmTimeoutMs: options.sendConfirmTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
    skipExisting: options.skipExisting,
    maxAttempts: options.maxAttempts,
    skippedExisting: plan.skippedExisting.map((item) => ({
      index: item.index,
      image_path: relativeForManifest(dirs.root, item.imageFile),
      output_txt_path: relativeForManifest(dirs.root, item.outputFile),
      status: "skipped_existing",
    })),
    skippedDuplicates: plan.duplicateImages.map((item) => ({
      index: item.index,
      image_path: relativeForManifest(dirs.root, item.file),
      kept_image_path: relativeForManifest(dirs.root, item.keptFile),
      status: "skipped_duplicate_number",
    })),
    tasks: plan.tasks.map((item) => ({
      index: item.index,
      image: relativeForManifest(dirs.root, item.imageFile),
      output: relativeForManifest(dirs.root, item.outputFile),
      image_path: relativeForManifest(dirs.root, item.imageFile),
      output_txt_path: relativeForManifest(dirs.root, item.outputFile),
      status: "pending",
      attempts: 0,
      conversations: [],
      current_stage: null,
      failed_stage: null,
      started_at: null,
      finished_at: null,
      error: null,
    })),
  };
  await saveExampleResumeManifest(dirs, manifest);
  console.log(`Example analysis resume manifest: ${manifest.runId}`);
  console.log(`Output folder: ${plan.outputDir}`);
  console.log(`Start index: ${plan.startIndex}; planned images: ${manifest.tasks.length}`);
  if (plan.skippedExisting.length > 0) {
    console.log(`Skipped existing txt: ${plan.skippedExisting.map((item) => item.index).join(",")}`);
  }
  if (plan.duplicateImages.length > 0) {
    console.log(
      `Skipped duplicate image number(s): ${plan.duplicateImages
        .map((item) => `${item.index}(${item.name})`)
        .join(",")}`,
    );
  }
  return manifest;
}

async function resolveExampleAnalysisOutputDir({ dirs, options }) {
  if (options.analysisOutputDir) {
    return resolveOptionalWorkspacePath(dirs.root, options.analysisOutputDir, null);
  }

  let entries;
  try {
    entries = await fs.readdir(dirs.outputRootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("No output folder found. Pass --output-dir for resumable example analysis.");
    }
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(dirs.outputRootDir, entry.name);
    const maxIndex = await maxNumericTxtIndex(dir);
    if (maxIndex <= 0) continue;
    const stat = await fs.stat(dir);
    candidates.push({ dir, maxIndex, mtimeMs: stat.mtimeMs });
  }
  if (candidates.length === 0) {
    throw new Error("No numbered txt output folder found. Pass --output-dir for resumable example analysis.");
  }
  candidates.sort((a, b) => b.maxIndex - a.maxIndex || b.mtimeMs - a.mtimeMs);
  return candidates[0].dir;
}

function resolveOptionalWorkspacePath(root, value, fallback) {
  if (!value) return fallback;
  return path.resolve(root, value);
}

async function listNumberedExampleImages(exampleDir) {
  const images = await listImageEntries(exampleDir, EXAMPLE_ANALYSIS_IMAGE_EXTENSIONS);
  const numbered = [];
  const duplicates = [];
  const seen = new Map();
  const candidates = [];
  for (const image of images) {
    const stem = path.basename(image.name, image.extension);
    if (!/^\d+$/.test(stem)) continue;
    candidates.push({ ...image, index: Number.parseInt(stem, 10) });
  }
  candidates.sort((a, b) => a.index - b.index || naturalCompare(a.name, b.name));
  for (const image of candidates) {
    const index = image.index;
    if (seen.has(index)) {
      const kept = seen.get(index);
      duplicates.push({
        ...image,
        keptFile: kept.file,
        keptName: kept.name,
      });
      continue;
    }
    seen.set(index, image);
    numbered.push({ ...image, index });
  }
  return { images: numbered, duplicates };
}

async function maxNumericTxtIndex(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let maxIndex = 0;
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".txt") continue;
    const stem = path.basename(entry.name, ".txt");
    if (!/^\d+$/.test(stem)) continue;
    maxIndex = Math.max(maxIndex, Number.parseInt(stem, 10));
  }
  return maxIndex;
}

function relativeOrAbsolute(root, file) {
  const relative = path.relative(root, file);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return relative || ".";
  return file;
}

function formatParallel(maxParallel) {
  return maxParallel === Number.POSITIVE_INFINITY ? "全部同时处理" : String(maxParallel);
}

function formatDuration(milliseconds) {
  if (milliseconds === 0) return "不等待";
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000} 秒`;
  return `${milliseconds} 毫秒`;
}

function formatIntervalSetting({ intervalMs, intervalRangeMs }) {
  if (!intervalRangeMs) return formatDuration(intervalMs);
  return `${formatDuration(intervalRangeMs.minMs)} 到 ${formatDuration(intervalRangeMs.maxMs)} 随机`;
}

function nextIntervalMs({ intervalMs, intervalRangeMs }) {
  if (!intervalRangeMs) return intervalMs;
  return crypto.randomInt(intervalRangeMs.minMs, intervalRangeMs.maxMs + 1);
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function createManifest({ dirs, options, prompt, promptFile, renameMap }) {
  const runId = timestampId();
  const outputDir = path.join(dirs.outputRootDir, `run_${runId}`);
  await fs.mkdir(outputDir, { recursive: true });

  const manifest = {
    version: 1,
    workflowMode: "image-json-deconstruction",
    runId,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prompt,
    promptFile: relativeForManifest(dirs.root, promptFile),
    outputDir: relativeForManifest(dirs.root, outputDir),
    maxAttempts: options.maxAttempts,
    maxParallel: Number.isFinite(options.maxParallel) ? options.maxParallel : "all",
    batchIntervalMs: options.batchIntervalMs,
    renameMap: renameMap.map((item) => ({
      index: item.index,
      originalName: item.originalName,
      renamedName: item.renamedName,
      mtimeMs: Math.round(item.mtimeMs),
    })),
    tasks: renameMap.map((item) => ({
      index: item.index,
      image: relativeForManifest(dirs.root, item.renamedFile),
      output: relativeForManifest(dirs.root, path.join(outputDir, `${item.index}.txt`)),
      status: "pending",
      attempts: 0,
      conversations: [],
      error: null,
      completedAt: null,
    })),
  };
  await saveManifest(dirs, manifest);
  console.log(`创建本轮输出目录：${outputDir}`);
  return manifest;
}

async function createGenerationManifest({ dirs, options }) {
  if (isTop4GenerationMode(options)) {
    return createTop4GenerationManifest({ dirs, options });
  }

  const jsonTextDir = await resolveJsonTextDir({ dirs, options });
  const jsonTasks = await listJsonTextTasks(jsonTextDir);
  if (jsonTasks.length === 0) {
    throw new Error(`没有在该目录找到可用 txt：${jsonTextDir}`);
  }
  const customerImages = await listImageFiles(dirs.customerDir);
  if (customerImages.length === 0) {
    throw new Error("“客户照片”文件夹里没有找到客户照片。请先放入参考客户照片。");
  }

  const runId = timestampId();
  const imageResultDir = path.join(dirs.imageResultRootDir, `run_${runId}`);
  await fs.mkdir(imageResultDir, { recursive: true });
  const manifest = {
    version: 1,
    workflowMode: "portrait-generation-from-json",
    runId,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jsonTextDir: relativeForManifest(dirs.root, jsonTextDir),
    customerDir: relativeForManifest(dirs.root, dirs.customerDir),
    customerImages: customerImages.map((file) => relativeForManifest(dirs.root, file)),
    imageResultDir: relativeForManifest(dirs.root, imageResultDir),
    suffix: options.generationSuffix,
    maxAttempts: options.maxAttempts,
    maxParallel: Number.isFinite(options.maxParallel) ? options.maxParallel : "all",
    batchIntervalMs: options.batchIntervalMs,
    batchIntervalRangeMs: options.batchIntervalRangeMs,
    generationTimeoutMs: options.generationTimeoutMs,
    generationTimeoutMin: options.generationTimeoutMin,
    maxGenerationRetries: options.maxGenerationRetries,
    maxDownloadRetries: options.maxDownloadRetries,
    downloadWaitSeconds: options.downloadWaitSeconds,
    generationRecoveryWaitMs: options.generationRecoveryWaitMs,
    tasks: jsonTasks.map((task) => ({
      index: task.index,
      jsonTextFile: relativeForManifest(dirs.root, task.file),
      status: "pending",
      attempts: 0,
      generation_attempts: 0,
      download_attempts: 0,
      generated_at: null,
      downloaded_at: null,
      last_error_type: null,
      last_error_message: null,
      conversations: [],
      error: null,
      submittedAt: null,
      completedAt: null,
      conversationUrl: null,
      status_history: [],
      recovery_attempts: 0,
      recovered_at: null,
      generatedImageSources: [],
      downloadedImages: [],
      downloadedImageCount: 0,
      downloadStatus: "pending",
      downloadError: null,
      downloadCompletedAt: null,
    })),
  };
  await saveGenerationManifest(dirs, manifest);
  console.log(`创建 JSON 生图提交记录：${manifest.runId}`);
  console.log(`JSON 来源目录：${jsonTextDir}`);
  console.log(`图片结果目录：${imageResultDir}`);
  console.log(`客户照片：${customerImages.length} 张`);
  return manifest;
}

async function createTop4GenerationManifest({ dirs, options }) {
  const input = await loadTop4GenerationInput({ dirs, options });
  const runId = timestampId();
  const generationManifestFile = path.join(input.imageResultDir, "generation_manifest.json");
  const manifest = {
    version: 1,
    workflowMode: "portrait-generation-from-json",
    inputMode: "top4",
    runId,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clientId: input.clientId,
    top4JsonPath: pathForManifest(dirs.root, input.top4JsonFile),
    clientPhotoDir: pathForManifest(dirs.root, input.clientPhotoDir),
    customerDir: pathForManifest(dirs.root, input.clientPhotoDir),
    customerImages: input.customerImages.map((file) => pathForManifest(dirs.root, file)),
    imageResultDir: pathForManifest(dirs.root, input.imageResultDir),
    generationManifestPath: pathForManifest(dirs.root, generationManifestFile),
    suffix: options.generationSuffix,
    maxAttempts: options.maxAttempts,
    maxParallel: Number.isFinite(options.maxParallel) ? options.maxParallel : "all",
    batchIntervalMs: options.batchIntervalMs,
    batchIntervalRangeMs: options.batchIntervalRangeMs,
    generationTimeoutMs: options.generationTimeoutMs,
    generationTimeoutMin: options.generationTimeoutMin,
    maxGenerationRetries: options.maxGenerationRetries,
    maxDownloadRetries: options.maxDownloadRetries,
    downloadWaitSeconds: options.downloadWaitSeconds,
    generationRecoveryWaitMs: options.generationRecoveryWaitMs,
    tasks: input.tasks,
  };
  const existing = await readExistingGenerationManifest(generationManifestFile);
  if (existing) {
    assertCompatibleGenerationManifestScope(manifest, existing, generationManifestFile);
    mergeExistingGenerationManifest(manifest, existing);
    await restoreCompletedTaskValidity({ dirs, manifest });
    console.log(`检测到已有 generation_manifest.json，按断点状态恢复：${generationManifestFile}`);
  }
  await fs.mkdir(input.imageResultDir, { recursive: true });
  await saveGenerationManifest(dirs, manifest);
  console.log(`${existing ? "恢复" : "创建"} Top4 生图提交记录：${manifest.runId}`);
  console.log(`client_id：${manifest.clientId}`);
  console.log(`generation_manifest：${generationManifestFile}`);
  console.log(`manifest 复用校验：${existing ? "通过，同一 client/top4/photo/output scope" : "false，新建 manifest"}`);
  console.log(`Top4 JSON：${input.top4JsonFile}`);
  console.log(`图片结果目录：${input.imageResultDir}`);
  console.log(`客户照片：${input.customerImages.length} 张`);
  console.log("生图任务映射：");
  for (const task of manifest.tasks) {
    console.log(`- rank=${task.rank} template_id=${task.templateId} source_txt_path=${task.sourceTxtPath}`);
  }
  return manifest;
}

async function readExistingGenerationManifest(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`读取已有 generation_manifest.json 失败：${error.message}`);
  }
}

function mergeExistingGenerationManifest(manifest, existing) {
  const existingTasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  let matchedExistingTask = false;
  for (const task of manifest.tasks) {
    const match = existingTasks.find((item) => sameGenerationTask(task, item));
    if (!match) continue;
    matchedExistingTask = true;
    task.status = match.status ?? task.status;
    task.generation_attempts = match.generation_attempts ?? match.generationAttempts ?? task.generation_attempts;
    task.download_attempts = match.download_attempts ?? match.downloadAttempts ?? task.download_attempts;
    task.generated_at = match.generated_at ?? match.generatedAt ?? task.generated_at;
    task.downloaded_at = match.downloaded_at ?? match.downloadedAt ?? task.downloaded_at;
    task.last_error_type = match.last_error_type ?? match.lastErrorType ?? task.last_error_type;
    task.last_error_message = match.last_error_message ?? match.lastErrorMessage ?? task.last_error_message;
    task.outputImagePath = match.output_image_path ?? match.outputImagePath ?? task.outputImagePath;
    task.output_image_path = task.outputImagePath;
    task.conversationUrl = match.conversation_url ?? match.conversationUrl ?? task.conversationUrl;
    task.status_history = Array.isArray(match.status_history) ? match.status_history : task.status_history ?? [];
    task.recovery_attempts = match.recovery_attempts ?? match.recoveryAttempts ?? task.recovery_attempts ?? 0;
    task.recovered_at = match.recovered_at ?? match.recoveredAt ?? task.recovered_at ?? null;
    task.generatedImageSources = Array.isArray(match.generated_image_sources)
      ? match.generated_image_sources
      : Array.isArray(match.generatedImageSources)
        ? match.generatedImageSources
        : task.generatedImageSources ?? [];
    task.downloadedImages = Array.isArray(match.downloaded_images)
      ? match.downloaded_images.map((image) => ({
          index: image.index,
          file: image.output_image_path ?? image.file ?? null,
          outputImagePath: image.output_image_path ?? image.file ?? null,
          status: image.status,
          bytes: image.bytes ?? 0,
          contentType: image.content_type ?? image.contentType ?? null,
          error: image.error ?? null,
        }))
      : task.downloadedImages ?? [];
    task.downloadedImageCount = task.downloadedImages.filter((image) => image.status === "downloaded").length;
    normalizeGenerationTaskState(task);
  }
  if (matchedExistingTask) {
    manifest.runId = existing.run_id || existing.runId || manifest.runId;
    manifest.status = existing.status || "resuming";
    manifest.createdAt = existing.created_at || existing.createdAt || manifest.createdAt;
  }
}

function assertCompatibleGenerationManifestScope(manifest, existing, file) {
  const checks = [
    ["client_id", manifest.clientId, existing.client_id ?? existing.clientId],
    ["top4_json_path", manifest.top4JsonPath, existing.top4_json_path ?? existing.top4JsonPath],
    ["client_photo_dir", manifest.clientPhotoDir, existing.client_photo_dir ?? existing.clientPhotoDir ?? existing.customerDir],
    ["output_dir", manifest.imageResultDir, existing.output_dir ?? existing.imageResultDir],
  ];
  const mismatches = checks.filter(([, left, right]) => {
    const leftValue = comparableManifestPath(left);
    const rightValue = comparableManifestPath(right);
    return leftValue && rightValue && leftValue !== rightValue;
  });
  if (mismatches.length > 0) {
    const detail = mismatches.map(([label, left, right]) => `${label}: new=${left || "(empty)"} existing=${right || "(empty)"}`).join("; ");
    throw new Error(
      `已有 generation_manifest.json 属于其他客户或其他输入，拒绝复用：${file}。${detail}。请为不同客户使用独立 output-dir。`,
    );
  }
}

function sameGenerationTask(left, right) {
  const leftSource = comparableManifestPath(left.sourceTxtPath ?? left.source_txt_path ?? left.jsonTextFile);
  const rightSource = comparableManifestPath(right.source_txt_path ?? right.sourceTxtPath ?? right.jsonTextFile);
  if (leftSource || rightSource) return Boolean(leftSource && rightSource && leftSource === rightSource);

  const leftTemplate = nonEmptyString(left.templateId ?? left.template_id);
  const rightTemplate = nonEmptyString(right.template_id ?? right.templateId);
  if (leftTemplate || rightTemplate) return Boolean(leftTemplate && rightTemplate && leftTemplate === rightTemplate);

  return false;
}

function comparableManifestPath(value) {
  return nonEmptyString(value).replaceAll("\\", "/").toLowerCase();
}

async function restoreCompletedTaskValidity({ dirs, manifest }) {
  for (const task of manifest.tasks) {
    normalizeGenerationTaskState(task);
    if (task.status !== "completed") continue;
    const output = task.outputImagePath ?? task.output_image_path;
    if (!output || !(await isValidImageFile(fromManifestPath(dirs.root, output)))) {
      task.status = task.generated_at || task.conversationUrl ? "download_failed" : "pending";
      task.downloadStatus = "failed";
      setGenerationTaskError(task, "downloaded_file_missing", `已完成任务的输出图片不存在或无效：${output || "空路径"}`);
    }
  }
}

async function loadCurrentGenerationManifestForResume({ dirs, options }) {
  if (isTop4GenerationMode(options)) {
    return createTop4GenerationManifest({ dirs, options });
  }

  const currentPath = path.join(dirs.recordsDir, "current-generation-run.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(currentPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("没有找到可补跑的 JSON 生图提交记录。请先运行 npm.cmd run generate-images。");
    throw new Error(`读取当前 JSON 生图提交记录失败：${error.message}`);
  }
  if (manifest.workflowMode !== "portrait-generation-from-json" || !Array.isArray(manifest.tasks)) {
    throw new Error("当前生成记录不是 JSON 生图提交任务，不能补跑。");
  }
  await ensureGenerationImageResultDir({ dirs, manifest });
  for (const file of manifest.customerImages ?? []) {
    await fs.access(fromManifestPath(dirs.root, file)).catch(() => {
      throw new Error(`补跑所需客户照片不存在：${file}`);
    });
  }
  for (const task of manifest.tasks) {
    await fs.access(fromManifestPath(dirs.root, task.jsonTextFile)).catch(() => {
      throw new Error(`补跑所需 txt 不存在：${task.jsonTextFile}`);
    });
    normalizeGenerationTaskState(task);
    if (task.status === "generating" || task.status === "downloading") {
      console.log(`${generationTaskLabel(task)}：上次中断在 ${task.status}，按断点状态恢复。`);
    }
    if (task.status === "generation_timeout" && !canRetryGeneration(task, options)) {
      task.status = "generation_failed";
      setGenerationTaskError(task, "generation_failed", "生成超时重试次数已用完。");
    }
  }
  manifest.status = "resuming";
  manifest.error = null;
  manifest.maxAttempts = options.maxAttempts;
  manifest.maxParallel = Number.isFinite(options.maxParallel) ? options.maxParallel : "all";
  manifest.batchIntervalMs = options.batchIntervalMs;
  manifest.batchIntervalRangeMs = options.batchIntervalRangeMs;
  manifest.generationTimeoutMs = options.generationTimeoutMs;
  manifest.generationTimeoutMin = options.generationTimeoutMin;
  manifest.maxGenerationRetries = options.maxGenerationRetries;
  manifest.maxDownloadRetries = options.maxDownloadRetries;
  manifest.downloadWaitSeconds = options.downloadWaitSeconds;
  manifest.generationRecoveryWaitMs = options.generationRecoveryWaitMs;
  if (!options.collectImagesOnly) {
    manifest.suffix = options.generationSuffix;
  }
  manifest.resumedAt = new Date().toISOString();
  await saveGenerationManifest(dirs, manifest);
  const pending = manifest.tasks.filter((task) => needsGenerationTaskWork(task, options));
  console.log(`继续处理 JSON 生图任务：只处理 ${pending.length} 个未完成项（包含缺失的图片下载）。`);
  return manifest;
}

async function resolveJsonTextDir({ dirs, options }) {
  if (options.jsonTextDir) {
    return path.resolve(dirs.root, options.jsonTextDir);
  }

  let entries;
  try {
    entries = await fs.readdir(dirs.outputRootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("没有找到“输出结果”文件夹。请先完成 JSON 解构。");
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(dirs.outputRootDir, entry.name);
    const tasks = await listJsonTextTasks(dir).catch(() => []);
    if (tasks.length === 0) continue;
    const stat = await fs.stat(dir);
    candidates.push({ dir, count: tasks.length, mtimeMs: stat.mtimeMs });
  }
  if (candidates.length === 0) {
    throw new Error("“输出结果”里没有找到包含 txt 的运行目录。");
  }

  candidates.sort((a, b) => b.count - a.count || b.mtimeMs - a.mtimeMs);
  return candidates[0].dir;
}

async function listJsonTextTasks(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".txt") continue;
    const stem = path.basename(entry.name, ".txt");
    if (!/^\d+$/.test(stem)) continue;
    const file = path.join(dir, entry.name);
    const text = (await fs.readFile(file, "utf8")).trim();
    if (!text) throw new Error(`txt 是空的：${file}`);
    try {
      JSON.parse(text);
    } catch (error) {
      throw new Error(`txt 不是合法 JSON：${file}（${error.message}）`);
    }
    tasks.push({ index: Number.parseInt(stem, 10), file, text });
  }
  tasks.sort((a, b) => a.index - b.index);
  return tasks;
}

function isTop4GenerationMode(options) {
  return Boolean(options.top4Json);
}

async function loadTop4GenerationInput({ dirs, options }) {
  const top4JsonFile = resolveRequiredWorkspacePath(dirs.root, options.top4Json, "--top4-json");
  const clientPhotoDir = resolveRequiredWorkspacePath(dirs.root, options.clientPhotoDir, "--client-photo-dir");
  const imageResultDir = resolveRequiredWorkspacePath(dirs.root, options.generationOutputDir, "--output-dir");

  const top4 = await readJsonFile(top4JsonFile, "Top4 JSON");
  if (!Array.isArray(top4.top4_templates)) {
    throw new Error(`Top4 JSON 缺少 top4_templates 数组：${top4JsonFile}`);
  }

  const customerImages = await listClientPhotoFiles(clientPhotoDir);
  if (customerImages.length === 0) {
    throw new Error(`客户照片目录里没有找到 png/jpg/jpeg/webp 图片：${clientPhotoDir}`);
  }

  const top4Items = top4.top4_templates
    .map((item, offset) => normalizeTop4Item({ dirs, item, offset }))
    .sort((a, b) => a.rank - b.rank);
  const ranks = top4Items.map((item) => item.rank);
  if (top4Items.length !== 4 || ranks.some((rank, index) => rank !== index + 1)) {
    throw new Error(`Top4 JSON 必须严格包含 rank 1 到 4；当前读取到：${ranks.join(", ") || "无"}`);
  }

  const tasks = [];
  for (const item of top4Items) {
    await readValidatedJsonTextFile(item.sourceTxtFile);
    const plannedOutput = path.join(
      imageResultDir,
      generatedImageFilenameForTask(
        { rank: item.rank, templateId: item.templateId, index: item.rank },
        1,
        ".png",
      ),
    );
    tasks.push({
      index: item.rank,
      rank: item.rank,
      templateId: item.templateId,
      template_id: item.templateId,
      sourceTxtPath: pathForManifest(dirs.root, item.sourceTxtFile),
      source_txt_path: pathForManifest(dirs.root, item.sourceTxtFile),
      jsonTextFile: pathForManifest(dirs.root, item.sourceTxtFile),
      outputImagePath: pathForManifest(dirs.root, plannedOutput),
      output_image_path: pathForManifest(dirs.root, plannedOutput),
      status: "pending",
      attempts: 0,
      generation_attempts: 0,
      download_attempts: 0,
      generated_at: null,
      downloaded_at: null,
      last_error_type: null,
      last_error_message: null,
      conversations: [],
      error: null,
      submittedAt: null,
      completedAt: null,
      conversationUrl: null,
      status_history: [],
      recovery_attempts: 0,
      recovered_at: null,
      generatedImageSources: [],
      downloadedImages: [],
      downloadedImageCount: 0,
      downloadStatus: "pending",
      downloadError: null,
      downloadCompletedAt: null,
    });
  }

  return {
    clientId: nonEmptyString(top4.client_id) || path.basename(clientPhotoDir),
    top4JsonFile,
    clientPhotoDir,
    imageResultDir,
    customerImages,
    tasks,
  };
}

function normalizeTop4Item({ dirs, item, offset }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Top4 第 ${offset + 1} 项不是对象`);
  }
  const rank = Number.parseInt(item.rank, 10);
  if (!Number.isInteger(rank)) {
    throw new Error(`Top4 第 ${offset + 1} 项缺少合法 rank`);
  }
  const templateId = nonEmptyString(item.template_id);
  if (!templateId) {
    throw new Error(`Top4 rank ${rank} 缺少 template_id`);
  }
  const sourceTxtPath = nonEmptyString(item.source_txt_path);
  if (!sourceTxtPath) {
    throw new Error(`Top4 rank ${rank} 缺少 source_txt_path`);
  }
  return {
    rank,
    templateId,
    sourceTxtFile: path.resolve(dirs.root, sourceTxtPath),
  };
}

async function readValidatedJsonTextFile(file) {
  let text;
  try {
    text = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Top4 source_txt_path 不存在：${file}`);
    throw error;
  }
  if (!text) throw new Error(`txt 是空的：${file}`);
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`txt 不是合法 JSON：${file}（${error.message}）`);
  }
  return text;
}

async function readJsonFile(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`没有找到${label}：${file}`);
    if (error instanceof SyntaxError) throw new Error(`${label} 不是合法 JSON：${file}（${error.message}）`);
    throw error;
  }
}

function resolveRequiredWorkspacePath(root, value, optionName) {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`Top4 模式需要提供 ${optionName}`);
  return path.resolve(root, normalized);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function listImageFiles(dir) {
  const entries = await listImageEntries(dir);
  return entries.map((entry) => entry.file);
}

async function listClientPhotoFiles(dir) {
  const entries = await listImageEntries(dir, CLIENT_PHOTO_EXTENSIONS);
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  return entries.map((entry) => entry.file);
}

async function printGenerationDryRunSummary({ dirs, options }) {
  if (isTop4GenerationMode(options)) {
    const input = await loadTop4GenerationInput({ dirs, options });
    console.log("Top4 生图预览模式：不会上传照片、不会连接 ChatGPT。");
    console.log(`输出目录：${input.imageResultDir}`);
    console.log(`并发数：${formatParallel(options.maxParallel)}`);
    console.log(`刷新恢复等待：${formatDuration(options.generationRecoveryWaitMs)}`);
    console.log(`客户照片列表：${input.customerImages.length} 张`);
    for (const file of input.customerImages) {
      console.log(`- ${path.basename(file)}`);
    }
    console.log("读取到的 4 个任务：");
    for (const task of input.tasks) {
      console.log(
        `rank=${task.rank} template_id=${task.templateId} source_txt_path=${fromManifestPath(
          dirs.root,
          task.sourceTxtPath,
        )}`,
      );
    }
    return;
  }

  const jsonTextDir = await resolveJsonTextDir({ dirs, options });
  const jsonTasks = await listJsonTextTasks(jsonTextDir);
  const customerImages = await listImageFiles(dirs.customerDir);
  console.log("JSON 生图预览模式：不会上传照片、不会连接 ChatGPT。");
  console.log(`JSON 来源目录：${jsonTextDir}`);
  console.log(`txt 数量：${jsonTasks.length}`);
  console.log(`客户照片：${customerImages.length} 张`);
  for (const file of customerImages) {
    console.log(`- ${path.basename(file)}`);
  }
  console.log(`图片结果：${path.join(dirs.imageResultRootDir, "run_<本轮时间戳>")}`);
  console.log(`每轮启动窗口：${formatParallel(options.maxParallel)}`);
  console.log(`每轮窗口启动间隔：${formatIntervalSetting({
    intervalMs: options.batchIntervalMs,
    intervalRangeMs: options.batchIntervalRangeMs,
  })}`);
  console.log(`刷新恢复等待：${formatDuration(options.generationRecoveryWaitMs)}`);
  console.log(`固定尾句：${options.generationSuffix}`);
  console.log("");
  console.log("计划发送顺序：");
  for (const task of jsonTasks) {
    console.log(`${String(task.index).padStart(2, " ")}. ${path.basename(task.file)}`);
  }
}

async function loadCurrentManifestForResume({ dirs, options }) {
  const currentPath = path.join(dirs.recordsDir, "current-run.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(currentPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("没有找到可补跑的运行记录。请先正常运行一次。");
    throw new Error(`读取当前运行记录失败：${error.message}`);
  }

  if (manifest.workflowMode !== "image-json-deconstruction" || !Array.isArray(manifest.tasks)) {
    throw new Error("当前运行记录不是人像例图 JSON 解构任务，不能补跑。");
  }

  const outputDir = fromManifestPath(dirs.root, manifest.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  for (const task of manifest.tasks) {
    if (task.status === "completed" && (await fileExists(fromManifestPath(dirs.root, task.output)))) continue;
    task.status = "pending";
    task.error = null;
    task.completedAt = null;
    await fs.access(fromManifestPath(dirs.root, task.image)).catch(() => {
      throw new Error(`补跑所需例图不存在：${task.image}`);
    });
  }
  manifest.status = "resuming";
  manifest.error = null;
  manifest.maxAttempts = options.maxAttempts;
  manifest.maxParallel = Number.isFinite(options.maxParallel) ? options.maxParallel : "all";
  manifest.batchIntervalMs = options.batchIntervalMs;
  manifest.resumedAt = new Date().toISOString();
  await saveManifest(dirs, manifest);
  const pending = manifest.tasks.filter((task) => task.status !== "completed");
  console.log(`继续补跑当前任务：只处理缺失的 ${pending.length} 张图片。`);
  return manifest;
}

async function saveManifest(dirs, manifest) {
  manifest.updatedAt = new Date().toISOString();
  const currentPath = path.join(dirs.recordsDir, "current-run.json");
  const runPath = path.join(dirs.recordsDir, `${manifest.runId}.json`);
  const snapshot = `${JSON.stringify(manifest, null, 2)}\n`;
  const saveTask = async () => {
    await writeTextAtomic(currentPath, snapshot);
    await writeTextAtomic(runPath, snapshot);
  };
  const queued = manifestSaveQueue.then(saveTask, saveTask);
  manifestSaveQueue = queued.catch(() => {});
  await queued;
}

async function saveExampleResumeManifest(dirs, manifest) {
  manifest.updatedAt = new Date().toISOString();
  const currentPath = path.join(dirs.recordsDir, "current-example-analysis-run.json");
  const runPath = path.join(dirs.recordsDir, `example-analysis_${manifest.runId}.json`);
  const outputDir = fromManifestPath(dirs.root, manifest.outputDir);
  const outputManifestPath = path.join(outputDir, "analysis_manifest.json");
  const snapshot = `${JSON.stringify(manifest, null, 2)}\n`;
  const saveTask = async () => {
    await writeTextAtomic(currentPath, snapshot);
    await writeTextAtomic(runPath, snapshot);
    await fs.mkdir(outputDir, { recursive: true });
    await writeTextAtomic(outputManifestPath, snapshot);
  };
  const queued = manifestSaveQueue.then(saveTask, saveTask);
  manifestSaveQueue = queued.catch(() => {});
  await queued;
}

async function saveGenerationManifest(dirs, manifest) {
  manifest.updatedAt = new Date().toISOString();
  const currentPath = path.join(dirs.recordsDir, "current-generation-run.json");
  const runPath = path.join(dirs.recordsDir, `generation_${manifest.runId}.json`);
  const snapshot = `${JSON.stringify(manifest, null, 2)}\n`;
  const saveTask = async () => {
    await writeTextAtomic(currentPath, snapshot);
    await writeTextAtomic(runPath, snapshot);
    if (manifest.generationManifestPath) {
      const externalPath = fromManifestPath(dirs.root, manifest.generationManifestPath);
      await fs.mkdir(path.dirname(externalPath), { recursive: true });
      await writeTextAtomic(externalPath, `${JSON.stringify(buildExternalGenerationManifest(manifest), null, 2)}\n`);
    }
  };
  const queued = manifestSaveQueue.then(saveTask, saveTask);
  manifestSaveQueue = queued.catch(() => {});
  await queued;
}

function buildExternalGenerationManifest(manifest) {
  return {
    run_id: manifest.runId ?? "",
    client_id: manifest.clientId ?? "",
    top4_json_path: manifest.top4JsonPath ?? "",
    client_photo_dir: manifest.clientPhotoDir ?? manifest.customerDir ?? "",
    output_dir: manifest.imageResultDir ?? "",
    status: manifest.status,
    created_at: manifest.createdAt ?? null,
    updated_at: manifest.updatedAt,
    generation_recovery_wait_ms: manifest.generationRecoveryWaitMs ?? null,
    tasks: (manifest.tasks ?? []).map((task) => ({
      rank: task.rank ?? task.index,
      template_id: task.templateId ?? task.template_id ?? "",
      source_txt_path: task.sourceTxtPath ?? task.source_txt_path ?? task.jsonTextFile ?? "",
      output_image_path: task.outputImagePath ?? task.output_image_path ?? "",
      status: task.status ?? "pending",
      attempts: task.attempts ?? 0,
      generation_attempts: task.generation_attempts ?? task.generationAttempts ?? 0,
      download_attempts: task.download_attempts ?? task.downloadAttempts ?? 0,
      generated_at: task.generated_at ?? task.generatedAt ?? null,
      downloaded_at: task.downloaded_at ?? task.downloadedAt ?? null,
      recovered_at: task.recovered_at ?? task.recoveredAt ?? null,
      recovery_attempts: task.recovery_attempts ?? task.recoveryAttempts ?? 0,
      download_status: task.downloadStatus ?? null,
      last_error_type: task.last_error_type ?? task.lastErrorType ?? null,
      last_error_message: task.last_error_message ?? task.lastErrorMessage ?? task.error ?? null,
      conversation_url: task.conversationUrl ?? null,
      status_history: task.status_history ?? [],
      generated_image_sources: task.generatedImageSources ?? [],
      downloaded_images: (task.downloadedImages ?? []).map((image) => ({
        index: image.index,
        output_image_path: image.file ?? image.outputImagePath ?? null,
        status: image.status,
        bytes: image.bytes ?? 0,
        content_type: image.contentType ?? null,
        width: image.width ?? null,
        height: image.height ?? null,
        error: image.error ?? null,
        error_type: image.errorType ?? null,
      })),
    })),
  };
}

async function writeTextAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, value, "utf8");
  await fs.rename(temp, file);
}

function relativeForManifest(root, file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function pathForManifest(root, file) {
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return relative || ".";
  return absolute;
}

function fromManifestPath(root, file) {
  return path.resolve(root, file);
}

async function ensureGenerationImageResultDir({ dirs, manifest }) {
  if (!manifest.imageResultDir) {
    manifest.imageResultDir = relativeForManifest(dirs.root, path.join(dirs.imageResultRootDir, `run_${manifest.runId}`));
  }
  const imageResultDir = fromManifestPath(dirs.root, manifest.imageResultDir);
  await fs.mkdir(imageResultDir, { recursive: true });
  return imageResultDir;
}

function normalizeGenerationTaskState(task) {
  if (task.status === "running") task.status = "pending";
  if (task.status === "failed") {
    task.status = task.downloadStatus === "failed" || task.downloadStatus === "partial_failed" ? "download_failed" : "generation_failed";
  }
  task.generation_attempts ??= task.generationAttempts ?? task.attempts ?? 0;
  task.download_attempts ??= task.downloadAttempts ?? 0;
  task.generated_at ??= task.generatedAt ?? null;
  task.downloaded_at ??= task.downloadedAt ?? task.downloadCompletedAt ?? null;
  task.last_error_type ??= task.lastErrorType ?? null;
  task.last_error_message ??= task.lastErrorMessage ?? task.error ?? null;
  task.conversations ??= [];
  task.status_history = Array.isArray(task.status_history) ? task.status_history : [];
  task.recovery_attempts ??= task.recoveryAttempts ?? 0;
  task.recovered_at ??= task.recoveredAt ?? null;
  task.generatedImageSources ??= [];
  task.downloadedImages ??= [];
  task.downloadedImageCount ??= task.downloadedImages.length;
  task.downloadStatus ??= task.downloaded_at ? "completed" : "pending";
  task.downloadError ??= null;
}

function markGenerationTaskStatus(task, status, details = {}) {
  task.status = status;
  task.status_history = Array.isArray(task.status_history) ? task.status_history : [];
  task.status_history.push({
    status,
    at: new Date().toISOString(),
    ...details,
  });
}

function needsGenerationTaskWork(task, options = {}) {
  normalizeGenerationTaskState(task);
  if (task.status !== "completed") {
    if (task.status === "generation_failed" && !canRetryGeneration(task, options)) return false;
    return true;
  }
  return !isGenerationDownloadDone(task);
}

function isGenerationDownloadDone(task) {
  if (task.status === "completed") return true;
  if (task.downloadStatus === "no_images") return true;
  if (task.downloadStatus !== "completed") return false;
  return (task.downloadedImageCount || 0) > 0 || (task.downloadedImages?.length || 0) > 0;
}

function shouldDownloadOnly(task) {
  normalizeGenerationTaskState(task);
  return GENERATION_DOWNLOAD_ONLY_STATUSES.has(task.status);
}

function shouldRecoverBeforeGenerationRetry(task) {
  normalizeGenerationTaskState(task);
  return Boolean(task.conversationUrl) && ["submitted", "generation_timeout"].includes(task.status);
}

function canRetryGeneration(task, options) {
  normalizeGenerationTaskState(task);
  return (task.generation_attempts || 0) < maxGenerationRuns(options);
}

function maxGenerationRuns(options = {}) {
  return Math.max(1, (options.maxGenerationRetries ?? DEFAULT_MAX_GENERATION_RETRIES) + 1);
}

function generationTaskLabel(task) {
  const rank = task.rank ?? task.index;
  return `rank_${String(rank).padStart(2, "0")}`;
}

function setGenerationTaskError(task, type, message) {
  task.last_error_type = type;
  task.last_error_message = message;
  task.error = message;
}

function clearGenerationTaskError(task) {
  task.last_error_type = null;
  task.last_error_message = null;
  task.error = null;
}

async function runGenerationWorkflow({ dirs, options, manifest }) {
  const browserSession = await openBrowserSession({ dirs, options });
  const { context } = browserSession;
  let page = browserSession.page;
  const runState = {
    aborted: false,
    abortError: null,
  };

  try {
    if (options.cleanupExistingTabs) {
      page = await closeStaleChatGptPages(context, page);
    }
    await page.bringToFront().catch(() => {});
    await waitForComposer(page, options.loginTimeoutMs);
    await ensureGenerationImageResultDir({ dirs, manifest });
    for (const task of manifest.tasks) normalizeGenerationTaskState(task);
    const runnableTasks = manifest.tasks.filter((task) => needsGenerationTaskWork(task, options));
    if (runnableTasks.length === 0) {
      manifest.status = "completed";
      await saveGenerationManifest(dirs, manifest);
      console.log("当前 JSON 生图提交记录已经完整，不需要补跑。");
      return [];
    }

    manifest.status = "running";
    await saveGenerationManifest(dirs, manifest);
    console.log(
      `开始提交 ${runnableTasks.length} 个 JSON：每轮启动 ${formatParallel(options.maxParallel)} 个窗口，每轮窗口启动间隔为 ${formatIntervalSetting({
        intervalMs: options.batchIntervalMs,
        intervalRangeMs: options.batchIntervalRangeMs,
      })}。`,
    );
    console.log(
      `生成超时：${formatDuration(options.generationTimeoutMs)}；生成重试：最多 ${options.maxGenerationRetries} 次；下载重试：最多 ${options.maxDownloadRetries} 次。`,
    );

    await runInLaunchBatches({
      items: runnableTasks,
      batchSize: options.maxParallel,
      intervalMs: options.batchIntervalMs,
      intervalRangeMs: options.batchIntervalRangeMs,
      runState,
      worker: async (task) => {
        if (shouldDownloadOnly(task)) {
          await collectGenerationTaskImages({ context, dirs, options, manifest, task, runState });
        } else {
          await processGenerationTask({ context, dirs, options, manifest, task, runState });
        }
      },
    });
    if (runState.abortError) throw runState.abortError;

    const failedTasks = manifest.tasks.filter((task) => GENERATION_FINAL_FAILURE_STATUSES.has(task.status));
    const downloadFailedTasks = manifest.tasks.filter((task) => task.status === "download_failed");
    const generationFailedTasks = manifest.tasks.filter((task) => task.status === "generation_failed");
    manifest.status =
      generationFailedTasks.length > 0 ? "generation_partial_failed" : downloadFailedTasks.length > 0 ? "download_partial_failed" : "completed";
    await saveGenerationManifest(dirs, manifest);

    if (failedTasks.length === 0) {
      if (downloadFailedTasks.length === 0) {
        const imageCount = manifest.tasks.reduce((sum, task) => sum + (task.downloadedImageCount || 0), 0);
        console.log(`全部提交完成：${manifest.tasks.length} 个 JSON 已发送给 ChatGPT，已下载 ${imageCount} 张生成图。`);
      } else {
        console.log(`提交完成，但有 ${downloadFailedTasks.length} 个序号的图片下载不完整。稍后可运行 npm.cmd run generate:resume 补下载。`);
      }
    } else {
      console.log(
        `提交结束，但仍有 ${failedTasks.length} 个序号失败：生成失败 ${generationFailedTasks.length} 个，下载失败 ${downloadFailedTasks.length} 个。成功对话链接已经保留在运行记录。`,
      );
    }
    return failedTasks;
  } catch (error) {
    for (const task of manifest.tasks) {
      if (task.status === "generating") task.status = "generation_timeout";
      if (task.status === "downloading") task.status = "download_failed";
    }
    manifest.status = isGlobalRateLimitError(error) ? "rate_limited" : "failed";
    manifest.error = error.message;
    await saveGenerationManifest(dirs, manifest).catch(() => {});
    await takeScreenshot(page, dirs, "generation-workflow-failed").catch(() => {});
    if (isGlobalRateLimitError(error)) {
      console.log("检测到 ChatGPT 请求频率限制，已暂停 JSON 生图提交。请等待几分钟后运行 npm.cmd run generate:resume。");
    }
    throw error;
  } finally {
    await browserSession.close();
  }
}

async function runGenerationImageCollectionWorkflow({ dirs, options, manifest }) {
  const browserSession = await openBrowserSession({ dirs, options });
  const { context } = browserSession;
  const runState = {
    aborted: false,
    abortError: null,
  };

  try {
    await ensureGenerationImageResultDir({ dirs, manifest });
    const collectableTasks = manifest.tasks.filter(
      (task) => shouldDownloadOnly(task) || (task.status === "completed" && task.conversationUrl && !isGenerationDownloadDone(task)),
    );
    if (collectableTasks.length === 0) {
      console.log("当前没有可补下载的已完成对话。");
      return [];
    }

    manifest.status = "collecting_images";
    await saveGenerationManifest(dirs, manifest);
    console.log(
      `开始补下载 ${collectableTasks.length} 个已完成对话：每轮启动 ${formatParallel(options.maxParallel)} 个窗口，每轮窗口启动间隔为 ${formatIntervalSetting({
        intervalMs: options.batchIntervalMs,
        intervalRangeMs: options.batchIntervalRangeMs,
      })}。`,
    );

    await runInLaunchBatches({
      items: collectableTasks,
      batchSize: options.maxParallel,
      intervalMs: options.batchIntervalMs,
      intervalRangeMs: options.batchIntervalRangeMs,
      runState,
      worker: async (task) => {
        await collectGenerationTaskImages({ context, dirs, options, manifest, task, runState });
      },
    });
    if (runState.abortError) throw runState.abortError;

    const failedTasks = collectableTasks.filter((task) => task.status === "download_failed");
    manifest.status = failedTasks.length === 0 ? "image_collection_completed" : "image_collection_partial_failed";
    await saveGenerationManifest(dirs, manifest);
    const imageCount = collectableTasks.reduce((sum, task) => sum + (task.downloadedImageCount || 0), 0);
    console.log(`补下载结束：本次保存 ${imageCount} 张生成图。`);
    return failedTasks;
  } catch (error) {
    manifest.status = isGlobalRateLimitError(error) ? "rate_limited" : "image_collection_failed";
    manifest.error = error.message;
    await saveGenerationManifest(dirs, manifest).catch(() => {});
    if (isGlobalRateLimitError(error)) {
      console.log("检测到 ChatGPT 请求频率限制，已暂停图片补下载。请等待几分钟后重新运行 npm.cmd run generate:collect。");
    }
    throw error;
  } finally {
    await browserSession.close();
  }
}

async function processGenerationTask({ context, dirs, options, manifest, task, runState }) {
  const label = generationTaskLabel(task);
  const textFile = fromManifestPath(dirs.root, task.jsonTextFile);
  const customerImages = manifest.customerImages.map((file) => fromManifestPath(dirs.root, file));
  const outputPrompt = await buildGenerationPrompt(textFile, manifest.suffix);
  normalizeGenerationTaskState(task);

  if (runState.aborted) return;
  if (shouldDownloadOnly(task)) {
    await collectGenerationTaskImages({ context, dirs, options, manifest, task, runState });
    return;
  }
  if (shouldRecoverBeforeGenerationRetry(task)) {
    const recovered = await recoverGenerationTaskFromConversation({ context, dirs, options, manifest, task, runState, label });
    if (recovered) return;
  }
  clearGenerationTaskError(task);
  await saveGenerationManifest(dirs, manifest);

  while (canRetryGeneration(task, options)) {
    if ((task.generation_attempts || 0) > 0) {
      const waitMs = nextIntervalMs({
        intervalMs: options.batchIntervalMs,
        intervalRangeMs: options.batchIntervalRangeMs,
      });
      console.log(`${label}：只重试当前 rank，等待 ${formatDuration(waitMs)} 后重新生成。`);
      await delay(waitMs);
    }
    if (runState.aborted) {
      task.status = "pending";
      await saveGenerationManifest(dirs, manifest);
      return;
    }

    const page = await context.newPage();
    const generationAttempt = (task.generation_attempts || 0) + 1;
    const conversation = {
      attempt: generationAttempt,
      url: null,
      startedAt: new Date().toISOString(),
      submittedAt: null,
      generatedAt: null,
      completedAt: null,
      error: null,
    };
    markGenerationTaskStatus(task, "generating", { attempt: generationAttempt });
    task.generation_attempts = generationAttempt;
    task.attempts = generationAttempt;
    task.downloadStatus = "pending";
    task.downloadError = null;
    task.conversations.push(conversation);
    clearGenerationTaskError(task);
    await saveGenerationManifest(dirs, manifest);

    try {
      console.log(`${label}：生成阶段，第 ${generationAttempt}/${maxGenerationRuns(options)} 次提交。`);
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      throwIfRunAborted(runState);
      await waitForComposer(page, options.loginTimeoutMs);
      throwIfRunAborted(runState);
      await waitForResponseComplete(page, 2 * 60 * 1000).catch(() => {});

      const uploadBaseline = new Set(await collectLargeImageSources(page));
      await uploadFiles(page, customerImages, {
        baseline: uploadBaseline,
        expectedCount: customerImages.length,
      });
      const uploadSources = new Set(await collectLargeImageSources(page));
      throwIfRunAborted(runState);
      await sendMessage(page, outputPrompt);
      const preGenerationSources = new Set(await collectLargeImageSources(page));
      const generationTimerStartedAt = Date.now();

      conversation.url = await waitForConversationUrl(page, 30_000);
      conversation.submittedAt = new Date().toISOString();
      task.submittedAt = conversation.submittedAt;
      task.conversationUrl = conversation.url;
      markGenerationTaskStatus(task, "submitted", { attempt: generationAttempt, conversationUrl: conversation.url });
      await saveGenerationManifest(dirs, manifest);
      console.log(`${label}：生图请求已提交，从 ${conversation.submittedAt} 开始计算 ${formatDuration(options.generationTimeoutMs)} 生成超时。`);

      let generatedSources = [];
      try {
        generatedSources = await waitForStableGeneratedImageSources({
          page,
          excludedSources: new Set([...uploadSources, ...preGenerationSources]),
          timeoutMs: options.generationTimeoutMs,
          label,
          startedAt: generationTimerStartedAt,
        });
      } catch (error) {
        if (error.code !== "generation_timeout") throw error;
        markGenerationTaskStatus(task, "generation_timeout", { attempt: generationAttempt });
        setGenerationTaskError(task, "generation_timeout", error.message);
        await saveGenerationManifest(dirs, manifest);
        const recovered = await recoverGenerationTaskOnPage({
          page,
          dirs,
          options,
          manifest,
          task,
          runState,
          label,
          excludedSources: new Set([...uploadSources, ...preGenerationSources]),
          conversation,
        });
        if (recovered) {
          conversation.completedAt = task.downloaded_at ?? new Date().toISOString();
          await takeScreenshot(page, dirs, `${label}-${task.status}`).catch(() => {});
          await saveGenerationManifest(dirs, manifest);
          return;
        }
        throw error;
      }
      const generatedAt = new Date().toISOString();
      conversation.generatedAt = generatedAt;
      markGenerationTaskStatus(task, "generated_seen", { attempt: generationAttempt, imageCount: generatedSources.length });
      task.generated_at = generatedAt;
      task.generatedImageSources = generatedSources;
      clearGenerationTaskError(task);
      console.log(`${label}：检测到 ${generatedSources.length} 张稳定生成图，时间：${generatedAt}。状态已写入 generated。`);
      await saveGenerationManifest(dirs, manifest);
      await runGenerationDownloadStage({
        page,
        dirs,
        options,
        manifest,
        task,
        runState,
        sources: generatedSources,
        label,
      });
      conversation.completedAt = task.downloaded_at ?? new Date().toISOString();
      await takeScreenshot(page, dirs, `${label}-${task.status}`).catch(() => {});
      await saveGenerationManifest(dirs, manifest);
      if (task.status === "completed") {
        console.log(`${label}：生成和下载均完成，已保存 ${task.downloadedImageCount} 张图，对话链接：${conversation.url}`);
      } else {
        console.log(`${label}：生成已完成，但下载阶段失败；下次只会重试下载，不会重新提交生图。`);
      }
      return;
    } catch (error) {
      const blockingError = await detectBlockingError(page);
      if (blockingError) error = blockingError;
      conversation.url = conversation.url || page.url();
      conversation.error = error.message;
      if (isGlobalRateLimitError(error)) {
        runState.aborted = true;
        runState.abortError = error;
        task.status = "pending";
        await saveGenerationManifest(dirs, manifest);
        console.log(`${label}：检测到 ChatGPT 请求频率限制，暂停当前批次。`);
        return;
      }
      const timeoutLike = error.code === "generation_timeout";
      task.status = timeoutLike ? "generation_timeout" : "generation_failed";
      setGenerationTaskError(
        task,
        timeoutLike ? "generation_timeout" : "generation_failed",
        error.message,
      );
      await takeScreenshot(page, dirs, `${label}-generation_attempt_${generationAttempt}-failed`).catch(() => {});
      await saveGenerationManifest(dirs, manifest);
      console.log(
        `${label}：生成阶段第 ${generationAttempt}/${maxGenerationRuns(options)} 次失败，类型 ${task.last_error_type}：${error.message}`,
      );
    }
  }

  task.status = "generation_failed";
  setGenerationTaskError(task, "generation_failed", "生成重试次数已用完。");
  await saveGenerationManifest(dirs, manifest);
  console.log(`${label}：生成重试次数已用完，标记为 generation_failed，只影响当前 rank。`);
}

async function buildGenerationPrompt(textFile, suffix) {
  const jsonText = (await fs.readFile(textFile, "utf8")).trim();
  JSON.parse(jsonText);
  return `${jsonText}\n\n${suffix}`;
}

async function recoverGenerationTaskFromConversation({ context, dirs, options, manifest, task, runState, label }) {
  if (!task.conversationUrl || runState.aborted) return false;
  const page = await context.newPage();
  try {
    await page.goto(task.conversationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return await recoverGenerationTaskOnPage({
      page,
      dirs,
      options,
      manifest,
      task,
      runState,
      label,
      excludedSources: new Set(),
      conversation: null,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function recoverGenerationTaskOnPage({
  page,
  dirs,
  options,
  manifest,
  task,
  runState,
  label,
  excludedSources,
  conversation,
}) {
  if (runState.aborted) return false;
  task.recovery_attempts = (task.recovery_attempts || 0) + 1;
  await saveGenerationManifest(dirs, manifest);

  let sources = [];
  try {
    sources = await findGeneratedSourcesAfterRefresh({ page, options, label, excludedSources });
  } catch (error) {
    if (isGlobalRateLimitError(error)) throw error;
    setGenerationTaskError(task, error.code || "generation_recovery_failed", error.message);
    await saveGenerationManifest(dirs, manifest);
    return false;
  }

  if (sources.length === 0) {
    setGenerationTaskError(task, "generation_timeout", "No generated images found after refresh recovery.");
    await saveGenerationManifest(dirs, manifest);
    return false;
  }

  const recoveredAt = new Date().toISOString();
  task.generated_at ??= recoveredAt;
  task.recovered_at = recoveredAt;
  task.generatedImageSources = sources;
  if (conversation) {
    conversation.generatedAt ??= recoveredAt;
    conversation.refreshRecoveredAt = recoveredAt;
  }
  markGenerationTaskStatus(task, "refresh_recovered", {
    recoveryAttempt: task.recovery_attempts,
    imageCount: sources.length,
  });
  clearGenerationTaskError(task);
  await saveGenerationManifest(dirs, manifest);

  await runGenerationDownloadStage({ page, dirs, options, manifest, task, runState, sources, label });
  return true;
}

async function findGeneratedSourcesAfterRefresh({ page, options, label, excludedSources }) {
  const recoveryWaitMs = Math.min(
    120_000,
    Math.max(60_000, options.generationRecoveryWaitMs || DEFAULT_GENERATION_RECOVERY_WAIT_MS),
  );
  const url = page.url();
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (error) {
    if (!url || url === "about:blank") throw error;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await waitForResponseComplete(page, recoveryWaitMs).catch(() => {});
  try {
    return await waitForStableGeneratedImageSources({
      page,
      excludedSources,
      timeoutMs: recoveryWaitMs,
      label: `${label} refresh_recovery`,
      startedAt: Date.now(),
    });
  } catch (error) {
    if (error.code === "generation_timeout") return [];
    throw error;
  }
}

async function collectGenerationTaskImages({ context, dirs, options, manifest, task, runState }) {
  const label = generationTaskLabel(task);
  normalizeGenerationTaskState(task);
  if (runState.aborted) return;
  if (!task.conversationUrl) {
    task.status = "download_failed";
    task.downloadStatus = "failed";
    task.downloaded_at = null;
    setGenerationTaskError(task, "download_button_not_found", "没有可打开的对话链接，无法补下载图片。");
    await saveGenerationManifest(dirs, manifest);
    console.log(`${label}：没有对话链接，跳过图片补下载。`);
    return;
  }

  const page = await context.newPage();

  try {
    console.log(`${label}：下载阶段，打开已有对话，只重试下载，不重新生成。`);
    await page.goto(task.conversationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    throwIfRunAborted(runState);
    await waitForResponseComplete(page, 2 * 60 * 1000).catch(() => {});
    const sources = await waitForStableGeneratedImageSources({
      page,
      excludedSources: new Set(),
      timeoutMs: Math.max(30_000, options.downloadWaitSeconds * 1000),
      label,
      startedAt: Date.now(),
    });
    if (!task.generated_at) {
      task.generated_at = new Date().toISOString();
      markGenerationTaskStatus(task, "generated_seen", { imageCount: sources.length });
    }
    task.generatedImageSources = sources;
    await runGenerationDownloadStage({ page, dirs, options, manifest, task, runState, sources, label });
    console.log(`${label}：下载阶段结束，状态：${task.status}，保存 ${task.downloadedImageCount} 张生成图。`);
  } catch (error) {
    const blockingError = await detectBlockingError(page);
    const actualError = blockingError || error;
    if (isGlobalRateLimitError(actualError)) {
      runState.aborted = true;
      runState.abortError = actualError;
      task.status = "download_failed";
      task.downloadStatus = "pending";
      setGenerationTaskError(task, "download_event_timeout", actualError.message);
      await saveGenerationManifest(dirs, manifest);
      console.log(`${label}：检测到 ChatGPT 请求频率限制，暂停图片补下载。`);
      return;
    }
    task.downloadStatus = "failed";
    task.status = "download_failed";
    setGenerationTaskError(task, actualError.code || "download_event_timeout", actualError.message);
    await saveGenerationManifest(dirs, manifest);
    console.log(`${label}：图片补下载失败，状态保持为 download_failed：${actualError.message}`);
  }
}

async function runGenerationDownloadStage({ page, dirs, options, manifest, task, runState, sources, label }) {
  if (runState.aborted) return;
  task.status = "downloading";
  task.downloadStatus = "running";
  task.downloadError = null;
  await saveGenerationManifest(dirs, manifest);

  let lastRecords = [];
  const maxAttempts = options.maxDownloadRetries;
  for (let attempt = (task.download_attempts || 0) + 1; attempt <= maxAttempts; attempt += 1) {
    if (runState.aborted) return;
    if (attempt > 1 && options.downloadWaitSeconds > 0) {
      console.log(`${label}：下载阶段第 ${attempt}/${maxAttempts} 次重试前等待 ${options.downloadWaitSeconds} 秒。`);
      await delay(options.downloadWaitSeconds * 1000);
    }
    task.status = "downloading";
    task.downloadStatus = "running";
    task.download_attempts = attempt;
    await saveGenerationManifest(dirs, manifest);
    console.log(`${label}：下载阶段，第 ${attempt}/${maxAttempts} 次尝试。`);

    const actualSources =
      sources?.length > 0
        ? sources
        : await waitForStableGeneratedImageSources({
            page,
            excludedSources: new Set(),
            timeoutMs: Math.max(30_000, options.downloadWaitSeconds * 1000),
            label,
            startedAt: Date.now(),
          });

    lastRecords = await downloadGeneratedImages({
      page,
      dirs,
      manifest,
      task,
      sources: actualSources,
      downloadWaitMs: options.downloadWaitSeconds * 1000,
    });
    const completedAt = new Date().toISOString();
    applyDownloadedImagesToTask(task, lastRecords, completedAt);
    await saveGenerationManifest(dirs, manifest);
    if (task.status === "completed") {
      console.log(`${label}：文件验证通过，下载阶段完成。`);
      return;
    }
    console.log(
      `${label}：下载阶段第 ${attempt}/${maxAttempts} 次失败，错误类型 ${task.last_error_type}：${task.last_error_message}`,
    );
  }

  task.status = "download_failed";
  task.downloadStatus = "failed";
  task.downloadError = task.last_error_message || "下载重试次数已用完。";
  setGenerationTaskError(task, firstFailedDownloadErrorType(lastRecords), task.downloadError);
  await saveGenerationManifest(dirs, manifest);
  console.log(`${label}：下载重试次数已用完，标记为 download_failed；后续只会重试下载。`);
}

function applyDownloadedImagesToTask(task, downloadedImages, completedAt) {
  const downloadedCount = downloadedImages.filter((image) => image.status === "downloaded").length;
  const failedCount = downloadedImages.filter((image) => image.status === "failed").length;
  const firstDownloaded = downloadedImages.find((image) => image.status === "downloaded" && image.file);
  task.downloadedImages = downloadedImages;
  task.downloadedImageCount = downloadedCount;
  task.downloadStatus = downloadedImages.length === 0 ? "no_images" : failedCount > 0 ? "partial_failed" : "completed";
  task.downloadError = failedCount > 0 ? `${failedCount} 张生成图下载失败` : null;
  task.downloadCompletedAt = completedAt;
  task.downloaded_at = downloadedCount > 0 && failedCount === 0 ? completedAt : task.downloaded_at ?? null;
  if (firstDownloaded) {
    task.outputImagePath = firstDownloaded.file;
    task.output_image_path = firstDownloaded.file;
  }
  if (downloadedCount > 0 && failedCount === 0) {
    task.status = "completed";
    task.completedAt = completedAt;
    clearGenerationTaskError(task);
  } else {
    task.status = "download_failed";
    setGenerationTaskError(
      task,
      downloadedImages.length === 0 ? "download_button_not_found" : firstFailedDownloadErrorType(downloadedImages),
      task.downloadError || "没有成功下载生成图片。",
    );
  }
}

function firstFailedDownloadErrorType(downloadedImages) {
  return downloadedImages.find((image) => image.status === "failed")?.errorType || "download_event_timeout";
}

async function downloadGeneratedImages({ page, dirs, manifest, task, excludedSources, sources = null, downloadWaitMs = 20_000 }) {
  const imageResultDir = await ensureGenerationImageResultDir({ dirs, manifest });
  const actualSources =
    sources ??
    (await waitForStableGeneratedImageSources({
      page,
      excludedSources,
      timeoutMs: 30_000,
      label: generationTaskLabel(task),
      startedAt: Date.now(),
    }));
  const records = [];

  for (let index = 0; index < actualSources.length; index += 1) {
    const source = actualSources[index];
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
    const recordBase = {
      index: index + 1,
      rank: task.rank ?? task.index,
      templateId: task.templateId ?? task.template_id ?? null,
      sourceTxtPath: task.sourceTxtPath ?? task.source_txt_path ?? task.jsonTextFile ?? null,
      outputImagePath: null,
      sourceKind: classifyImageSource(source),
      sourceHash,
      status: "pending",
      file: null,
      method: null,
      downloadButtonFound: false,
      downloadEventTriggered: false,
      bytes: 0,
      contentType: null,
      width: null,
      height: null,
      error: null,
      errorType: null,
    };

    try {
      const extension = extensionForImage({ contentType: null, source });
      const file = path.join(imageResultDir, generatedImageFilenameForTask(task, index + 1, extension));
      const manifestFile = relativeForManifest(dirs.root, file);
      const result = await downloadImageWithFallback({ page, source, file, downloadWaitMs });
      records.push({
        ...recordBase,
        status: "downloaded",
        file: manifestFile,
        outputImagePath: manifestFile,
        method: result.method,
        downloadButtonFound: result.downloadButtonFound,
        downloadEventTriggered: result.downloadEventTriggered,
        bytes: result.bytes,
        contentType: result.contentType,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      records.push({
        ...recordBase,
        status: "failed",
        errorType: error.code || "download_event_timeout",
        error: error.message,
      });
    }
  }

  return records;
}

async function waitForGeneratedImageSources(page, excludedSources, timeoutMs) {
  return waitForStableGeneratedImageSources({
    page,
    excludedSources,
    timeoutMs,
    label: "generation",
    startedAt: Date.now(),
  });
}

async function waitForStableGeneratedImageSources({ page, excludedSources, timeoutMs, label, startedAt }) {
  const deadline = Date.now() + timeoutMs;
  let previousKey = "";
  let previousSources = [];
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    await checkForBlockingMessages(page);
    const sources = await collectGeneratedImageSources(page, excludedSources);
    const key = sources.join("\n");
    const elapsedMs = Date.now() - startedAt;
    if (Date.now() - lastLogAt >= 30_000) {
      console.log(`${label}：生成检测已等待 ${formatDuration(elapsedMs)}，当前发现 ${sources.length} 张候选图。`);
      lastLogAt = Date.now();
    }
    if (sources.length > 0 && key === previousKey && key !== "") {
      return sources;
    }
    previousKey = key;
    previousSources = sources;
    await page.waitForTimeout(3000);
  }
  await checkForBlockingMessages(page);
  const finalSources = await collectGeneratedImageSources(page, excludedSources);
  const finalKey = finalSources.join("\n");
  if (finalSources.length > 0 && (finalKey === previousKey || finalKey === previousSources.join("\n"))) {
    return finalSources;
  }
  throw workflowError(
    "generation_timeout",
    `${label}：${formatDuration(timeoutMs)} 内没有检测到稳定生成图片，最后一次检查发现 ${finalSources.length} 张候选图。`,
  );
}

async function collectGeneratedImageSources(page, excludedSources) {
  const excluded = Array.from(excludedSources ?? []);
  const sources = await page.evaluate((excludedList) => {
    const excludedSet = new Set(excludedList);
    const scrollY = typeof window === "undefined" ? 0 : window.scrollY || 0;
    const topOf = (element) => {
      const rect = element?.getBoundingClientRect?.();
      return (rect?.top ?? 0) + scrollY;
    };
    const isLargeEnough = (image, rect) => {
      const width = image.naturalWidth || rect.width;
      const height = image.naturalHeight || rect.height;
      return width >= 180 && height >= 180;
    };
    const readRole = (image) =>
      image.closest("[data-message-author-role]")?.getAttribute("data-message-author-role") || "";
    const userTurns = Array.from(document.querySelectorAll?.('[data-message-author-role="user"]') ?? []);
    const lastUserTop = userTurns.length > 0 ? Math.max(...userTurns.map(topOf)) : Number.NEGATIVE_INFINITY;
    const isInComposer = (image) =>
      Boolean(
        image.closest(
          "form, [data-testid='composer'], [data-testid='prompt-textarea'], #prompt-textarea, div.ProseMirror",
        ),
      );

    const assistantTurns = Array.from(document.querySelectorAll?.('[data-message-author-role="assistant"]') ?? [])
      .map((element) => ({ element, top: topOf(element) }))
      .filter((item) => item.top >= lastUserTop)
      .sort((a, b) => b.top - a.top);
    const latestAssistant = assistantTurns[0]?.element || null;
    const imageRoot = latestAssistant || document;

    const rootImages = Array.from(imageRoot.querySelectorAll?.("img") ?? []);
    const rawImages = rootImages.length > 0 ? rootImages : Array.from(document.images);
    const candidates = rawImages
      .map((image) => {
        const rect = image.getBoundingClientRect();
        return {
          src: image.currentSrc || image.src,
          alt: image.alt || "",
          role: readRole(image),
          top: topOf(image),
          inComposer: isInComposer(image),
          complete: image.complete === true,
          naturalWidth: image.naturalWidth || 0,
          naturalHeight: image.naturalHeight || 0,
          largeEnough: isLargeEnough(image, rect),
        };
      })
      .filter((image) => image.src)
      .filter((image) => image.complete)
      .filter((image) => image.naturalWidth >= 180 && image.naturalHeight >= 180)
      .filter((image) => image.largeEnough)
      .filter((image) => !excludedSet.has(image.src))
      .filter((image) => !/个人资料图片|profile|avatar/i.test(image.alt))
      .filter((image) => !image.inComposer)
      .filter((image) => image.role !== "user");

    const assistantImages = candidates.filter((image) => image.role === "assistant");
    if (assistantImages.length > 0) return assistantImages.map((image) => image.src);
    if (lastUserTop === Number.NEGATIVE_INFINITY) return [];
    return candidates.filter((image) => image.top >= lastUserTop).map((image) => image.src);
  }, excluded);

  return uniqueBy(sources, (source) => source);
}

async function readImageBytes(page, source) {
  if (/^data:/i.test(source)) return readDataUrlImage(source);
  if (/^blob:/i.test(source)) return readBrowserFetchImage(page, source);

  try {
    const response = await page.request.get(source, { timeout: 60_000 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    return {
      buffer: await response.body(),
      contentType: normalizeContentType(response.headers()["content-type"]),
    };
  } catch (firstError) {
    try {
      return await readBrowserFetchImage(page, source);
    } catch (secondError) {
      throw new Error(`${firstError.message}; 页面内读取也失败：${secondError.message}`);
    }
  }
}

async function downloadImageWithFallback({ page, source, file, downloadWaitMs }) {
  if (typeof page.waitForTimeout === "function") await page.waitForTimeout(downloadWaitMs).catch(() => {});
  let downloadButtonFound = false;
  let lastButtonError = null;

  for (const mode of ["inline", "preview"]) {
    try {
      const result = await tryDownloadViaButton({ page, source, file, mode, timeoutMs: Math.max(5000, downloadWaitMs) });
      downloadButtonFound ||= result.downloadButtonFound;
      if (result.downloadEventTriggered) {
        const validation = await validateImageFile(file);
        return {
          method: `${mode}_download_button`,
          downloadButtonFound,
          downloadEventTriggered: true,
          ...validation,
        };
      }
    } catch (error) {
      lastButtonError = error;
      if (error.code !== "download_event_timeout") throw error;
    }
  }

  const image = await readImageBytes(page, source);
  await writeBinaryAtomic(file, image.buffer);
  const validation = await validateImageFile(file);
  return {
    method: downloadButtonFound ? "src_fallback_after_button" : "src_fallback",
    downloadButtonFound,
    downloadEventTriggered: false,
    contentType: image.contentType || validation.contentType,
    bytes: validation.bytes,
    width: validation.width,
    height: validation.height,
    lastButtonError: lastButtonError?.message ?? null,
  };
}

async function tryDownloadViaButton({ page, source, file, mode, timeoutMs }) {
  if (typeof page.waitForEvent !== "function" || typeof page.locator !== "function") {
    return { downloadButtonFound: false, downloadEventTriggered: false };
  }
  if (mode === "preview") {
    await clickImageForPreview(page, source);
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(1000).catch(() => {});
  }

  const marker = `workflow-download-${crypto.randomUUID()}`;
  const marked = await markDownloadButtonForImage(page, { source, marker, globalSearch: mode === "preview" });
  if (!marked.found) {
    console.log(`下载按钮查找：${mode} 模式未找到按钮。`);
    return { downloadButtonFound: false, downloadEventTriggered: false };
  }
  console.log(`下载按钮查找：${mode} 模式找到按钮。`);

  const selector = `[data-workflow-download-target="${marker}"]`;
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
  await page
    .locator(selector)
    .first()
    .click({ timeout: 3000 })
    .catch(async () => {
      await page.evaluate((targetSelector) => document.querySelector(targetSelector)?.click(), selector);
    });

  let download;
  try {
    download = await downloadPromise;
  } catch (error) {
    console.log(`下载事件：${mode} 模式未触发，准备走兜底。`);
    throw workflowError("download_event_timeout", `点击下载按钮后没有收到浏览器 download 事件：${error.message}`);
  }
  console.log(`下载事件：${mode} 模式已触发。`);
  await download.saveAs(file);
  return { downloadButtonFound: true, downloadEventTriggered: true };
}

async function clickImageForPreview(page, source) {
  return page.evaluate((targetSource) => {
    const sameSource = (image) => (image.currentSrc || image.src) === targetSource;
    const image = Array.from(document.images).find(sameSource);
    if (!image) return false;
    image.scrollIntoView?.({ block: "center", inline: "center" });
    image.click?.();
    return true;
  }, source).catch(() => false);
}

async function markDownloadButtonForImage(page, { source, marker, globalSearch }) {
  return page.evaluate(({ source: targetSource, marker: targetMarker, globalSearch: useGlobalSearch }) => {
    const labelOf = (element) =>
      [
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.getAttribute?.("download"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ");
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const isDownloadControl = (element) =>
      /下载|download|save|保存/i.test(labelOf(element)) && isVisible(element);
    const controlsInside = (root) =>
      Array.from(root.querySelectorAll?.("button,a,[role='button']") ?? []).filter(isDownloadControl);
    const mark = (element) => {
      element.setAttribute("data-workflow-download-target", targetMarker);
      return { found: true };
    };

    if (!useGlobalSearch) {
      const image = Array.from(document.images).find((item) => (item.currentSrc || item.src) === targetSource);
      let current = image;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const controls = controlsInside(current);
        if (controls.length > 0) return mark(controls[0]);
        current = current.parentElement;
      }
    }

    const globalControls = controlsInside(document);
    if (globalControls.length > 0) return mark(globalControls[0]);
    return { found: false };
  }, { source, marker, globalSearch }).catch(() => ({ found: false }));
}

function readDataUrlImage(source) {
  const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) throw new Error("无法识别 data 图片地址");
  const contentType = normalizeContentType(match[1]) || "image/png";
  const payload = match[3] || "";
  const buffer = match[2]
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return { buffer, contentType };
}

async function readBrowserFetchImage(page, source) {
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    return {
      contentType: blob.type || response.headers.get("content-type") || "",
      bytes: Array.from(new Uint8Array(buffer)),
    };
  }, source);
  return {
    buffer: Buffer.from(result.bytes),
    contentType: normalizeContentType(result.contentType),
  };
}

function classifyImageSource(source) {
  if (/^blob:/i.test(source)) return "blob";
  if (/^data:/i.test(source)) return "data";
  if (/^https?:/i.test(source)) return "remote";
  return "other";
}

function normalizeContentType(contentType) {
  if (!contentType) return null;
  return contentType.split(";")[0].trim().toLowerCase() || null;
}

function extensionForImage({ contentType, source }) {
  const byType = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
  };
  if (byType[contentType]) return byType[contentType];
  try {
    const extension = path.extname(new URL(source).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return extension === ".jpeg" ? ".jpg" : extension;
  } catch {
    // Fall through to the default extension below.
  }
  return ".png";
}

function generatedImageFilename(taskIndex, imageIndex, extension) {
  return `${String(taskIndex).padStart(3, "0")}_${String(imageIndex).padStart(3, "0")}${extension}`;
}

function generatedImageFilenameForTask(task, imageIndex, extension) {
  if (Number.isInteger(task.rank) && (task.templateId || task.template_id)) {
    return `${String(task.rank).padStart(2, "0")}_${safeFilenamePart(
      task.templateId ?? task.template_id,
    )}_${String(imageIndex).padStart(3, "0")}${extension}`;
  }
  return generatedImageFilename(task.index, imageIndex, extension);
}

function safeFilenamePart(value) {
  const safe = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return safe || "template";
}

async function writeBinaryAtomic(file, buffer) {
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, buffer);
  await fs.rename(temp, file);
}

async function validateImageFile(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error.code === "ENOENT") throw workflowError("downloaded_file_missing", `下载文件不存在：${file}`);
    throw error;
  }
  if (stat.size <= 0) throw workflowError("downloaded_file_invalid", `下载文件是空文件：${file}`);
  const buffer = await fs.readFile(file);
  const info = readImageFileInfo(buffer);
  if (!info) throw workflowError("downloaded_file_invalid", `下载文件不是可识别图片：${file}`);
  if (!info.width || !info.height) throw workflowError("downloaded_file_invalid", `下载图片尺寸无效：${file}`);
  return {
    bytes: stat.size,
    contentType: info.contentType,
    width: info.width,
    height: info.height,
  };
}

async function isValidImageFile(file) {
  try {
    await validateImageFile(file);
    return true;
  } catch {
    return false;
  }
}

function readImageFileInfo(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const jpeg = readJpegSize(buffer);
    if (jpeg) return { contentType: "image/jpeg", ...jpeg };
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const webp = readWebpSize(buffer);
    if (webp) return { contentType: "image/webp", ...webp };
  }
  if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) {
    return { contentType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
    return { contentType: "image/bmp", width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }
  return null;
}

function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpSize(buffer) {
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunkType === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  return null;
}

function workflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function runExampleResumeWorkflow({ dirs, options, manifest }) {
  const runnableTasks = manifest.tasks.filter((task) => task.status === "pending");
  if (runnableTasks.length === 0) {
    manifest.status = "completed";
    await saveExampleResumeManifest(dirs, manifest);
    console.log("No new example images to analyze.");
    return [];
  }

  const browserSession = await openBrowserSession({ dirs, options });
  const { context } = browserSession;
  let page = browserSession.page;
  const runState = {
    aborted: false,
    abortError: null,
  };

  try {
    if (options.cleanupExistingTabs) {
      page = await closeStaleChatGptPages(context, page);
    }
    await page.bringToFront().catch(() => {});
    await waitForComposer(page, options.loginTimeoutMs);
    manifest.status = "running";
    await saveExampleResumeManifest(dirs, manifest);
    console.log(
      `Starting example JSON analysis for ${runnableTasks.length} image(s): wave-size=${options.waveSize}, interval=${options.waveIntervalMs} ms, jitter=±${options.waveJitterMs} ms, max-active=${options.maxActiveWindows}.`,
    );

    await runInLaunchWavesWithLimit({
      items: runnableTasks,
      waveSize: options.waveSize,
      intervalMs: options.waveIntervalMs,
      jitterMs: options.waveJitterMs,
      maxActive: options.maxActiveWindows,
      runState,
      worker: async (task) => {
        await processExampleResumeTask({ context, dirs, options, manifest, task, runState });
      },
    });
    if (runState.abortError) throw runState.abortError;

    const failedTasks = manifest.tasks.filter((task) => task.status === "failed");
    manifest.status = failedTasks.length === 0 ? "completed" : "partial_failed";
    await saveExampleResumeManifest(dirs, manifest);
    if (failedTasks.length === 0) {
      console.log(`Example JSON analysis completed: ${manifest.tasks.length} txt file(s) planned.`);
    } else {
      console.log(`Example JSON analysis finished with ${failedTasks.length} failed image(s).`);
    }
    return failedTasks;
  } catch (error) {
    for (const task of manifest.tasks) {
      if (task.status === "running") task.status = "pending";
    }
    manifest.status = isGlobalRateLimitError(error) ? "rate_limited" : "failed";
    manifest.error = error.message;
    await saveExampleResumeManifest(dirs, manifest).catch(() => {});
    await takeScreenshot(page, dirs, "example-analysis-failed").catch(() => {});
    throw error;
  } finally {
    await browserSession.close();
  }
}

async function processExampleResumeTask({ context, dirs, options, manifest, task, runState }) {
  const label = `example_${String(task.index).padStart(3, "0")}`;
  const imageFile = fromManifestPath(dirs.root, task.image);
  const outputFile = fromManifestPath(dirs.root, task.output);
  if (runState.aborted) return;
  if ((await fileExists(outputFile)) && options.skipExisting && !options.overwrite) {
    task.status = "skipped_existing";
    task.finished_at = new Date().toISOString();
    task.error = null;
    await saveExampleResumeManifest(dirs, manifest);
    console.log(`${label}: skipped because ${path.basename(outputFile)} already exists.`);
    return;
  }

  task.status = "running";
  task.error = null;
  task.started_at = new Date().toISOString();
  await saveExampleResumeManifest(dirs, manifest);

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await delay(Math.min(options.waveIntervalMs, 30_000));
    }
    if (runState.aborted) {
      task.status = "pending";
      await saveExampleResumeManifest(dirs, manifest);
      return;
    }

    const page = await context.newPage();
    const conversation = {
      attempt,
      url: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
    };
    task.attempts = attempt;
    task.conversations.push(conversation);
    await saveExampleResumeManifest(dirs, manifest);

    try {
      console.log(`${label}: attempt ${attempt}/${options.maxAttempts}.`);
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      throwIfRunAborted(runState);
      await waitForComposer(page, options.loginTimeoutMs);
      throwIfRunAborted(runState);
      await waitForResponseComplete(page, 2 * 60 * 1000).catch(() => {});

      const assistantBaseline = (await collectAssistantMessages(page)).length;
      const uploadBaseline = new Set(await collectLargeImageSources(page));
      task.current_stage = "uploading";
      await saveExampleResumeManifest(dirs, manifest);
      await uploadFiles(page, [imageFile], {
        baseline: uploadBaseline,
        expectedCount: 1,
        timeoutMs: options.uploadTimeoutMs,
      });
      throwIfRunAborted(runState);
      task.current_stage = "sending";
      await saveExampleResumeManifest(dirs, manifest);
      await sendMessage(page, manifest.prompt, { confirmTimeoutMs: options.sendConfirmTimeoutMs });

      conversation.url = await waitForConversationUrl(page, 30_000);
      task.current_stage = "waiting_reply";
      await saveExampleResumeManifest(dirs, manifest);
      const jsonText = await waitForAssistantJsonReply(page, {
        assistantBaseline,
        timeoutMs: options.responseTimeoutMs,
      });
      task.current_stage = "parsing_json";
      await saveExampleResumeManifest(dirs, manifest);
      validateExampleAnalysisJsonText(jsonText);
      if ((await fileExists(outputFile)) && !options.overwrite) {
        throw new Error(`${path.basename(outputFile)} was created by another run; pass --overwrite to replace it.`);
      }
      await writeTextAtomic(outputFile, `${jsonText}\n`);

      const finishedAt = new Date().toISOString();
      conversation.finished_at = finishedAt;
      task.status = "completed";
      task.finished_at = finishedAt;
      task.current_stage = null;
      task.error = null;
      await takeScreenshot(page, dirs, `${label}-completed`).catch(() => {});
      await saveExampleResumeManifest(dirs, manifest);
      console.log(`${label}: wrote ${path.basename(outputFile)}.`);
      return;
    } catch (error) {
      const blockingError = await detectBlockingError(page);
      if (blockingError) error = blockingError;
      conversation.url = conversation.url || page.url();
      conversation.error = error.message;
      conversation.finished_at = new Date().toISOString();
      task.error = error.message;
      task.failed_stage = task.current_stage || "unknown";
      await takeScreenshot(page, dirs, `${label}-attempt_${attempt}-failed`).catch(() => {});
      if (isGlobalRateLimitError(error)) {
        runState.aborted = true;
        runState.abortError = error;
        task.status = "pending";
        await saveExampleResumeManifest(dirs, manifest);
        return;
      }
      await saveExampleResumeManifest(dirs, manifest);
      console.log(`${label}: attempt ${attempt}/${options.maxAttempts} failed: ${error.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  task.status = "failed";
  task.finished_at = new Date().toISOString();
  task.current_stage = null;
  await saveExampleResumeManifest(dirs, manifest);
  console.log(`${label}: failed after ${options.maxAttempts} attempt(s).`);
}

async function runInLaunchWavesWithLimit({ items, waveSize, intervalMs, jitterMs, maxActive, runState, worker }) {
  const queue = [...items];
  const running = new Set();
  const errors = [];
  let waveIndex = 0;
  const plannedWaveCount = Math.ceil(items.length / waveSize);

  const startWorker = (item) => {
    const task = Promise.resolve()
      .then(() => worker(item))
      .catch((error) => {
        errors.push(error);
        runState.aborted = true;
        runState.abortError ||= error;
      })
      .finally(() => {
        running.delete(task);
      });
    running.add(task);
  };

  while (queue.length > 0 && !runState.aborted) {
    while (running.size >= maxActive && !runState.aborted) {
      await Promise.race([...running]);
    }
    if (runState.aborted) break;

    const startedAt = Date.now();
    waveIndex += 1;
    const slots = Math.max(1, maxActive - running.size);
    const launchCount = Math.min(waveSize, slots, queue.length);
    const wave = queue.splice(0, launchCount);
    console.log(`Example analysis wave ${waveIndex}/${plannedWaveCount}: ${wave.map((task) => task.index).join(",")}`);
    for (const item of wave) startWorker(item);

    if (queue.length > 0 && !runState.aborted) {
      const waitMs = nextJitteredIntervalMs(intervalMs, jitterMs);
      console.log(`Next example analysis wave starts in about ${waitMs} ms.`);
      await delayUntilNextLaunch(startedAt, waitMs, runState);
    }
  }

  await Promise.all([...running]);
  if (errors.length > 0) throw errors[0];
}

function nextJitteredIntervalMs(intervalMs, jitterMs) {
  if (jitterMs <= 0) return intervalMs;
  const min = Math.max(0, intervalMs - jitterMs);
  const max = intervalMs + jitterMs;
  return crypto.randomInt(min, max + 1);
}

function validateExampleAnalysisJsonText(jsonText) {
  if (!jsonText || !jsonText.trim()) {
    throw new Error("GPT returned empty JSON text.");
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`GPT JSON text is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GPT JSON text must be a JSON object.");
  }
  const missing = EXAMPLE_ANALYSIS_REQUIRED_FIELDS.filter((field) => !Object.hasOwn(parsed, field));
  if (missing.length > 0) {
    throw new Error(`GPT JSON is missing required field(s): ${missing.join(", ")}`);
  }
  const empty = EXAMPLE_ANALYSIS_REQUIRED_FIELDS.filter((field) => parsed[field] === null || parsed[field] === "");
  if (empty.length > 0) {
    throw new Error(`GPT JSON has empty required field(s): ${empty.join(", ")}`);
  }
  if (typeof parsed.retrieval_text === "string" && !parsed.retrieval_text.trim()) {
    throw new Error("GPT JSON retrieval_text is empty.");
  }
  return parsed;
}

async function runWorkflow({ dirs, options, manifest }) {
  const browserSession = await openBrowserSession({ dirs, options });
  const { context } = browserSession;
  let page = browserSession.page;
  const runState = {
    aborted: false,
    abortError: null,
  };

  try {
    if (options.cleanupExistingTabs) {
      page = await closeStaleChatGptPages(context, page);
    }
    await page.bringToFront().catch(() => {});
    await waitForComposer(page, options.loginTimeoutMs);
    const runnableTasks = manifest.tasks.filter((task) => task.status !== "completed");
    if (runnableTasks.length === 0) {
      manifest.status = "completed";
      await saveManifest(dirs, manifest);
      console.log("当前运行记录已经完整，不需要补跑。");
      return [];
    }
    manifest.status = "running";
    await saveManifest(dirs, manifest);
    console.log(
      `开始处理 ${runnableTasks.length} 张例图：每轮同时处理 ${formatParallel(options.maxParallel)} 张，轮次间隔为 ${formatDuration(options.batchIntervalMs)}。`,
    );

    await runInBatches({
      items: runnableTasks,
      batchSize: options.maxParallel,
      intervalMs: options.batchIntervalMs,
      runState,
      worker: async (task) => {
        await processTask({ context, dirs, options, manifest, task, runState });
      },
    });
    if (runState.abortError) throw runState.abortError;

    const failedTasks = manifest.tasks.filter((task) => task.status === "failed");
    manifest.status = failedTasks.length === 0 ? "completed" : "partial_failed";
    await saveManifest(dirs, manifest);

    if (failedTasks.length === 0) {
      console.log(`全部完成：${manifest.tasks.length} 个 txt 已写入 ${fromManifestPath(dirs.root, manifest.outputDir)}`);
    } else {
      console.log(`处理完成，但仍有 ${failedTasks.length} 张失败。成功结果已经写入本轮输出目录。`);
    }
    return failedTasks;
  } catch (error) {
    for (const task of manifest.tasks) {
      if (task.status === "running") task.status = "pending";
    }
    manifest.status = isGlobalRateLimitError(error) ? "rate_limited" : "failed";
    manifest.error = error.message;
    await saveManifest(dirs, manifest).catch(() => {});
    await takeScreenshot(page, dirs, "workflow-failed").catch(() => {});
    if (isGlobalRateLimitError(error)) {
      console.log("检测到 ChatGPT 请求频率限制，已暂停整批任务。请等待几分钟后运行 npm.cmd run resume。");
    }
    throw error;
  } finally {
    await browserSession.close();
  }
}

async function processTask({ context, dirs, options, manifest, task, runState }) {
  const label = `image_${String(task.index).padStart(3, "0")}`;
  const imageFile = fromManifestPath(dirs.root, task.image);
  const outputFile = fromManifestPath(dirs.root, task.output);
  if (runState.aborted) return;
  task.status = "running";
  task.error = null;
  await saveManifest(dirs, manifest);

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`${label}：等待 ${formatDuration(options.batchIntervalMs)} 后重试。`);
      await delay(options.batchIntervalMs);
    }
    if (runState.aborted) {
      task.status = "pending";
      await saveManifest(dirs, manifest);
      return;
    }
    const page = await context.newPage();
    const conversation = {
      attempt,
      url: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    task.attempts = attempt;
    task.conversations.push(conversation);
    await saveManifest(dirs, manifest);

    try {
      console.log(`${label}：开始第 ${attempt}/${options.maxAttempts} 次尝试。`);
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      throwIfRunAborted(runState);
      await waitForComposer(page, options.loginTimeoutMs);
      throwIfRunAborted(runState);
      await waitForResponseComplete(page, 2 * 60 * 1000).catch(() => {});

      const assistantBaseline = (await collectAssistantMessages(page)).length;
      const uploadBaseline = new Set(await collectLargeImageSources(page));
      await uploadFiles(page, [imageFile], { baseline: uploadBaseline, expectedCount: 1 });
      throwIfRunAborted(runState);
      await sendMessage(page, manifest.prompt);

      conversation.url = await waitForConversationUrl(page, 30_000);
      const jsonText = await waitForAssistantJsonReply(page, {
        assistantBaseline,
        timeoutMs: options.responseTimeoutMs,
      });
      await writeTextAtomic(outputFile, `${jsonText}\n`);

      conversation.completedAt = new Date().toISOString();
      task.status = "completed";
      task.completedAt = conversation.completedAt;
      task.error = null;
      await takeScreenshot(page, dirs, `${label}-completed`).catch(() => {});
      await saveManifest(dirs, manifest);
      console.log(`${label}：已保存 ${path.basename(outputFile)}。`);
      return;
    } catch (error) {
      const blockingError = await detectBlockingError(page);
      if (blockingError) error = blockingError;
      conversation.url = conversation.url || page.url();
      conversation.error = error.message;
      task.error = error.message;
      await takeScreenshot(page, dirs, `${label}-attempt_${attempt}-failed`).catch(() => {});
      if (isGlobalRateLimitError(error)) {
        runState.aborted = true;
        runState.abortError = error;
        task.status = "pending";
        await saveManifest(dirs, manifest);
        console.log(`${label}：检测到 ChatGPT 请求频率限制，暂停当前批次。`);
        return;
      }
      await saveManifest(dirs, manifest);
      console.log(`${label}：第 ${attempt}/${options.maxAttempts} 次尝试失败：${error.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  task.status = "failed";
  await saveManifest(dirs, manifest);
  console.log(`${label}：重试次数已用完，跳过并继续其他图片。`);
}

async function waitForAssistantJsonReply(page, { assistantBaseline, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let previousText = "";
  let stableSince = null;

  while (Date.now() < deadline) {
    await checkForBlockingMessages(page);
    const messages = await collectAssistantMessages(page);
    const text = messages.length > assistantBaseline ? messages.at(-1).trim() : "";
    const stopVisible = await anyVisible(page, [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="Cancel"]',
      'button[aria-label*="取消"]',
    ]);

    if (text && text === previousText && !stopVisible) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 6000) return extractJsonText(text);
    } else {
      stableSince = null;
      previousText = text;
    }
    await page.waitForTimeout(2000);
  }

  throw new Error("等待 GPT 返回 JSON 超时。");
}

async function collectAssistantMessages(page) {
  return page.evaluate(() => {
    const direct = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const elements =
      direct.length > 0
        ? direct
        : Array.from(document.querySelectorAll("article")).filter((article) =>
            /chatgpt|assistant/i.test(article.getAttribute("aria-label") || ""),
          );
    return elements.map((element) => (element.innerText || element.textContent || "").trim()).filter(Boolean);
  });
}

function extractJsonText(reply) {
  const candidates = [reply.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of reply.matchAll(fenced)) {
    candidates.push(match[1].trim());
  }
  candidates.push(...findBalancedJsonCandidates(reply));

  for (const candidate of uniqueBy(candidates, (value) => value)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== "object") continue;
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Try the next possible JSON region.
    }
  }
  throw new Error("GPT 已回复，但没有找到可解析的 JSON 主体。");
}

function findBalancedJsonCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

async function runBrowserSmokeTest({ dirs, options }) {
  const browserSession = await openBrowserSession({ dirs, options });
  try {
    await waitForComposer(browserSession.page, options.loginTimeoutMs);
    await takeScreenshot(browserSession.page, dirs, "open-only").catch(() => {});
    console.log(`浏览器连通性检查通过：${browserSession.page.url()}`);
  } finally {
    await browserSession.close();
  }
}

async function runTabCleanup({ dirs, options }) {
  const browserSession = await openBrowserSession({ dirs, options });
  try {
    const page = await closeStaleChatGptPages(browserSession.context, browserSession.page);
    await waitForComposer(page, options.loginTimeoutMs);
    await takeScreenshot(page, dirs, "tabs-cleaned").catch(() => {});
    console.log("旧的工作流对话页已经清理，只保留一个 ChatGPT 首页。");
  } finally {
    await browserSession.close();
  }
}

async function closeStaleChatGptPages(context, preferredPage) {
  const chatPages = context.pages().filter((page) => isChatGptPage(page));
  let keepPage = chatPages.find((page) => isChatGptHomePage(page)) || preferredPage;
  if (!keepPage || !isChatGptPage(keepPage)) {
    keepPage = await context.newPage();
  }

  const stalePages = chatPages.filter((page) => page !== keepPage);
  await Promise.all(stalePages.map((page) => page.close().catch(() => {})));
  if (!isChatGptHomePage(keepPage)) {
    await keepPage.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  if (stalePages.length > 0) {
    console.log(`已关闭 ${stalePages.length} 个旧 ChatGPT 对话页，避免窗口持续累积。`);
  }
  return keepPage;
}

function isChatGptPage(page) {
  return /chatgpt\.com/i.test(page.url());
}

function isChatGptHomePage(page) {
  return /^https:\/\/chatgpt\.com\/?(?:[?#].*)?$/i.test(page.url());
}

async function openBrowserSession({ dirs, options }) {
  if (options.connectExisting) {
    console.log(`正在连接已经打开并登录的 Chrome：${options.cdpUrl}`);
    let browser;
    try {
      browser = await chromium.connectOverCDP(options.cdpUrl, { timeout: 15_000 });
    } catch (error) {
      if (!options.autoOpenBrowser || !isLocalCdpUrl(options.cdpUrl)) {
        throw buildCdpConnectionError({ cdpUrl: options.cdpUrl, error });
      }
      console.log("没有检测到专用 Chrome，正在自动打开。");
      await openControllableChrome({ dirs, options });
      try {
        browser = await waitForCdpBrowser({
          cdpUrl: options.cdpUrl,
          timeoutMs: DEFAULT_CDP_STARTUP_TIMEOUT_MS,
        });
      } catch (startupError) {
        throw buildCdpConnectionError({ cdpUrl: options.cdpUrl, error: startupError });
      }
    }

    const context = browser.contexts()[0];
    if (!context) throw new Error("已连接 Chrome，但没有找到可用浏览器上下文。");
    context.setDefaultTimeout(30_000);
    return {
      context,
      page: await openChatGptPage(context),
      close: async () => disconnectBrowser(browser),
    };
  }

  const executablePath = await findBrowserExecutable();
  console.log(`正在打开独立 Chrome：${executablePath}`);
  console.log(`专用登录资料：${dirs.profileDir}`);
  const context = await chromium.launchPersistentContext(dirs.profileDir, {
    executablePath,
    headless: options.headless,
    viewport: { width: 1440, height: 1000 },
  });
  context.setDefaultTimeout(30_000);
  return {
    context,
    page: await openChatGptPage(context),
    close: async () => context.close(),
  };
}

async function disconnectBrowser(browser) {
  // For connectOverCDP, Playwright's close() tears down only this automation
  // transport. The externally launched Chrome, its profile and conversations stay open.
  if (browser?.isConnected()) await browser.close();
}

function buildCdpConnectionError({ cdpUrl, error }) {
  return new Error(
    [
      `连接专用 Chrome 失败：${error.message}。`,
      `目标地址：${cdpUrl}。`,
      "请运行 npm.cmd run open-login，在打开的 Chrome 窗口里登录 ChatGPT，",
      "然后重新运行刚才的命令。",
    ].join(""),
  );
}

async function openControllableChrome({ dirs, options }) {
  const executablePath = await findBrowserExecutable();
  const port = cdpDebugPort(options.cdpUrl);
  const profileDir = dirs.profileDir;
  console.log(`专用登录资料：${profileDir}`);
  spawnDetached(executablePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://chatgpt.com/",
  ]);
}

async function waitForCdpBrowser({ cdpUrl, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(cdpUrl, { timeout: 3000 });
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }
  throw lastError || new Error(`等待 ${cdpUrl} 启动超时`);
}

function isLocalCdpUrl(cdpUrl) {
  try {
    const hostname = new URL(cdpUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function cdpDebugPort(cdpUrl) {
  try {
    const url = new URL(cdpUrl);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    throw new Error(`无法解析 Chrome 调试地址：${cdpUrl}`);
  }
}

async function openChatGptPage(context) {
  const existing = context.pages().find((candidate) => /chatgpt\.com/i.test(candidate.url()));
  const page = existing || context.pages()[0] || (await context.newPage());
  if (!/chatgpt\.com/i.test(page.url())) {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return page;
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.CHATGPT_BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("没有找到 Google Chrome。请安装 Chrome，或用 CHATGPT_BROWSER_PATH 指定 chrome.exe 路径。");
}

function spawnDetached(file, args) {
  const child = spawn(file, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child;
}

async function waitForComposer(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastNoticeAt = 0;
  while (Date.now() < deadline) {
    await checkForBlockingMessages(page);
    const composer = await findComposer(page);
    if (composer) return composer;
    if (Date.now() - lastNoticeAt > 15_000) {
      lastNoticeAt = Date.now();
      console.log("等待 ChatGPT 输入框。需要时请在打开的 Chrome 窗口里登录并完成人真验证。");
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("没有找到 ChatGPT 输入框。请确认已经登录，并且页面停在聊天界面。");
}

async function findComposer(page) {
  const selectors = [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="发消息"]',
    'textarea[placeholder*="询问"]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if ((await candidate.isVisible().catch(() => false)) && (await candidate.isEnabled().catch(() => true))) {
        return candidate;
      }
    }
  }
  return null;
}

async function uploadFiles(page, files, { baseline, expectedCount, timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS, stableMs = 3000 }) {
  const absoluteFiles = files.map((file) => path.resolve(file));
  await Promise.all(absoluteFiles.map((file) => fs.access(file)));

  const setOnExistingInput = async () => {
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      try {
        await inputs.nth(index).setInputFiles(absoluteFiles, { timeout: 15_000 });
        return true;
      } catch {
        // Try another file input or open the attachment menu below.
      }
    }
    return false;
  };

  if (!(await setOnExistingInput())) {
    const buttons = [
      'button[aria-label*="Attach"]',
      'button[aria-label*="Upload"]',
      'button[aria-label*="Add photos"]',
      'button[aria-label*="添加"]',
      'button[aria-label*="上传"]',
      'button[aria-label*="附件"]',
      '[data-testid="plus-button"]',
      '[data-testid="composer-plus-btn"]',
    ];
    let uploaded = false;
    for (const selector of buttons) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        await candidate.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(750);
        if (await setOnExistingInput()) {
          uploaded = true;
          break;
        }
      }
      if (uploaded) break;
    }
    if (!uploaded) throw new Error("没有找到可用的图片上传入口。ChatGPT 页面可能改版了。");
  }

  await waitForUploadSettled(page, timeoutMs);
  await waitForUploadedImageCount(page, baseline, expectedCount, timeoutMs, stableMs);
  await waitForUploadSettled(page, timeoutMs);
}

async function waitForUploadSettled(page, timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkForBlockingMessages(page);
    const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (!/uploading|上传中|正在上传|processing upload|处理上传/i.test(body)) {
      await page.waitForTimeout(2000);
      return;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error("图片上传长时间没有完成。");
}

async function waitForUploadedImageCount(page, baseline, expectedCount, timeoutMs, stableMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let stableSince = null;
  while (Date.now() < deadline) {
    await checkForBlockingMessages(page);
    lastCount = await countNewUploadedImages(page, baseline);
    const uploading = await isUploadInProgress(page);
    if (lastCount >= expectedCount && !uploading) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return lastCount;
    } else {
      stableSince = null;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`附件上传不完整：需要 ${expectedCount} 张，页面只检测到 ${lastCount} 张。`);
}

async function countNewUploadedImages(page, baseline) {
  const sources = await collectLargeImageSources(page);
  return uniqueBy(
    sources.filter((source) => !baseline.has(source)),
    (source) => source,
  ).length;
}

async function isUploadInProgress(page) {
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return /uploading|processing upload|preparing file|attaching|銝?銝迢甇?銝?|憭?銝?/i.test(body);
}

async function collectLargeImageSources(page) {
  return page.evaluate(() =>
    Array.from(document.images)
      .map((image) => {
        const rect = image.getBoundingClientRect();
        return {
          src: image.currentSrc || image.src,
          width: image.naturalWidth || rect.width,
          height: image.naturalHeight || rect.height,
          alt: image.alt || "",
        };
      })
      .filter((image) => image.src && image.width >= 180 && image.height >= 180 && !/个人资料图片|profile/i.test(image.alt))
      .map((image) => image.src),
  );
}

async function sendMessage(page, message, { confirmTimeoutMs = DEFAULT_SEND_CONFIRM_TIMEOUT_MS } = {}) {
  await checkForBlockingMessages(page);
  const composer = await waitForComposer(page, 60_000);
  const userBaseline = await countUserMessages(page);
  const assistantBaseline = (await collectAssistantMessages(page)).length;
  await composer.click();
  await clearComposer(page, composer);
  await page.keyboard.insertText(message);
  await page.waitForTimeout(500);

  await waitForSendButtonReady(page, confirmTimeoutMs).catch(() => {});
  if (
    (await clickSendButton(page)) &&
    (await waitForSendAccepted(page, { timeoutMs: confirmTimeoutMs, userBaseline, assistantBaseline }))
  ) {
    return;
  }
  await checkForBlockingMessages(page);
  await page.keyboard.press("Enter");
  if (await waitForSendAccepted(page, { timeoutMs: confirmTimeoutMs, userBaseline, assistantBaseline })) return;
  await checkForBlockingMessages(page);
  throw new Error("已经填写消息，但没有确认 ChatGPT 接收到发送动作。");
}

async function clickSendButton(page) {
  const selectors = [
    '[data-testid="send-button"]',
    "#composer-submit-button",
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Submit"]',
    "button.composer-submit-btn",
    "button.composer-submit-button-color",
  ];
  for (const selector of selectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      if (!(await button.isEnabled().catch(() => false))) continue;
      try {
        await button.click({ timeout: 5000 });
        return true;
      } catch {
        // Fall back to DOM pointer events below.
      }
    }
  }
  return clickSendButtonInDom(page);
}

async function clickSendButtonInDom(page) {
  return page
    .evaluate(() => {
      const selectors = [
        '#composer-submit-button[data-testid="send-button"]',
        '[data-testid="send-button"]',
        "#composer-submit-button",
        'button[aria-label*="Send"]',
        'button[aria-label*="发送"]',
        'button[aria-label*="Submit"]',
        "button.composer-submit-btn",
        "button.composer-submit-button-color",
      ];
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (!button || button.disabled) continue;
        button.scrollIntoView({ block: "center", inline: "center" });
        button.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        button.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        button.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

async function waitForSendAcceptedLegacy(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const accepted = await page
      .evaluate(() => {
        const submit = document.querySelector("#composer-submit-button, [data-testid='send-button'], [data-testid='stop-button']");
        const testId = submit?.dataset?.testid || "";
        const aria = submit?.getAttribute("aria-label") || "";
        const composer = document.querySelector(
          "#prompt-textarea, [data-testid='prompt-textarea'], div.ProseMirror[contenteditable='true']",
        );
        const composerText = (composer?.innerText || composer?.value || "").trim();
        return testId.includes("stop") || /stop|停止|cancel|取消/i.test(aria) || composerText.length === 0;
      })
      .catch(() => false);
    if (accepted) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForSendAccepted(page, { timeoutMs, userBaseline, assistantBaseline }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const accepted = await page
      .evaluate(({ userBaseline, assistantBaseline }) => {
        const submit = document.querySelector("#composer-submit-button, [data-testid='send-button'], [data-testid='stop-button']");
        const testId = submit?.dataset?.testid || "";
        const aria = submit?.getAttribute("aria-label") || "";
        const composer = document.querySelector(
          "#prompt-textarea, [data-testid='prompt-textarea'], div.ProseMirror[contenteditable='true']",
        );
        const composerText = (composer?.innerText || composer?.value || "").trim();
        const userMessages = document.querySelectorAll('[data-message-author-role="user"]').length;
        const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]').length;
        const stopVisible = Boolean(
          document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Cancel"]'),
        );
        return (
          testId.includes("stop") ||
          /stop|cancel/i.test(aria) ||
          composerText.length === 0 ||
          userMessages > userBaseline ||
          assistantMessages > assistantBaseline ||
          stopVisible
        );
      }, { userBaseline, assistantBaseline })
      .catch(() => false);
    if (accepted) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForSendButtonReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkForBlockingMessages(page);
    const ready = await page
      .evaluate(() => {
        const selectors = [
          '[data-testid="send-button"]',
          "#composer-submit-button",
          'button[aria-label*="Send"]',
          'button[aria-label*="Submit"]',
          "button.composer-submit-btn",
          "button.composer-submit-button-color",
        ];
        return selectors.some((selector) => {
          const button = document.querySelector(selector);
          if (!button) return false;
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          return !button.disabled && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
      })
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function countUserMessages(page) {
  return page
    .evaluate(() => document.querySelectorAll('[data-message-author-role="user"]').length)
    .catch(() => 0);
}

async function clearComposer(page, composer) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await composer.click();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press("Backspace");
}

async function waitForResponseComplete(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  while (Date.now() < deadline) {
    const stopVisible = await anyVisible(page, ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]']);
    const composer = await findComposer(page);
    if (!stopVisible && composer) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 3000) return;
    } else {
      stableSince = null;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("等待页面准备就绪超时。");
}

async function waitForConversationUrl(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/chatgpt\.com\/c\//i.test(page.url())) return page.url();
    await page.waitForTimeout(500);
  }
  return page.url();
}

async function anyVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function checkForBlockingMessages(page) {
  const error = await detectBlockingError(page);
  if (error) throw error;
}

async function detectBlockingError(page) {
  const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const rateLimitModal = await page
    .locator('[data-testid="modal-conversation-history-rate-limit"], #modal-conversation-history-rate-limit')
    .innerText({ timeout: 1000 })
    .catch(() => "");
  const text = `${body}\n${rateLimitModal}`;
  const blockers = [
    /请求过于频繁/,
    /暂时限制你访问对话记录/,
    /you'?ve reached .*limit/i,
    /rate limit/i,
    /try again later/i,
    /too many requests/i,
    /usage cap/i,
    /达到.*限制/,
    /频率.*限制/,
    /上传次数已用尽/,
    /请稍后再试/,
    /请求过多/,
  ];
  const matched = findRateLimitPattern(text, blockers);
  if (matched) {
    return new ChatGptRateLimitError("ChatGPT 请求过于频繁。请等待几分钟后运行 npm.cmd run resume。");
  }
  return null;
}

function findRateLimitPattern(text, patterns = null) {
  const candidates =
    patterns ??
    [
      /请求过于频繁/,
      /暂时限制你访问对话记录/,
      /you'?ve reached .*limit/i,
      /rate limit/i,
      /try again later/i,
      /too many requests/i,
      /usage cap/i,
      /达到.*限制/,
      /频率.*限制/,
      /上传次数已用尽/,
      /请稍后再试/,
      /请求过多/,
    ];
  return candidates.find((pattern) => pattern.test(text)) || null;
}

class ChatGptRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChatGptRateLimitError";
    this.code = "CHATGPT_RATE_LIMIT";
  }
}

function isGlobalRateLimitError(error) {
  return (
    error?.code === "CHATGPT_RATE_LIMIT" ||
    /请求过于频繁|暂时限制你访问对话记录|rate limit|too many requests/i.test(error?.message || "")
  );
}

function throwIfRunAborted(runState) {
  if (runState.aborted) {
    throw runState.abortError || new ChatGptRateLimitError("ChatGPT 请求过于频繁，请稍后补跑。");
  }
}

async function runInBatches({ items, batchSize, intervalMs, runState, worker }) {
  const normalizedBatchSize =
    batchSize === Number.POSITIVE_INFINITY ? Math.max(1, items.length) : batchSize;
  const batches = chunk(items, normalizedBatchSize);
  for (let index = 0; index < batches.length; index += 1) {
    if (runState.aborted) return;
    const batch = batches[index];
    console.log(`开始第 ${index + 1}/${batches.length} 轮，本轮 ${batch.length} 张。`);
    await Promise.all(batch.map((item) => worker(item)));
    if (runState.aborted) return;
    if (index < batches.length - 1 && intervalMs > 0) {
      console.log(`本轮结束，等待 ${formatDuration(intervalMs)} 后启动下一轮。`);
      await delay(intervalMs);
    }
  }
}

async function runInLaunchBatches({ items, batchSize, intervalMs, intervalRangeMs = null, runState, worker }) {
  const normalizedBatchSize =
    batchSize === Number.POSITIVE_INFINITY ? Math.max(1, items.length) : batchSize;
  const batches = chunk(items, normalizedBatchSize);
  const running = [];

  for (let index = 0; index < batches.length; index += 1) {
    if (runState.aborted) break;
    const batch = batches[index];
    const startedAt = Date.now();
    console.log(`启动第 ${index + 1}/${batches.length} 轮，本轮 ${batch.length} 个窗口。`);

    const batchRun = Promise.all(batch.map((item) => worker(item))).then(
      () => null,
      (error) => {
        runState.aborted = true;
        runState.abortError ||= error;
        return error;
      },
    );
    running.push(batchRun);

    const waitMs = nextIntervalMs({ intervalMs, intervalRangeMs });
    if (index < batches.length - 1 && waitMs > 0) {
      console.log(`本轮窗口已启动，从现在开始计时 ${formatDuration(waitMs)} 后启动下一轮。`);
      await delayUntilNextLaunch(startedAt, waitMs, runState);
    }
  }

  const errors = (await Promise.all(running)).filter(Boolean);
  if (errors.length > 0) throw errors[0];
}

async function delayUntilNextLaunch(startedAt, intervalMs, runState) {
  while (!runState.aborted) {
    const remaining = intervalMs - (Date.now() - startedAt);
    if (remaining <= 0) return;
    await delay(Math.min(remaining, 500));
  }
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function timestampId() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join("");
}

function setupRunLogging(dirs) {
  const logFile = path.join(dirs.recordsDir, "last-run.log");
  const append = (level, args) => {
    const line = `[${new Date().toISOString()}] ${level} ${args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ")}\n`;
    fs.appendFile(logFile, line, "utf8").catch(() => {});
  };
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args) => {
    append("INFO", args);
    originalLog(...args);
  };
  console.error = (...args) => {
    append("ERROR", args);
    originalError(...args);
  };
  console.log(`运行日志：${logFile}`);
}

async function takeScreenshot(page, dirs, label) {
  const safeLabel = label.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  const file = path.join(dirs.screenshotsDir, `${timestampId()}-${safeLabel}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSelfTests() {
  const assertions = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(`自测失败：${message}`);
    assertions.push(message);
  };

  assert(extractJsonText('{"name":"portrait"}') === '{\n  "name": "portrait"\n}', "支持纯 JSON");
  assert(extractJsonText('```json\n{"style":"studio"}\n```') === '{\n  "style": "studio"\n}', "支持 JSON 代码块");
  assert(
    extractJsonText('分析如下：\n{"lighting":{"type":"soft"},"poses":[1,2]}\n请查收。') ===
      '{\n  "lighting": {\n    "type": "soft"\n  },\n  "poses": [\n    1,\n    2\n  ]\n}',
    "支持带说明文字的 JSON",
  );
  let rejectedInvalidJson = false;
  try {
    extractJsonText("这里只是普通文字");
  } catch {
    rejectedInvalidJson = true;
  }
  assert(rejectedInvalidJson, "拒绝无 JSON 回复");
  assert(findRateLimitPattern("请求过于频繁，请稍等几分钟后再重试。"), "识别中文请求频率限制弹窗");
  assert(findRateLimitPattern("rate limit exceeded, try again later"), "识别英文请求频率限制提示");
  const parsedIntervalRange = parseIntervalRange("180000-300000", "--test");
  assert(parsedIntervalRange.minMs === 180_000 && parsedIntervalRange.maxMs === 300_000, "支持 3-5 分钟随机间隔参数");
  assert(nextIntervalMs({ intervalMs: 15_000, intervalRangeMs: { minMs: 10_000, maxMs: 10_000 } }) === 10_000, "随机间隔会覆盖固定间隔");
  assert(extensionForImage({ contentType: "image/jpeg", source: "" }) === ".jpg", "按图片类型选择保存扩展名");
  assert(
    extensionForImage({ contentType: null, source: "https://example.com/generated.webp?sig=1" }) === ".webp",
    "按图片地址选择保存扩展名",
  );
  assert(generatedImageFilename(7, 2, ".png") === "007_002.png", "生成图文件名包含 JSON 序号和图片序号");
  const downloadStateTask = {};
  applyDownloadedImagesToTask(
    downloadStateTask,
    [
      { status: "downloaded" },
      { status: "failed" },
    ],
    "2026-06-03T00:00:00.000Z",
  );
  assert(downloadStateTask.downloadedImageCount === 1, "统计已下载生成图数量");
  assert(downloadStateTask.downloadStatus === "partial_failed", "识别部分图片下载失败");

  const generatedSeenTask = { status: "generated_seen", generated_at: "2026-06-03T00:00:00.000Z" };
  assert(shouldDownloadOnly(generatedSeenTask), "generated_seen only enters download collection");
  const refreshRecoveredTask = { status: "refresh_recovered", generated_at: "2026-06-03T00:00:00.000Z" };
  assert(shouldDownloadOnly(refreshRecoveredTask), "refresh_recovered only enters download collection");
  assert(
    shouldRecoverBeforeGenerationRetry({ status: "submitted", conversationUrl: "https://chatgpt.com/c/test" }),
    "submitted task recovers existing conversation before retrying generation",
  );
  assert(
    shouldRecoverBeforeGenerationRetry({ status: "generation_timeout", conversationUrl: "https://chatgpt.com/c/test" }),
    "generation_timeout task recovers existing conversation before retrying generation",
  );
  const historyTask = { status: "pending" };
  markGenerationTaskStatus(historyTask, "submitted", { attempt: 1 });
  assert(historyTask.status === "submitted" && historyTask.status_history.length === 1, "generation status history records submitted");

  let activeWorkers = 0;
  let peakWorkers = 0;
  const batchStarts = [];
  await runInBatches({
    items: [1, 2, 3, 4, 5, 6, 7],
    batchSize: 3,
    intervalMs: 15,
    runState: { aborted: false },
    worker: async (item) => {
      if (item === 1 || item === 4 || item === 7) batchStarts.push(Date.now());
      activeWorkers += 1;
      peakWorkers = Math.max(peakWorkers, activeWorkers);
      await delay(5);
      activeWorkers -= 1;
    },
  });
  assert(peakWorkers === 3, "分轮队列严格限制每轮同时处理数量");
  assert(
    batchStarts[1] - batchStarts[0] >= 15 && batchStarts[2] - batchStarts[1] >= 15,
    "分轮队列会在轮次之间等待",
  );
  activeWorkers = 0;
  peakWorkers = 0;
  batchStarts.length = 0;
  await runInLaunchBatches({
    items: [1, 2, 3, 4, 5, 6, 7],
    batchSize: 3,
    intervalMs: 15,
    runState: { aborted: false },
    worker: async (item) => {
      if (item === 1 || item === 4 || item === 7) batchStarts.push(Date.now());
      activeWorkers += 1;
      peakWorkers = Math.max(peakWorkers, activeWorkers);
      await delay(60);
      activeWorkers -= 1;
    },
  });
  assert(peakWorkers > 3, "按启动时间间隔发车时，不等待上一轮完成");
  assert(
    batchStarts[1] - batchStarts[0] >= 10 && batchStarts[2] - batchStarts[1] >= 10,
    "启动间隔从上一轮启动时开始计算",
  );

  const fakePage = (url) => ({
    closed: false,
    url: () => url,
    close: async function () {
      this.closed = true;
    },
  });
  const homePage = fakePage("https://chatgpt.com/");
  const oldConversationOne = fakePage("https://chatgpt.com/c/one");
  const oldConversationTwo = fakePage("https://chatgpt.com/c/two");
  const unrelatedPage = fakePage("https://example.com/");
  const fakeContext = {
    pages: () => [oldConversationOne, unrelatedPage, homePage, oldConversationTwo],
  };
  assert((await closeStaleChatGptPages(fakeContext, oldConversationOne)) === homePage, "清理旧页面时保留 ChatGPT 首页");
  assert(oldConversationOne.closed && oldConversationTwo.closed && !unrelatedPage.closed, "只关闭旧 ChatGPT 对话页");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "image-json-workflow-"));
  const exampleDir = path.join(tempRoot, "例图");
  try {
    await fs.mkdir(exampleDir, { recursive: true });
    const atomicFile = path.join(tempRoot, "atomic.txt");
    await writeTextAtomic(atomicFile, "first");
    await writeTextAtomic(atomicFile, "second");
    assert((await fs.readFile(atomicFile, "utf8")) === "second", "原子写入支持覆盖已有文件");

    const fixtures = [
      { name: "1.jpg", value: "old-one", time: 3000 },
      { name: "1.png", value: "first", time: 1000 },
      { name: "27.png", value: "third", time: 3000 },
      { name: "alpha.jpg", value: "second", time: 2000 },
    ];
    for (const fixture of fixtures) {
      const file = path.join(exampleDir, fixture.name);
      await fs.writeFile(file, fixture.value, "utf8");
      const time = new Date(fixture.time);
      await fs.utimes(file, time, time);
    }

    const beforeDryRun = (await fs.readdir(exampleDir)).sort();
    const plan = await buildRenamePlan(exampleDir);
    const afterDryRun = (await fs.readdir(exampleDir)).sort();
    assert(JSON.stringify(beforeDryRun) === JSON.stringify(afterDryRun), "编号预览不会修改文件");
    assert(plan[0].originalName === "1.png" && plan[0].renamedName === "1.png", "按修改时间升序编号");
    assert(plan[2].originalName === "1.jpg" && plan[2].renamedName === "3.jpg", "时间相同时按文件名自然排序");

    await applyRenamePlan(plan);
    const renamedFiles = (await fs.readdir(exampleDir)).sort(naturalCompare);
    assert(
      JSON.stringify(renamedFiles) === JSON.stringify(["1.png", "2.jpg", "3.jpg", "4.png"]),
      "冲突文件名通过临时名称安全中转",
    );
    assert((await fs.readFile(path.join(exampleDir, "3.jpg"), "utf8")) === "old-one", "重新编号不覆盖图片内容");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const generationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "portrait-generation-workflow-"));
  try {
    const generationDirs = workspacePaths(generationRoot);
    await ensureSupportDirs(generationDirs);
    const jsonDir = path.join(generationDirs.outputRootDir, "run_json");
    await fs.mkdir(jsonDir, { recursive: true });
    await fs.mkdir(generationDirs.customerDir, { recursive: true });
    await fs.writeFile(path.join(jsonDir, "1.txt"), '{"ok":true}', "utf8");
    await fs.writeFile(path.join(generationDirs.customerDir, "customer.jpg"), "fake", "utf8");
    const generationManifest = await createGenerationManifest({
      dirs: generationDirs,
      options: {
        jsonTextDir: jsonDir,
        generationSuffix: "生成测试图",
        maxAttempts: 1,
        maxParallel: 3,
        batchIntervalMs: 15,
        generationTimeoutMs: 60_000,
      },
    });
    assert(generationManifest.imageResultDir.startsWith("图片结果/run_"), "二阶段清单记录图片结果目录");
    assert(await fileExists(fromManifestPath(generationDirs.root, generationManifest.imageResultDir)), "二阶段会新建图片结果目录");
  } finally {
    await fs.rm(generationRoot, { recursive: true, force: true });
  }

  const resumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "portrait-resume-workflow-"));
  try {
    const resumeDirs = workspacePaths(resumeRoot);
    const imageDir = path.join(resumeRoot, "生成结果", "client_001");
    await fs.mkdir(imageDir, { recursive: true });
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lS1qNwAAAABJRU5ErkJggg==",
      "base64",
    );
    const completedImage = path.join(imageDir, "01_template_a_001.png");
    await writeBinaryAtomic(completedImage, validPng);
    const resumeManifest = {
      runId: "fresh",
      tasks: [
        { index: 1, rank: 1, templateId: "template_a", sourceTxtPath: "a.txt", jsonTextFile: "a.txt", status: "pending" },
        { index: 2, rank: 2, templateId: "template_b", sourceTxtPath: "b.txt", jsonTextFile: "b.txt", status: "pending" },
        { index: 3, rank: 3, templateId: "template_c", sourceTxtPath: "c.txt", jsonTextFile: "c.txt", status: "pending" },
        { index: 4, rank: 4, templateId: "template_d", sourceTxtPath: "d.txt", jsonTextFile: "d.txt", status: "pending" },
      ],
    };
    mergeExistingGenerationManifest(resumeManifest, {
      run_id: "existing",
      tasks: [
        {
          rank: 1,
          template_id: "template_a",
          source_txt_path: "a.txt",
          output_image_path: relativeForManifest(resumeDirs.root, completedImage),
          status: "completed",
          generation_attempts: 1,
          download_attempts: 1,
          generated_at: "2026-06-09T00:00:00.000Z",
          downloaded_at: "2026-06-09T00:01:00.000Z",
        },
        {
          rank: 2,
          template_id: "template_b",
          source_txt_path: "b.txt",
          status: "generated",
          generation_attempts: 1,
          conversation_url: "https://chatgpt.com/c/generated",
        },
        {
          rank: 3,
          template_id: "template_c",
          source_txt_path: "c.txt",
          status: "download_failed",
          generation_attempts: 1,
          download_attempts: 3,
          conversation_url: "https://chatgpt.com/c/download_failed",
        },
        {
          rank: 4,
          template_id: "template_d",
          source_txt_path: "d.txt",
          output_image_path: "missing.png",
          status: "completed",
        },
      ],
    });
    await restoreCompletedTaskValidity({ dirs: resumeDirs, manifest: resumeManifest });
    assert(resumeManifest.runId === "existing", "断点恢复保留已有 run_id");
    assert(resumeManifest.tasks[0].status === "completed", "断点恢复保留已完成且文件有效的任务");
    assert(!needsGenerationTaskWork(resumeManifest.tasks[0], { maxGenerationRetries: 2 }), "completed 任务会被跳过");
    assert(shouldDownloadOnly(resumeManifest.tasks[1]), "generated 任务恢复后只进入下载阶段");
    assert(shouldDownloadOnly(resumeManifest.tasks[2]), "download_failed 任务恢复后只进入下载阶段");
    assert(resumeManifest.tasks[3].status === "pending" || resumeManifest.tasks[3].status === "download_failed", "completed 但文件缺失会被降级为可恢复状态");
  } finally {
    await fs.rm(resumeRoot, { recursive: true, force: true });
  }

  const downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "portrait-download-workflow-"));
  try {
    const downloadDirs = workspacePaths(downloadRoot);
    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lS1qNwAAAABJRU5ErkJggg==";
    const generatedDataUrl = `data:image/png;base64,${tinyPngBase64}`;
    const customerDataUrl = `data:image/png;base64,${Buffer.from("customer-image").toString("base64")}`;
    const makeFakeImage = (src, role, alt = "", top = 0) => ({
      currentSrc: src,
      src,
      complete: true,
      naturalWidth: 512,
      naturalHeight: 512,
      alt,
      getBoundingClientRect: () => ({ width: 512, height: 512, top }),
      closest: (selector) => {
        if (selector === "[data-message-author-role]") {
          return role ? { getAttribute: () => role } : null;
        }
        return null;
      },
    });
    const fakeDownloadPage = {
      locator: () => ({ innerText: async () => "" }),
      waitForTimeout: async () => {},
      evaluate: async (fn, arg) => {
        const previousDocument = globalThis.document;
        globalThis.document = {
          querySelectorAll: (selector) =>
            selector === '[data-message-author-role="user"]'
              ? [{ getBoundingClientRect: () => ({ top: 10 }) }]
              : [],
          images: [
            makeFakeImage(customerDataUrl, "user", "", 15),
            makeFakeImage(generatedDataUrl, "", "", 120),
            makeFakeImage("data:image/png;base64,cHJvZmlsZQ==", "assistant", "profile", 130),
          ],
        };
        try {
          return await fn(arg);
        } finally {
          globalThis.document = previousDocument;
        }
      },
    };
    const manifest = { runId: "download-test", imageResultDir: "图片结果/run_download_test" };
    const records = await downloadGeneratedImages({
      page: fakeDownloadPage,
      dirs: downloadDirs,
      manifest,
      task: { index: 5 },
      excludedSources: new Set([customerDataUrl]),
    });
    assert(records.length === 1 && records[0].status === "downloaded", "只下载 GPT 对话里新增的生成图");
    assert(records[0].file.endsWith("005_001.png"), "生成图保存到序号文件名");
    assert(await isValidImageFile(fromManifestPath(downloadDirs.root, records[0].file)), "下载后验证有效图片文件");
    const ambiguousPage = {
      locator: () => ({ innerText: async () => "" }),
      waitForTimeout: async () => {},
      evaluate: async (fn, arg) => {
        const previousDocument = globalThis.document;
        globalThis.document = {
          querySelectorAll: () => [],
          images: [makeFakeImage(customerDataUrl, ""), makeFakeImage(generatedDataUrl, "")],
        };
        try {
          return await fn(arg);
        } finally {
          globalThis.document = previousDocument;
        }
      },
    };
    assert((await collectGeneratedImageSources(ambiguousPage, new Set())).length === 0, "无法区分用户图和生成图时不乱下载");
  } finally {
    await fs.rm(downloadRoot, { recursive: true, force: true });
  }

  console.log(`内置自测通过：${assertions.length} 项。`);
}

main()
  .then(async () => {
    await exitAfterFlushing(0);
  })
  .catch(async (error) => {
    console.error(`失败：${error.message}`);
    await exitAfterFlushing(1);
  });

async function exitAfterFlushing(code) {
  await Promise.all([process.stdout, process.stderr].map(flushStream));
  await delay(100);
  process.exit(code);
}

function flushStream(stream) {
  if (!stream || stream.destroyed || typeof stream.write !== "function") return Promise.resolve();
  return new Promise((resolve) => stream.write("", resolve));
}
