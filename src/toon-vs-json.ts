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
  format: 'JSON' | 'TOON';
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
    tokenSavings: number;
    tokenSavingsPercent: number;
    apiLatencyDeltaMs: number;
    conversionOverheadMs: number;
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
const REPORTS_DIR = path.resolve(process.cwd(), 'reports');
const REQUEST_COOLDOWN_MS = 4_500;

const INSTRUCTIONS = `You are an analytics assistant. Evaluate the provided marketing performance dataset.
Summarize key trends, identify risks, and recommend the next two strategic experiments.
Keep the answer under 300 tokens and structure it with clear bullet points.`;

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

  const jsonContents = buildContents('JSON', jsonPayload);
  const toonContents = buildContents('TOON', toonPayload);

  const [jsonMetrics, toonMetrics] = await Promise.all([
    analyzeFormat('JSON', jsonContents, jsonConversionMs),
    analyzeFormat('TOON', toonContents, toonConversionMs)
  ]);

  const deltas = computeDeltas(jsonMetrics, toonMetrics);

  emitReport(jsonMetrics, toonMetrics, deltas);

  const timestamp = new Date().toISOString();

  const summary: ComparisonSummary = {
    model: MODEL_NAME,
    datasetPath: DATA_PATH,
    timestamp,
    formats: [jsonMetrics, toonMetrics],
    deltas
  };

  console.log('\nStructured summary:');
  console.dir(loggableSummary(summary), { depth: null, colors: true });

  await persistMarkdownReport(summary);
  await persistRawResponses(summary);

  return summary;
}

async function analyzeFormat(
  format: 'JSON' | 'TOON',
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

  const { value: response, elapsedMs: apiLatencyMs } = await measureAsync(() =>
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

function computeDeltas(jsonMetrics: FormatMetrics, toonMetrics: FormatMetrics) {
  const tokenSavings = jsonMetrics.preflightTokenCount - toonMetrics.preflightTokenCount;
  const tokenSavingsPercent = jsonMetrics.preflightTokenCount
    ? (tokenSavings / jsonMetrics.preflightTokenCount) * 100
    : 0;

  return {
    tokenSavings,
    tokenSavingsPercent,
    apiLatencyDeltaMs: jsonMetrics.apiLatencyMs - toonMetrics.apiLatencyMs,
    conversionOverheadMs: toonMetrics.conversionMs - jsonMetrics.conversionMs
  };
}

function emitReport(
  jsonMetrics: FormatMetrics,
  toonMetrics: FormatMetrics,
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
    }
  ]);

  console.log('\nToken savings vs JSON:');
  console.log(`  Absolute: ${deltas.tokenSavings} tokens`);
  console.log(`  Percent: ${deltas.tokenSavingsPercent.toFixed(2)}%`);

  console.log('\nLatency comparison:');
  console.log(`  API latency delta (JSON - TOON): ${formatMs(deltas.apiLatencyDeltaMs)}`);
  console.log(`  Conversion overhead (TOON - JSON): ${formatMs(deltas.conversionOverheadMs)}`);

  console.log('\nResponse excerpts:');
  console.log(`  JSON: ${jsonMetrics.responseTextExcerpt}`);
  console.log(`  TOON: ${toonMetrics.responseTextExcerpt}`);
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
  const [jsonMetrics, toonMetrics] = summary.formats;
  const { tokenSavings, tokenSavingsPercent, apiLatencyDeltaMs, conversionOverheadMs } = summary.deltas;

  const humanTokenSavingsPercent = `${tokenSavingsPercent.toFixed(1)}%`;
  const fasterFormat = apiLatencyDeltaMs > 0 ? 'TOON' : 'JSON';
  const slowerFormat = fasterFormat === 'TOON' ? 'JSON' : 'TOON';
  const latencyDeltaMs = Math.abs(apiLatencyDeltaMs);

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

- ${metricsSentence(tokenSavings, humanTokenSavingsPercent)}
- ${latencySentence(fasterFormat, slowerFormat, latencyDeltaMs)}
- TOON conversion added ${formatMs(conversionOverheadMs)} of preprocessing time.

## Detailed Metrics

Format | Input tokens sent | Prompt tokens in response | Total tokens in response | Data prep time | Gemini response time
--- | --- | --- | --- | --- | ---
${rows}

## Response Highlights

### JSON input
${formatExcerpt(jsonMetrics.responseTextExcerpt)}

### TOON input
${formatExcerpt(toonMetrics.responseTextExcerpt)}

## Metric Definitions

- **Input tokens sent**: Tokens counted before calling Gemini (via the Count Tokens API).
- **Prompt tokens in response**: Tokens Gemini reports as used from the request after processing.
- **Total tokens in response**: Combined prompt and output token count reported by Gemini.
- **Data prep time**: Time spent preparing the payload (JSON formatting or TOON encoding).
- **Gemini response time**: End-to-end latency for \`models.generateContent\`.
- **Response highlights**: A short excerpt of Gemini's answer to compare tone and content.

`; 
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

      acc.tokenSavings += summary.deltas.tokenSavings;
      acc.tokenSavingsPercent += summary.deltas.tokenSavingsPercent;
      acc.apiLatencyDeltaMs += summary.deltas.apiLatencyDeltaMs;
      acc.conversionOverheadMs += summary.deltas.conversionOverheadMs;

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
      tokenSavings: 0,
      tokenSavingsPercent: 0,
      apiLatencyDeltaMs: 0,
      conversionOverheadMs: 0
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
  console.log(`  Token savings: ${(totals.tokenSavings / runCount).toFixed(1)}`);
  console.log(`  Token savings percent: ${(totals.tokenSavingsPercent / runCount).toFixed(2)}%`);
  console.log(`  API latency delta (JSON - TOON): ${formatMs(totals.apiLatencyDeltaMs / runCount)}`);
  console.log(`  Conversion overhead (TOON - JSON): ${formatMs(totals.conversionOverheadMs / runCount)}`);
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
