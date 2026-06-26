import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderHtmlReport } from './html-report.js';
import { renderMarkdownReport } from './report.js';
import type { BacktestRun } from './run.js';

export type WrittenReport = { readonly markdownPath: string; readonly htmlPath: string };

/**
 * Write the markdown and self-contained HTML report into outDir (created if needed),
 * the deliverable artifact for docs/BUILD_PLAN.md M5. Both renders are deterministic, so
 * re-running over the same window overwrites with byte-identical files.
 */
export const writeReportFiles = async (
  outDir: string,
  run: BacktestRun,
): Promise<WrittenReport> => {
  await mkdir(outDir, { recursive: true });
  const markdownPath = join(outDir, 'report.md');
  const htmlPath = join(outDir, 'report.html');
  await writeFile(markdownPath, renderMarkdownReport(run), 'utf8');
  await writeFile(htmlPath, renderHtmlReport(run), 'utf8');
  return { markdownPath, htmlPath };
};
