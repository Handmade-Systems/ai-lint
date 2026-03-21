import { readFileSync } from 'node:fs'
import pLimit from 'p-limit'
import { CacheManager } from './cache-manager.js'
import type { RuleMatcher } from './rule-matcher.js'
import type { LintClient, LinterConfig, LintJob, LintResult, LintSummary } from './types.js'

export interface Reporter {
  report(results: LintResult[], summary: LintSummary): void
}

export type ProgressCallback = (
  completed: number,
  total: number,
  job: LintJob,
  cached: boolean,
) => void

interface LinterEngineDeps {
  cache: CacheManager
  client: LintClient
  matcher: RuleMatcher
  reporter: Reporter
  onProgress?: ProgressCallback
}

export class LinterEngine {
  constructor(private deps: LinterEngineDeps) {}

  async run(
    filePaths: string[],
    config: LinterConfig,
  ): Promise<{ results: LintResult[]; summary: LintSummary; exitCode: number }> {
    const startTime = Date.now()

    // Load cache from disk
    this.deps.cache.load()

    // Create jobs for all (file, rule) combinations
    const jobs: LintJob[] = []
    const uniqueFiles = new Set<string>()

    for (const filePath of filePaths) {
      const matchingRules = this.deps.matcher.matchFile(filePath)

      // Skip files with no matching rules
      if (matchingRules.length === 0) {
        continue
      }

      uniqueFiles.add(filePath)

      // Read file content once for all rules
      const fileContent = readFileSync(filePath, 'utf-8')
      const fileHash = CacheManager.hash(fileContent)

      // Create a job for each matching rule
      for (const rule of matchingRules) {
        const promptHash = CacheManager.hash(rule.prompt)

        jobs.push({
          rule,
          filePath,
          fileContent,
          fileHash,
          promptHash,
        })
      }
    }

    // Separate jobs into cached and uncached
    const cachedResults: LintResult[] = []
    const uncachedJobs: LintJob[] = []
    const totalJobs = jobs.length
    let completedJobs = 0

    for (const job of jobs) {
      const cachedResult = this.deps.cache.lookup(
        job.rule.id,
        job.filePath,
        job.fileHash,
        job.promptHash,
      )

      if (cachedResult) {
        cachedResults.push({ ...cachedResult, cached: true })
        completedJobs++
        this.deps.onProgress?.(completedJobs, totalJobs, job, true)
      } else {
        uncachedJobs.push(job)
      }
    }

    // Run uncached jobs in parallel with concurrency limit
    const limit = pLimit(config.concurrency)
    const lintPromises = uncachedJobs.map((job) =>
      limit(async () => {
        const result = await this.deps.client.lint(job)
        // Store result in cache
        this.deps.cache.store(job.rule.id, job.filePath, job.fileHash, job.promptHash, result)
        completedJobs++
        this.deps.onProgress?.(completedJobs, totalJobs, job, false)
        return result
      }),
    )

    const uncachedResults = await Promise.all(lintPromises)

    // Combine all results
    const allResults = [...cachedResults, ...uncachedResults]

    // Save cache to disk
    this.deps.cache.save()

    // Compute summary
    const durationMs = Date.now() - startTime
    const summary = this.computeSummary(allResults, uniqueFiles.size, durationMs)

    // Report results
    this.deps.reporter.report(allResults, summary)

    // Determine exit code (1 if any errors or API failures, 0 otherwise)
    const hasApiErrors = allResults.some((r) => r.api_error)
    const exitCode = summary.errors > 0 || hasApiErrors ? 1 : 0

    return { results: allResults, summary, exitCode }
  }

  private computeSummary(
    results: LintResult[],
    totalFiles: number,
    durationMs: number,
  ): LintSummary {
    let passed = 0
    let errors = 0
    let warnings = 0
    let cached = 0

    for (const result of results) {
      if (result.pass) {
        passed++
      } else if (result.severity === 'error') {
        errors++
      } else {
        warnings++
      }

      if (result.cached) {
        cached++
      }
    }

    return {
      total_files: totalFiles,
      total_rules_applied: results.length,
      passed,
      errors,
      warnings,
      cached,
      duration_ms: durationMs,
    }
  }
}
