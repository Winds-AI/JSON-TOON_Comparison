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
