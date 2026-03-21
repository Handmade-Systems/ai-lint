import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConfigLoader } from './config-loader.js'

describe('ConfigLoader', () => {
  const loader = new ConfigLoader()
  const testDataDir = path.resolve(import.meta.dirname, '../__test-data__')

  test('1. Load valid config — returns LinterConfig with all fields', () => {
    const config = loader.load(path.join(testDataDir, 'valid-config.yml'))

    expect(config).toMatchObject({
      provider: 'openrouter',
      model: 'haiku',
      concurrency: 5,
      git_base: 'main',
    })

    expect(config.rules).toHaveLength(2)
    expect(config.rules[0]).toMatchObject({
      id: 'no_console_log',
      name: 'No console.log in production code',
      severity: 'error',
      glob: 'src/**/*.ts',
      exclude: 'src/**/*.test.ts',
      prompt: expect.stringContaining('console.log'),
    })
    expect(config.rules[1]).toMatchObject({
      id: 'max_file_length',
      name: 'File should not exceed 300 lines',
      severity: 'warning',
      glob: 'src/**/*.{ts,tsx}',
      prompt: expect.stringContaining('300 lines'),
    })
  })

  test('2. Defaults applied — provider=openrouter, model=gemini-flash, concurrency=5, git_base=main when not specified', () => {
    // Create temporary config with minimal fields
    const tmpPath = path.join(testDataDir, 'minimal-config.yml')
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
`,
    )

    try {
      const config = loader.load(tmpPath)

      expect(config.provider).toBe('openrouter')
      expect(config.model).toBe('gemini-flash')
      expect(config.concurrency).toBe(5)
      expect(config.git_base).toBe('main')
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('3. Missing rules array — throws with clear error', () => {
    expect(() => loader.load(path.join(testDataDir, 'invalid-missing-rules.yml'))).toThrow(
      /must have required property 'rules'|is required/i,
    )
  })

  test('4. Duplicate rule IDs — throws error', () => {
    expect(() => loader.load(path.join(testDataDir, 'invalid-duplicate-ids.yml'))).toThrow(
      /Duplicate rule IDs found: no_console_log/,
    )
  })

  test('5. Invalid severity value — throws error', () => {
    expect(() => loader.load(path.join(testDataDir, 'invalid-severity.yml'))).toThrow(
      /must be equal to one of the allowed values|allowed values: error, warning/i,
    )
  })

  test('6. Missing required fields (id, name, prompt, glob, severity) — throws for each', () => {
    const tmpPath = path.join(testDataDir, 'missing-field.yml')

    // Missing id
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - name: "Test"
    severity: error
    glob: "**/*.ts"
    prompt: "Test"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/id.*is required/i)

    // Missing name
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: test_rule
    severity: error
    glob: "**/*.ts"
    prompt: "Test"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/name.*is required/i)

    // Missing severity
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: test_rule
    name: "Test"
    glob: "**/*.ts"
    prompt: "Test"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/severity.*is required/i)

    // Missing glob
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: test_rule
    name: "Test"
    severity: error
    prompt: "Test"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/glob.*is required/i)

    // Missing prompt
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: test_rule
    name: "Test"
    severity: error
    glob: "**/*.ts"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/prompt.*is required/i)

    fs.unlinkSync(tmpPath)
  })

  test('7. Invalid rule ID pattern (uppercase, spaces) — throws error', () => {
    const tmpPath = path.join(testDataDir, 'invalid-rule-id.yml')

    // Uppercase ID
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: NoConsoleLog
    name: "Test"
    severity: error
    glob: "**/*.ts"
    prompt: "Test"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/pattern|lowercase with underscores/i)

    // Space in ID
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: no console log
    name: "Test"
    severity: error
    glob: "**/*.ts"
    prompt: "Test"
`,
    )
    expect(() => loader.load(tmpPath)).toThrow(/pattern|lowercase with underscores/i)

    fs.unlinkSync(tmpPath)
  })

  test('8. Rule-level model override preserved after defaults merge', () => {
    const tmpPath = path.join(testDataDir, 'rule-model-override.yml')
    fs.writeFileSync(
      tmpPath,
      `
rules:
  - id: test_rule_haiku
    name: "Test Haiku"
    severity: error
    glob: "**/*.ts"
    prompt: "Test"
    model: haiku
  - id: test_rule_sonnet
    name: "Test Sonnet"
    severity: warning
    glob: "**/*.tsx"
    prompt: "Test"
    model: sonnet
`,
    )

    try {
      const config = loader.load(tmpPath)

      expect(config.model).toBe('gemini-flash') // default
      expect(config.rules[0].model).toBe('haiku')
      expect(config.rules[1].model).toBe('sonnet')
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('9. Empty rules array (minItems: 1) — throws error', () => {
    const tmpPath = path.join(testDataDir, 'empty-rules.yml')
    fs.writeFileSync(
      tmpPath,
      `
model: haiku
rules: []
`,
    )

    try {
      expect(() => loader.load(tmpPath)).toThrow(/must have at least 1 items/i)
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('10. Ollama provider with arbitrary model name accepted', () => {
    const config = loader.load(path.join(testDataDir, 'valid-ollama-config.yml'))

    expect(config.provider).toBe('ollama')
    expect(config.model).toBe('gpt-oss:20b')
    expect(config.provider_url).toBe('http://localhost:11434/v1')
    expect(config.concurrency).toBe(1)
  })

  test('11. Ollama without model — throws error', () => {
    const tmpPath = path.join(testDataDir, 'ollama-no-model.yml')
    fs.writeFileSync(
      tmpPath,
      `
provider: ollama
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
`,
    )

    try {
      expect(() => loader.load(tmpPath)).toThrow(/model.*is required when provider is ollama/i)
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('12. Ollama provider_url defaults to localhost', () => {
    const tmpPath = path.join(testDataDir, 'ollama-default-url.yml')
    fs.writeFileSync(
      tmpPath,
      `
provider: ollama
model: llama3:8b
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
`,
    )

    try {
      const config = loader.load(tmpPath)
      expect(config.provider_url).toBe('http://localhost:11434/v1')
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('13. OpenRouter rejects unknown model names', () => {
    const tmpPath = path.join(testDataDir, 'openrouter-bad-model.yml')
    fs.writeFileSync(
      tmpPath,
      `
model: llama3:8b
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
`,
    )

    try {
      expect(() => loader.load(tmpPath)).toThrow(/Unknown model.*openrouter/i)
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('15. claude-code provider accepted with default model', () => {
    const tmpPath = path.join(testDataDir, 'claude-code-config.yml')
    fs.writeFileSync(
      tmpPath,
      `
provider: claude-code
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
`,
    )

    try {
      const config = loader.load(tmpPath)
      expect(config.provider).toBe('claude-code')
      expect(config.model).toBe('gemini-flash') // default, ignored by claude-code
      expect(config.concurrency).toBe(1)
      expect(config.provider_url).toBeUndefined()
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('16. claude-code provider with explicit model', () => {
    const tmpPath = path.join(testDataDir, 'claude-code-model.yml')
    fs.writeFileSync(
      tmpPath,
      `
provider: claude-code
model: opus
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
`,
    )

    try {
      const config = loader.load(tmpPath)
      expect(config.provider).toBe('claude-code')
      expect(config.model).toBe('opus')
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('17. claude-code provider allows any model name (no validation)', () => {
    const tmpPath = path.join(testDataDir, 'claude-code-any-model.yml')
    fs.writeFileSync(
      tmpPath,
      `
provider: claude-code
model: claude-sonnet-4-6
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
    model: claude-opus-4-6
`,
    )

    try {
      const config = loader.load(tmpPath)
      expect(config.model).toBe('claude-sonnet-4-6')
      expect(config.rules[0].model).toBe('claude-opus-4-6')
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  test('14. Per-rule model validated for openrouter', () => {
    const tmpPath = path.join(testDataDir, 'openrouter-bad-rule-model.yml')
    fs.writeFileSync(
      tmpPath,
      `
model: haiku
rules:
  - id: test_rule
    name: "Test Rule"
    severity: error
    glob: "**/*.ts"
    prompt: "Test prompt"
    model: unknown-model
`,
    )

    try {
      expect(() => loader.load(tmpPath)).toThrow(/Unknown model.*rule.*openrouter/i)
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })
})
