import { execFile } from 'node:child_process'
import type { LintJob, LintResult } from './types.js'

const SYSTEM_PROMPT = `You are a code linter. You will be given a file path and a lint rule.
- Read ONLY the target file and, if needed, its direct imports to understand types and method signatures.
- Do NOT explore the broader codebase, run searches, or read unrelated files.
- Focus exclusively on evaluating the target file against the given rule.
- If the file complies, set pass=true and confirm briefly.
- If it violates the rule, set pass=false, describe the violation in 1-3 sentences, and set line to the approximate line number of the first violation.
- Always respond with the structured JSON output only.`

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    message: { type: 'string' },
    line: { type: ['number', 'null'] },
  },
  required: ['pass', 'message', 'line'],
})

interface ClaudeCodeResponse {
  structured_output?: {
    pass: boolean
    message: string
    line: number | null
  }
  result?: string
  session_id?: string
}

export class ClaudeCodeClient {
  private model?: string

  constructor(options?: { model?: string }) {
    this.model = options?.model
  }

  async lint(job: LintJob): Promise<LintResult> {
    const startTime = Date.now()

    const userMessage = `## Rule: ${job.rule.name}
${job.rule.prompt}

## File to check: ${job.filePath}

Read this file and evaluate it against the rule above. Only read direct imports if needed to understand method signatures.`

    try {
      const response = await this.runClaude(userMessage, job.rule.model)
      const durationMs = Date.now() - startTime

      return {
        rule_id: job.rule.id,
        rule_name: job.rule.name,
        file: job.filePath,
        severity: job.rule.severity,
        pass: response.pass,
        message: response.message,
        line: response.line ?? undefined,
        duration_ms: durationMs,
        cached: false,
      }
    } catch (error) {
      const durationMs = Date.now() - startTime

      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error(
          'Claude Code CLI not found. Install it from https://code.claude.com and ensure "claude" is in your PATH.',
        )
      }

      return {
        rule_id: job.rule.id,
        rule_name: job.rule.name,
        file: job.filePath,
        severity: job.rule.severity,
        pass: false,
        message: `Claude Code CLI error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        duration_ms: durationMs,
        cached: false,
        api_error: true,
      }
    }
  }

  private runClaude(
    prompt: string,
    ruleModel?: string,
  ): Promise<{ pass: boolean; message: string; line: number | null }> {
    return new Promise((resolve, reject) => {
      const model = ruleModel ?? this.model
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--json-schema',
        JSON_SCHEMA,
        '--system-prompt',
        SYSTEM_PROMPT,
        '--max-turns',
        '10',
        '--tools',
        'Read',
      ]

      if (model) {
        args.push('--model', model)
      }

      const env = { ...process.env }
      delete env.CLAUDECODE

      const child = execFile(
        'claude',
        args,
        { maxBuffer: 10 * 1024 * 1024, env },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message))
            return
          }

          try {
            const parsed: ClaudeCodeResponse = JSON.parse(stdout)

            if (parsed.structured_output) {
              resolve(parsed.structured_output)
              return
            }

            // Fallback: try to parse the result field as JSON
            if (parsed.result) {
              try {
                const resultParsed = JSON.parse(parsed.result)
                if (
                  typeof resultParsed.pass === 'boolean' &&
                  typeof resultParsed.message === 'string'
                ) {
                  resolve({
                    pass: resultParsed.pass,
                    message: resultParsed.message,
                    line: resultParsed.line ?? null,
                  })
                  return
                }
              } catch {
                // result is not JSON, fall through
              }
            }

            reject(new Error('Claude Code returned no structured output'))
          } catch {
            reject(new Error(`Failed to parse Claude Code output: ${stdout.slice(0, 200)}`))
          }
        },
      )

      child.stdin?.end()
    })
  }
}
