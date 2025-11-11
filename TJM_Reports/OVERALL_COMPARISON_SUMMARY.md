# Overall Comparison Summary

- **Total Benchmark Runs:** 10
- **Model Used:** gemini-2.0-flash
- **Date Range:** 2025-11-09T17:51:34.111Z to 2025-11-10T04:54:13.782Z
- **Fastest Format (avg API latency):** TOON

## Executive Summary

### Token Efficiency (Average)

- **TOON vs JSON:** TOON saved 400 tokens (28.50%)
- **MARKDOWN vs JSON:** MARKDOWN saved 440 tokens (31.30%)
- **MARKDOWN vs TOON:** MARKDOWN saved 40 tokens (4.00%)

### Latency (Average)

- **Fastest format:** TOON
- **TOON conversion overhead:** 0.8ms
- **MARKDOWN conversion overhead:** 0.5ms

## Detailed Average Metrics

Format | Input tokens sent | Prompt tokens in response | Total tokens in response | Data prep time | Gemini response time
--- | --- | --- | --- | --- | ---
JSON | 1,404 | 1,398 | 1,667 | 0.1ms | 7533.0ms
TOON | 1,004 | 999 | 1,195 | 0.9ms | 6712.0ms
MARKDOWN | 964 | 964 | 1,196 | 0.5ms | 7379.7ms

## Comparison Deltas (Average)

### TOON vs JSON
- **Token savings:** 400 tokens (28.50%)
- **API latency delta (JSON - TOON):** 820.9ms
- **Conversion overhead (TOON - JSON):** 0.8ms

### MARKDOWN vs JSON
- **Token savings:** 440 tokens (31.30%)
- **API latency delta (JSON - MARKDOWN):** 153.2ms
- **Conversion overhead (MARKDOWN - JSON):** 0.5ms

### MARKDOWN vs TOON
- **Token savings:** 40 tokens (4.00%)
- **API latency delta (TOON - MARKDOWN):** -667.7ms
- **Conversion overhead (MARKDOWN - TOON):** -0.4ms

## Key Insights

1. **Token Efficiency:** MARKDOWN provides the best token savings compared to JSON (31.30% reduction).

2. **API Latency:** TOON has the fastest average API response time at 6712.0ms.

3. **Conversion Overhead:** MARKDOWN has lower conversion overhead (0.5ms).

## Metric Definitions

- **Input tokens sent**: Tokens counted before calling Gemini (via the Count Tokens API).
- **Prompt tokens in response**: Tokens Gemini reports as used from the request after processing.
- **Total tokens in response**: Combined prompt and output token count reported by Gemini.
- **Data prep time**: Time spent preparing the payload (JSON formatting, TOON encoding, or Markdown conversion).
- **Gemini response time**: End-to-end latency for `models.generateContent`.
