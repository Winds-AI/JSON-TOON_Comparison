import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import dotenv from 'dotenv';

dotenv.config();

import {
  GoogleGenAI,
  type Content,
  type CountTokensResponse,
  type UsageMetadata,
  type GenerateContentResponse
} from '@google/genai';
import { encode as encodeToon } from '@byjohann/toon';

interface FormatMetrics {
  format: 'JSON' | 'TOON' | 'MARKDOWN';
  conversionMs: number;
  preflightTokenCount: number;
  apiLatencyMs: number;
  responsePromptTokenCount?: number;
  responseTotalTokenCount?: number;
  responseTextExcerpt: string;
  usageMetadata?: UsageMetadata;
  rawResponse: unknown;
}

interface ComparisonSummary {
  model: string;
  datasetPath: string;
  timestamp: string;
  formats: FormatMetrics[];
  deltas: {
    toonVsJson: {
      tokenSavings: number;
      tokenSavingsPercent: number;
      apiLatencyDeltaMs: number;
      conversionOverheadMs: number;
    };
    markdownVsJson: {
      tokenSavings: number;
      tokenSavingsPercent: number;
      apiLatencyDeltaMs: number;
      conversionOverheadMs: number;
    };
    markdownVsToon: {
      tokenSavings: number;
      tokenSavingsPercent: number;
      apiLatencyDeltaMs: number;
      conversionOverheadMs: number;
    };
  };
}

interface SeriesOptions {
  repeat: number;
  delayMs: number;
}

const MODEL_NAME = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

const DATA_PATH = path.resolve(process.cwd(), 'data/mock-analysis.json');
const REPORTS_DIR = path.resolve(process.cwd(), 'TJM_Reports');
const REQUEST_COOLDOWN_MS = 4_500;

const INSTRUCTIONS = `You are an analytics assistant. Evaluate the provided marketing performance dataset.
Summarize key trends, identify risks, and recommend the next two strategic experiments.
Keep the answer under 300 tokens and structure it with clear bullet points.`;

function jsonToMarkdown(data: unknown): string {
  if (data === null || data === undefined) {
    return String(data);
  }

  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return '';
    }

    // Check if array contains objects
    const firstItem = data[0];
    if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
      // Array of objects -> markdown table
      return arrayOfObjectsToTable(data as Record<string, unknown>[]);
    } else {
      // Array of primitives -> bullet list
      return data.map((item) => `- ${jsonToMarkdown(item)}`).join('\n');
    }
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    
    if (keys.length === 0) {
      return '';
    }

    const parts: string[] = [];
    
    for (const key of keys) {
      const value = obj[key];
      const formattedKey = formatKey(key);
      
      if (value === null || value === undefined) {
        parts.push(`**${formattedKey}:** ${String(value)}`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          parts.push(`**${formattedKey}:** (empty)`);
        } else if (typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0])) {
          // Array of objects -> table with heading
          parts.push(`\n### ${formattedKey}\n\n${arrayOfObjectsToTable(value as Record<string, unknown>[])}`);
        } else {
          // Array of primitives -> list with heading
          parts.push(`\n**${formattedKey}:**\n\n${value.map((item) => `- ${jsonToMarkdown(item)}`).join('\n')}`);
        }
      } else if (typeof value === 'object') {
        // Nested object -> section with heading
        parts.push(`\n### ${formattedKey}\n\n${jsonToMarkdown(value)}`);
      } else {
        // Primitive value -> key-value pair
        parts.push(`**${formattedKey}:** ${jsonToMarkdown(value)}`);
      }
    }
    
    return parts.join('\n\n');
  }

  return String(data);
}

function formatKey(key: string): string {
  // Convert camelCase to Title Case
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

function arrayOfObjectsToTable(items: Record<string, unknown>[]): string {
  if (items.length === 0) {
    return '';
  }

  // Collect all unique keys from all objects
  const allKeys = new Set<string>();
  items.forEach((item) => {
    Object.keys(item).forEach((key) => allKeys.add(key));
  });

  const headers = Array.from(allKeys);
  
  if (headers.length === 0) {
    return '';
  }

  // Format headers
  const headerRow = headers.map((h) => formatKey(h)).join(' | ');
  const separatorRow = headers.map(() => '---').join(' | ');

  // Format data rows
  const dataRows = items.map((item) => {
    return headers
      .map((key) => {
        const value = item[key];
        if (value === null || value === undefined) {
          return '';
        }
        if (typeof value === 'object' && !Array.isArray(value)) {
          // For nested objects, create a compact representation
          return Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => `${formatKey(k)}: ${jsonToMarkdown(v)}`)
            .join(', ');
        }
        if (Array.isArray(value)) {
          // For arrays, create a compact list
          return value.map((v) => jsonToMarkdown(v)).join(', ');
        }
        return String(value);
      })
      .join(' | ');
  });

  return `| ${headerRow} |\n| ${separatorRow} |\n${dataRows.map((row) => `| ${row} |`).join('\n')}`;
}

function buildContents(payloadLabel: string, serializedPayload: string): Content[] {
  return [
    {
      role: 'user',
      parts: [
        { text: INSTRUCTIONS },
        { text: `\nFormat: ${payloadLabel}\n---\n${serializedPayload}` }
      ]
    }
  ];
}

function measure<T>(fn: () => T): { value: T; elapsedMs: number } {
  const start = performance.now();
  const value = fn();
  const end = performance.now();
  return { value, elapsedMs: end - start };
}

async function measureAsync<T>(fn: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const start = performance.now();
  const value = await fn();
  const end = performance.now();
  return { value, elapsedMs: end - start };
}

function extractPreflightTokenCount(countResponse: CountTokensResponse | undefined): number {
  return countResponse?.totalTokens ?? 0;
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function getExcerpt(text: string | undefined, maxLength = 240): string {
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function parseCliArgs(argv: string[]): SeriesOptions {
  const repeatArg = argv.find((arg) => arg.startsWith('--repeat='));
  const delayArg = argv.find((arg) => arg.startsWith('--delayMs='));

  const repeat = repeatArg ? Math.max(1, Number(repeatArg.split('=')[1])) : 1;
  const delayMs = delayArg ? Math.max(0, Number(delayArg.split('=')[1])) : 20_000;

  return { repeat, delayMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextAvailableRequestTime = 0;

async function withRateLimit<T>(task: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (now < nextAvailableRequestTime) {
    await sleep(nextAvailableRequestTime - now);
  }
  const result = await task();
  nextAvailableRequestTime = Date.now() + REQUEST_COOLDOWN_MS;
  return result;
}

async function runOnce(): Promise<ComparisonSummary> {
  const raw = await readFile(DATA_PATH, 'utf-8');
  const dataset = JSON.parse(raw);

  const jsonMeasurement = measure(() => JSON.stringify(dataset, null, 2));
  const { value: jsonPayload, elapsedMs: jsonConversionMs } = jsonMeasurement;

  const { value: toonPayload, elapsedMs: toonConversionMs } = measure(() => encodeToon(dataset));

  const { value: markdownPayload, elapsedMs: markdownConversionMs } = measure(() => jsonToMarkdown(dataset));

  const jsonContents = buildContents('JSON', jsonPayload);
  const toonContents = buildContents('TOON', toonPayload);
  const markdownContents = buildContents('MARKDOWN', markdownPayload);

  const [jsonMetrics, toonMetrics, markdownMetrics] = await Promise.all([
    analyzeFormat('JSON', jsonContents, jsonConversionMs),
    analyzeFormat('TOON', toonContents, toonConversionMs),
    analyzeFormat('MARKDOWN', markdownContents, markdownConversionMs)
  ]);

  const deltas = computeDeltas(jsonMetrics, toonMetrics, markdownMetrics);

  emitReport(jsonMetrics, toonMetrics, markdownMetrics, deltas);

  const timestamp = new Date().toISOString();

  const summary: ComparisonSummary = {
    model: MODEL_NAME,
    datasetPath: DATA_PATH,
    timestamp,
    formats: [jsonMetrics, toonMetrics, markdownMetrics],
    deltas
  };

  console.log('\nStructured summary:');
  console.dir(loggableSummary(summary), { depth: null, colors: true });

  await persistMarkdownReport(summary);
  await persistRawResponses(summary);

  return summary;
}

async function analyzeFormat(
  format: 'JSON' | 'TOON' | 'MARKDOWN',
  contents: Content[],
  conversionMs: number
): Promise<FormatMetrics> {
  const countResponse = await withRateLimit(() =>
    ai.models.countTokens({
      model: MODEL_NAME,
      contents
    })
  );

  const preflightTokenCount = extractPreflightTokenCount(countResponse);

  const { value: response, elapsedMs: apiLatencyMs } = await measureAsync<GenerateContentResponse>(() =>
    withRateLimit(() =>
      ai.models.generateContent({
        model: MODEL_NAME,
        contents,
        config: {
          temperature: 0.2,
          topP: 0.8
        }
      })
    )
  );

  const responseText = response.text;
  const usageMetadata = response.usageMetadata ?? undefined;
  const rawResponse = captureRawResponse(response);

  return {
    format,
    conversionMs,
    preflightTokenCount,
    apiLatencyMs,
    responsePromptTokenCount: usageMetadata?.promptTokenCount,
    responseTotalTokenCount: usageMetadata?.totalTokenCount,
    responseTextExcerpt: getExcerpt(responseText),
    usageMetadata,
    rawResponse
  };
}

function computeDeltas(
  jsonMetrics: FormatMetrics,
  toonMetrics: FormatMetrics,
  markdownMetrics: FormatMetrics
) {
  const toonVsJson = {
    tokenSavings: jsonMetrics.preflightTokenCount - toonMetrics.preflightTokenCount,
    tokenSavingsPercent: jsonMetrics.preflightTokenCount
      ? ((jsonMetrics.preflightTokenCount - toonMetrics.preflightTokenCount) / jsonMetrics.preflightTokenCount) * 100
      : 0,
    apiLatencyDeltaMs: jsonMetrics.apiLatencyMs - toonMetrics.apiLatencyMs,
    conversionOverheadMs: toonMetrics.conversionMs - jsonMetrics.conversionMs
  };

  const markdownVsJson = {
    tokenSavings: jsonMetrics.preflightTokenCount - markdownMetrics.preflightTokenCount,
    tokenSavingsPercent: jsonMetrics.preflightTokenCount
      ? ((jsonMetrics.preflightTokenCount - markdownMetrics.preflightTokenCount) / jsonMetrics.preflightTokenCount) * 100
      : 0,
    apiLatencyDeltaMs: jsonMetrics.apiLatencyMs - markdownMetrics.apiLatencyMs,
    conversionOverheadMs: markdownMetrics.conversionMs - jsonMetrics.conversionMs
  };

  const markdownVsToon = {
    tokenSavings: toonMetrics.preflightTokenCount - markdownMetrics.preflightTokenCount,
    tokenSavingsPercent: toonMetrics.preflightTokenCount
      ? ((toonMetrics.preflightTokenCount - markdownMetrics.preflightTokenCount) / toonMetrics.preflightTokenCount) * 100
      : 0,
    apiLatencyDeltaMs: toonMetrics.apiLatencyMs - markdownMetrics.apiLatencyMs,
    conversionOverheadMs: markdownMetrics.conversionMs - toonMetrics.conversionMs
  };

  return {
    toonVsJson,
    markdownVsJson,
    markdownVsToon
  };
}

function emitReport(
  jsonMetrics: FormatMetrics,
  toonMetrics: FormatMetrics,
  markdownMetrics: FormatMetrics,
  deltas: ReturnType<typeof computeDeltas>
) {
  console.log('--- Gemini Prompt Efficiency Benchmark ---');
  console.log(`Model: ${MODEL_NAME}`);
  console.log(`Dataset: ${DATA_PATH}`);

  console.log('\nToken counts (prompt):');
  console.table([
    {
      format: jsonMetrics.format,
      preflightTokens: jsonMetrics.preflightTokenCount,
      responsePromptTokens: jsonMetrics.responsePromptTokenCount ?? 'n/a',
      responseTotalTokens: jsonMetrics.responseTotalTokenCount ?? 'n/a',
      conversionMs: formatMs(jsonMetrics.conversionMs),
      apiLatencyMs: formatMs(jsonMetrics.apiLatencyMs)
    },
    {
      format: toonMetrics.format,
      preflightTokens: toonMetrics.preflightTokenCount,
      responsePromptTokens: toonMetrics.responsePromptTokenCount ?? 'n/a',
      responseTotalTokens: toonMetrics.responseTotalTokenCount ?? 'n/a',
      conversionMs: formatMs(toonMetrics.conversionMs),
      apiLatencyMs: formatMs(toonMetrics.apiLatencyMs)
    },
    {
      format: markdownMetrics.format,
      preflightTokens: markdownMetrics.preflightTokenCount,
      responsePromptTokens: markdownMetrics.responsePromptTokenCount ?? 'n/a',
      responseTotalTokens: markdownMetrics.responseTotalTokenCount ?? 'n/a',
      conversionMs: formatMs(markdownMetrics.conversionMs),
      apiLatencyMs: formatMs(markdownMetrics.apiLatencyMs)
    }
  ]);

  console.log('\nToken savings comparisons:');
  console.log(`  TOON vs JSON: ${deltas.toonVsJson.tokenSavings} tokens (${deltas.toonVsJson.tokenSavingsPercent.toFixed(2)}%)`);
  console.log(`  MARKDOWN vs JSON: ${deltas.markdownVsJson.tokenSavings} tokens (${deltas.markdownVsJson.tokenSavingsPercent.toFixed(2)}%)`);
  console.log(`  MARKDOWN vs TOON: ${deltas.markdownVsToon.tokenSavings} tokens (${deltas.markdownVsToon.tokenSavingsPercent.toFixed(2)}%)`);

  console.log('\nLatency comparisons:');
  console.log(`  API latency delta (JSON - TOON): ${formatMs(deltas.toonVsJson.apiLatencyDeltaMs)}`);
  console.log(`  API latency delta (JSON - MARKDOWN): ${formatMs(deltas.markdownVsJson.apiLatencyDeltaMs)}`);
  console.log(`  API latency delta (TOON - MARKDOWN): ${formatMs(deltas.markdownVsToon.apiLatencyDeltaMs)}`);

  console.log('\nConversion overhead:');
  console.log(`  TOON conversion overhead: ${formatMs(deltas.toonVsJson.conversionOverheadMs)}`);
  console.log(`  MARKDOWN conversion overhead: ${formatMs(deltas.markdownVsJson.conversionOverheadMs)}`);

  console.log('\nResponse excerpts:');
  console.log(`  JSON: ${jsonMetrics.responseTextExcerpt}`);
  console.log(`  TOON: ${toonMetrics.responseTextExcerpt}`);
  console.log(`  MARKDOWN: ${markdownMetrics.responseTextExcerpt}`);
}

async function main(): Promise<void> {
  const { repeat, delayMs } = parseCliArgs(process.argv.slice(2));
  const summaries: ComparisonSummary[] = [];

  console.log(`Planned runs: ${repeat}. Delay between runs: ${formatMs(delayMs)}.`);

  for (let index = 0; index < repeat; index += 1) {
    console.log(`\n=== Benchmark run ${index + 1} of ${repeat} ===`);
    const summary = await runOnce();
    summaries.push(summary);

    if (index < repeat - 1) {
      console.log(`Waiting ${formatMs(delayMs)} before next run to respect rate limits...`);
      await sleep(delayMs);
    }
  }

  if (summaries.length > 1) {
    printAverageMetrics(summaries);
  }
}

main().catch((error) => {
  console.error('Benchmark series failed:', error);
  process.exitCode = 1;
});

async function persistMarkdownReport(summary: ComparisonSummary): Promise<void> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const baseName = baseFilename(summary.timestamp);
  const reportPath = path.join(REPORTS_DIR, `${baseName}.md`);
  const markdown = generateMarkdownReport(summary);
  await writeFile(reportPath, markdown, 'utf-8');
  console.log(`\nMarkdown report saved to ${reportPath}`);
}

function generateMarkdownReport(summary: ComparisonSummary): string {
  const jsonMetrics = summary.formats.find((f) => f.format === 'JSON')!;
  const toonMetrics = summary.formats.find((f) => f.format === 'TOON')!;
  const markdownMetrics = summary.formats.find((f) => f.format === 'MARKDOWN')!;
  
  const { toonVsJson, markdownVsJson, markdownVsToon } = summary.deltas;

  const rows = summary.formats
    .map((metrics) =>
      [
        metrics.format,
        metrics.preflightTokenCount.toLocaleString(),
        metrics.responsePromptTokenCount?.toLocaleString() ?? 'n/a',
        metrics.responseTotalTokenCount?.toLocaleString() ?? 'n/a',
        formatMs(metrics.conversionMs),
        formatMs(metrics.apiLatencyMs)
      ].join(' | ')
    )
    .join('\n');

  return `# Gemini Benchmark Report

- **Model used:** ${summary.model}
- **Dataset:** ${path.relative(process.cwd(), summary.datasetPath)}
- **Run timestamp:** ${summary.timestamp}

## Executive Summary

### Token Efficiency
- TOON vs JSON: ${toonVsJson.tokenSavings > 0 ? 'TOON' : 'JSON'} saved ${Math.abs(toonVsJson.tokenSavings).toLocaleString()} tokens (${toonVsJson.tokenSavingsPercent.toFixed(1)}%)
- MARKDOWN vs JSON: ${markdownVsJson.tokenSavings > 0 ? 'MARKDOWN' : 'JSON'} saved ${Math.abs(markdownVsJson.tokenSavings).toLocaleString()} tokens (${markdownVsJson.tokenSavingsPercent.toFixed(1)}%)
- MARKDOWN vs TOON: ${markdownVsToon.tokenSavings > 0 ? 'MARKDOWN' : 'TOON'} saved ${Math.abs(markdownVsToon.tokenSavings).toLocaleString()} tokens (${markdownVsToon.tokenSavingsPercent.toFixed(1)}%)

### Latency
- Fastest format: ${getFastestFormat(jsonMetrics, toonMetrics, markdownMetrics)}
- TOON conversion overhead: ${formatMs(toonVsJson.conversionOverheadMs)}
- MARKDOWN conversion overhead: ${formatMs(markdownVsJson.conversionOverheadMs)}

## Detailed Metrics

Format | Input tokens sent | Prompt tokens in response | Total tokens in response | Data prep time | Gemini response time
--- | --- | --- | --- | --- | ---
${rows}

## Response Highlights

### JSON input
${formatExcerpt(jsonMetrics.responseTextExcerpt)}

### TOON input
${formatExcerpt(toonMetrics.responseTextExcerpt)}

### MARKDOWN input
${formatExcerpt(markdownMetrics.responseTextExcerpt)}

## Metric Definitions

- **Input tokens sent**: Tokens counted before calling Gemini (via the Count Tokens API).
- **Prompt tokens in response**: Tokens Gemini reports as used from the request after processing.
- **Total tokens in response**: Combined prompt and output token count reported by Gemini.
- **Data prep time**: Time spent preparing the payload (JSON formatting, TOON encoding, or Markdown conversion).
- **Gemini response time**: End-to-end latency for \`models.generateContent\`.
- **Response highlights**: A short excerpt of Gemini's answer to compare tone and content.

`;
}

function getFastestFormat(
  jsonMetrics: FormatMetrics,
  toonMetrics: FormatMetrics,
  markdownMetrics: FormatMetrics
): string {
  const latencies = [
    { format: 'JSON', latency: jsonMetrics.apiLatencyMs },
    { format: 'TOON', latency: toonMetrics.apiLatencyMs },
    { format: 'MARKDOWN', latency: markdownMetrics.apiLatencyMs }
  ];
  latencies.sort((a, b) => a.latency - b.latency);
  return latencies[0].format;
}

function metricsSentence(tokenSavings: number, savingsPercent: string): string {
  if (tokenSavings === 0) return 'Both formats used the same number of input tokens.';
  const winner = tokenSavings > 0 ? 'TOON' : 'JSON';
  return `${winner} reduced input tokens by ${Math.abs(tokenSavings).toLocaleString()} (${savingsPercent}) compared with the other format.`;
}

function latencySentence(fasterFormat: 'JSON' | 'TOON', slowerFormat: 'JSON' | 'TOON', latencyDeltaMs: number): string {
  if (latencyDeltaMs < 1) return 'Both formats returned responses in roughly the same time.';
  return `${fasterFormat} responses arrived approximately ${formatMs(latencyDeltaMs)} faster than ${slowerFormat}.`;
}

function formatExcerpt(excerpt: string): string {
  if (!excerpt) return '_No response text captured._';
  return excerpt.startsWith('```') ? excerpt : `> ${excerpt}`;
}

function printAverageMetrics(summaries: ComparisonSummary[]): void {
  const totals = summaries.reduce(
    (acc, summary) => {
      summary.formats.forEach((formatMetrics) => {
        const key = formatMetrics.format;
        const existing = acc.formatTotals.get(key) ?? {
          preflightTokenCount: 0,
          apiLatencyMs: 0,
          conversionMs: 0,
          responsePromptTokenCount: 0,
          responseTotalTokenCount: 0,
          count: 0
        };

        existing.preflightTokenCount += formatMetrics.preflightTokenCount;
        existing.apiLatencyMs += formatMetrics.apiLatencyMs;
        existing.conversionMs += formatMetrics.conversionMs;
        existing.responsePromptTokenCount += formatMetrics.responsePromptTokenCount ?? 0;
        existing.responseTotalTokenCount += formatMetrics.responseTotalTokenCount ?? 0;
        existing.count += 1;

        acc.formatTotals.set(key, existing);
      });

      acc.toonVsJson.tokenSavings += summary.deltas.toonVsJson.tokenSavings;
      acc.toonVsJson.tokenSavingsPercent += summary.deltas.toonVsJson.tokenSavingsPercent;
      acc.toonVsJson.apiLatencyDeltaMs += summary.deltas.toonVsJson.apiLatencyDeltaMs;
      acc.toonVsJson.conversionOverheadMs += summary.deltas.toonVsJson.conversionOverheadMs;

      acc.markdownVsJson.tokenSavings += summary.deltas.markdownVsJson.tokenSavings;
      acc.markdownVsJson.tokenSavingsPercent += summary.deltas.markdownVsJson.tokenSavingsPercent;
      acc.markdownVsJson.apiLatencyDeltaMs += summary.deltas.markdownVsJson.apiLatencyDeltaMs;
      acc.markdownVsJson.conversionOverheadMs += summary.deltas.markdownVsJson.conversionOverheadMs;

      acc.markdownVsToon.tokenSavings += summary.deltas.markdownVsToon.tokenSavings;
      acc.markdownVsToon.tokenSavingsPercent += summary.deltas.markdownVsToon.tokenSavingsPercent;
      acc.markdownVsToon.apiLatencyDeltaMs += summary.deltas.markdownVsToon.apiLatencyDeltaMs;
      acc.markdownVsToon.conversionOverheadMs += summary.deltas.markdownVsToon.conversionOverheadMs;

      return acc;
    },
    {
      formatTotals: new Map<string, {
        preflightTokenCount: number;
        apiLatencyMs: number;
        conversionMs: number;
        responsePromptTokenCount: number;
        responseTotalTokenCount: number;
        count: number;
      }>(),
      toonVsJson: {
        tokenSavings: 0,
        tokenSavingsPercent: 0,
        apiLatencyDeltaMs: 0,
        conversionOverheadMs: 0
      },
      markdownVsJson: {
        tokenSavings: 0,
        tokenSavingsPercent: 0,
        apiLatencyDeltaMs: 0,
        conversionOverheadMs: 0
      },
      markdownVsToon: {
        tokenSavings: 0,
        tokenSavingsPercent: 0,
        apiLatencyDeltaMs: 0,
        conversionOverheadMs: 0
      }
    }
  );

  console.log('\n=== Average across runs ===');

  totals.formatTotals.forEach((metrics, format) => {
    const count = metrics.count || 1;
    console.log(`\n${format} averages over ${count} runs:`);
    console.log(`  Input tokens sent: ${(metrics.preflightTokenCount / count).toFixed(1)}`);
    console.log(`  Gemini response time: ${formatMs(metrics.apiLatencyMs / count)}`);
    console.log(`  Data prep time: ${formatMs(metrics.conversionMs / count)}`);
    if (metrics.responsePromptTokenCount) {
      console.log(`  Prompt tokens in response: ${(metrics.responsePromptTokenCount / count).toFixed(1)}`);
    }
    if (metrics.responseTotalTokenCount) {
      console.log(`  Total tokens in response: ${(metrics.responseTotalTokenCount / count).toFixed(1)}`);
    }
  });

  const runCount = summaries.length || 1;
  console.log('\nOverall deltas:');
  console.log('\nTOON vs JSON:');
  console.log(`  Token savings: ${(totals.toonVsJson.tokenSavings / runCount).toFixed(1)}`);
  console.log(`  Token savings percent: ${(totals.toonVsJson.tokenSavingsPercent / runCount).toFixed(2)}%`);
  console.log(`  API latency delta (JSON - TOON): ${formatMs(totals.toonVsJson.apiLatencyDeltaMs / runCount)}`);
  console.log(`  Conversion overhead (TOON - JSON): ${formatMs(totals.toonVsJson.conversionOverheadMs / runCount)}`);
  
  console.log('\nMARKDOWN vs JSON:');
  console.log(`  Token savings: ${(totals.markdownVsJson.tokenSavings / runCount).toFixed(1)}`);
  console.log(`  Token savings percent: ${(totals.markdownVsJson.tokenSavingsPercent / runCount).toFixed(2)}%`);
  console.log(`  API latency delta (JSON - MARKDOWN): ${formatMs(totals.markdownVsJson.apiLatencyDeltaMs / runCount)}`);
  console.log(`  Conversion overhead (MARKDOWN - JSON): ${formatMs(totals.markdownVsJson.conversionOverheadMs / runCount)}`);
  
  console.log('\nMARKDOWN vs TOON:');
  console.log(`  Token savings: ${(totals.markdownVsToon.tokenSavings / runCount).toFixed(1)}`);
  console.log(`  Token savings percent: ${(totals.markdownVsToon.tokenSavingsPercent / runCount).toFixed(2)}%`);
  console.log(`  API latency delta (TOON - MARKDOWN): ${formatMs(totals.markdownVsToon.apiLatencyDeltaMs / runCount)}`);
  console.log(`  Conversion overhead (MARKDOWN - TOON): ${formatMs(totals.markdownVsToon.conversionOverheadMs / runCount)}`);
}

async function persistRawResponses(summary: ComparisonSummary): Promise<void> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const baseName = baseFilename(summary.timestamp);

  await Promise.all(
    summary.formats.map(async (metrics) => {
      const responsePath = path.join(REPORTS_DIR, `${baseName}-${metrics.format.toLowerCase()}-response.json`);
      const payload = metrics.rawResponse ?? null;
      await writeFile(responsePath, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`Raw ${metrics.format} response saved to ${responsePath}`);
    })
  );
}

function baseFilename(timestamp: string): string {
  return `benchmark-${filenameSafeTimestamp(timestamp)}`;
}

function filenameSafeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, '-');
}

function captureRawResponse(response: GenerateContentResponse): unknown {
  try {
    return JSON.parse(JSON.stringify(response));
  } catch (error) {
    return { error: 'Failed to serialize response', message: `${error}` };
  }
}

function loggableSummary(summary: ComparisonSummary) {
  return {
    ...summary,
    formats: summary.formats.map(({ rawResponse, ...rest }) => rest)
  };
}
