import type { CacheManager } from './cache-manager.js'
import { LinterEngine } from './linter-engine.js'
import { createEmptySummary, suppressConsoleOutput, writeReportOnlyReport } from './report-only.js'
import type { RuleMatcher } from './rule-matcher.js'
import type { LintClient, LinterConfig } from './types.js'

interface ReportOnlyRunnerDeps {
  cache: CacheManager
  client: LintClient
  matcher: RuleMatcher
}

interface ReportOnlyRunInput {
  filesToLint: string[]
  config: LinterConfig
  reportFile: string
  deps: ReportOnlyRunnerDeps
  log?: (message: string) => void
}

export async function runReportOnlyLint({
  filesToLint,
  config,
  reportFile,
  deps,
  log = console.log,
}: ReportOnlyRunInput): Promise<number> {
  const restoreConsole = suppressConsoleOutput()

  try {
    if (filesToLint.length === 0) {
      const reportPath = writeReportOnlyReport(reportFile, {
        results: [],
        summary: createEmptySummary(),
        exitCode: 0,
      })
      restoreConsole()
      log(`Report written: ${reportPath}`)
      return 0
    }

    const engine = new LinterEngine({
      cache: deps.cache,
      client: deps.client,
      matcher: deps.matcher,
      reporter: { report: () => {} },
    })

    const { exitCode, results, summary } = await engine.run(filesToLint, config)
    const reportPath = writeReportOnlyReport(reportFile, { results, summary, exitCode })

    restoreConsole()
    log(`Report written: ${reportPath}`)
    return exitCode
  } catch (error) {
    const reportPath = writeReportOnlyReport(reportFile, {
      results: [],
      summary: createEmptySummary(),
      exitCode: 2,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    })
    restoreConsole()
    log(`Report written: ${reportPath}`)
    return 2
  }
}
