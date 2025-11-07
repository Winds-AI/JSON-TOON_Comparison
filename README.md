# TOON vs JSON Gemini Benchmark

This workspace experiments with TOON (Token-Oriented Object Notation) vs. JSON prompts when calling Gemini models using the Google Gen AI SDK. See `PLAN.md` for experiment scope and deliverables.

## Setup

1. Install dependencies: `npm install`.
2. Create a `.env` file alongside `package.json` with your Gemini key:

   ```bash
   GEMINI_API_KEY=your_api_key_here
   # optionally override the default model
   # GEMINI_MODEL=gemini-2.5-flash
   ```

3. Run the benchmark: `npm run benchmark`.

## Findings

Across 10 benchmark runs (see `reports/`), TOON consistently reduced prompt size and latency:

- **Input tokens sent:** JSON 1,404 → TOON 1,004 (−400 tokens)
- **Prompt tokens in response:** JSON 1,398 → TOON 999 (−399 tokens)
- **Total tokens in response:** JSON 1,658.2 → TOON 1,199.7 (−458.5 tokens)
- **Data prep time:** JSON 0.02 ms → TOON 0.45 ms (+0.43 ms overhead)
- **Gemini response time:** JSON 7,769.05 ms → TOON 7,417.10 ms (−351.95 ms)

TOON adds a small preprocessing cost but still yields lower end-to-end latency thanks to slimmer payloads.
