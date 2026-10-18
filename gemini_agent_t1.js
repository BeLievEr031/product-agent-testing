'use strict';
/**
 * End-to-end example: teacher request -> prompts -> Gemini -> validate -> retry once.
 *
 *   npm install @google/genai
 *   export GEMINI_API_KEY=...        (the SDK also reads GOOGLE_API_KEY)
 *   node run_gemini.js
 */
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const { generatePrompts, validatePaper, buildRetryPrompt } = require('./prompt_builder_t1');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ai = new GoogleGenAI({}); // picks up the API key from the environment

async function callModel({ systemPrompt, contents, responseSchema }) {
    const response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
            // structured output: field name as shown in Google's current JS example
            responseFormat: { text: { mimeType: 'application/json', schema: responseSchema } },
        },
    });
    return JSON.parse(response.text);
}

async function generatePaper(request, material) {
    const { systemPrompt, userPrompt, responseSchema, selection, warnings } = generatePrompts(request, material);
    if (warnings.length) console.warn('Warnings:', warnings);

    // First attempt
    let paper = await callModel({ systemPrompt, contents: userPrompt, responseSchema });
    let errors = validatePaper(paper, selection);

    // One retry: send the original prompt, the previous answer, and the list of problems
    if (errors.length) {
        console.warn(`Attempt 1 had ${errors.length} problem(s); retrying once`);
        const retryContents = [
            { role: 'user', parts: [{ text: userPrompt }] },
            { role: 'model', parts: [{ text: JSON.stringify(paper) }] },
            { role: 'user', parts: [{ text: buildRetryPrompt(errors) }] },
        ];
        paper = await callModel({ systemPrompt, contents: retryContents, responseSchema });
        errors = validatePaper(paper, selection);
    }

    return { paper, errors };
}

(async () => {
    const request = JSON.parse(fs.readFileSync('./example_request.json', 'utf8'));
    const material = fs.readFileSync(process.argv[2] || './material.txt', 'utf8');

    const { paper, errors } = await generatePaper(request, material);
    fs.writeFileSync('./generated_paper.json', JSON.stringify(paper, null, 2));

    if (errors.length) {
        console.error('Paper still has problems, send for teacher review instead of publishing:');
        errors.forEach((e) => console.error(' -', e));
        process.exitCode = 1;
    } else {
        console.log('Paper valid. Saved to generated_paper.json');
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});