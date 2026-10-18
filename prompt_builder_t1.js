'use strict';
/**
 * Dynamic question-paper prompt builder + output validator.
 *
 * Usage:
 *   const { generatePrompts, validatePaper, buildRetryPrompt } = require('./prompt_builder');
 *   const { systemPrompt, userPrompt, responseSchema, selection } = generatePrompts(request, material);
 *   // call your LLM with systemPrompt + userPrompt (+ responseSchema as structured-output hint)
 *   const errors = validatePaper(paperJson, selection);
 *   if (errors.length) { // retry once with buildRetryPrompt(errors) }
 */

const registry = require('./question_types.json');

const TYPE_MAP = new Map(registry.types.map((t) => [t.id, t]));
const BLOOM = registry.bloom_allowed;
const DIFFICULTY = ['easy', 'medium', 'hard'];

/* ------------------------------------------------------------------ */
/* Teacher-facing list (for the UI checkboxes)                         */
/* ------------------------------------------------------------------ */
function listTypes(subjectCategory) {
    return registry.types
        .filter((t) => !t.eligibility || t.eligibility.subject_categories.includes(subjectCategory))
        .map((t) => ({
            id: t.id,
            label: t.label,
            description: t.description,
            default_marks: t.default_marks,
            est_time_sec: t.est_time_sec,
        }));
}

/* ------------------------------------------------------------------ */
/* Selection: validate teacher choice, fill counts and marks           */
/* ------------------------------------------------------------------ */
function allocate(items, n) {
    if (n < items.length) {
        throw new Error(`total_questions leaves ${n} question(s) for ${items.length} types without a count`);
    }
    const totalWeight = items.reduce((s, i) => s + i.def.weight, 0);
    items.forEach((i) => { i.count = 1; });
    const extra = n - items.length;
    const quotas = items.map((i) => {
        const q = (extra * i.def.weight) / totalWeight;
        return { item: i, q, floor: Math.floor(q) };
    });
    quotas.forEach((x) => { x.item.count += x.floor; });
    const remaining = extra - quotas.reduce((s, x) => s + x.floor, 0);
    quotas.sort((a, b) => (b.q - b.floor) - (a.q - a.floor));
    for (let k = 0; k < remaining; k++) quotas[k].item.count += 1;
}

function resolveSelection(request) {
    const raw = request.selected_types;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('selected_types must be a non-empty array');
    }
    const warnings = [];
    const seen = new Set();

    const items = raw.map((entry) => {
        const spec = typeof entry === 'string' ? { type: entry } : entry;
        const def = TYPE_MAP.get(spec.type);
        if (!def) throw new Error(`Unknown question type: ${spec.type}`);
        if (seen.has(spec.type)) throw new Error(`Duplicate question type: ${spec.type}`);
        seen.add(spec.type);
        if (def.eligibility && !def.eligibility.subject_categories.includes(request.subject_category)) {
            throw new Error(
                `${def.label} is only available for subject categories: ${def.eligibility.subject_categories.join(', ')}`
            );
        }
        if (spec.count != null && (!Number.isInteger(spec.count) || spec.count < 1)) {
            throw new Error(`count for ${spec.type} must be a positive integer`);
        }
        return {
            def,
            count: spec.count == null ? null : spec.count,
            marks_each: spec.marks_each == null ? def.default_marks : spec.marks_each,
        };
    });

    const missing = items.filter((i) => i.count == null);
    if (missing.length) {
        if (!Number.isInteger(request.total_questions)) {
            throw new Error('Give a count for every selected type, or set total_questions to auto-distribute');
        }
        const fixed = items.filter((i) => i.count != null).reduce((s, i) => s + i.count, 0);
        allocate(missing, request.total_questions - fixed);
    }

    const selection = items.map((i) => ({
        id: i.def.id,
        label: i.def.label,
        count: i.count,
        marks_each: i.marks_each,
        def: i.def,
    }));

    const totalQuestions = selection.reduce((s, i) => s + i.count, 0);
    const totalMarks = selection.reduce((s, i) => s + i.count * i.marks_each, 0);
    const estSeconds = selection.reduce((s, i) => s + i.count * i.def.est_time_sec, 0);

    if (request.total_marks_target && request.total_marks_target !== totalMarks) {
        warnings.push(`Selection gives ${totalMarks} marks but total_marks_target is ${request.total_marks_target}`);
    }
    if (request.duration_minutes && estSeconds / 60 > request.duration_minutes * 1.1) {
        warnings.push(
            `Estimated solving time is ${(estSeconds / 60).toFixed(0)} min but duration is ${request.duration_minutes} min`
        );
    }
    selection.totals = { questions: totalQuestions, marks: totalMarks, est_minutes: Math.round(estSeconds / 60) };
    selection.warnings = warnings;
    return selection;
}

/* ------------------------------------------------------------------ */
/* Prompt assembly                                                     */
/* ------------------------------------------------------------------ */
const BASE_SYSTEM_PROMPT = `You are an expert assessment designer and learning scientist. You create question papers that test whether a student has UNDERSTOOD the concepts taught in class today, not whether they can recall or recognise the teacher's words.

## INPUT
You receive TEACHING_MATERIAL, class and subject metadata, and the exact question types, counts and marks to generate.

## CORE PRINCIPLES
1. GROUNDING: Use only concepts present in TEACHING_MATERIAL. Never add facts from outside it. If the material cannot support a requested type or count, generate fewer and explain in meta.skipped_types.
2. UNDERSTANDING OVER RECALL: A student who only memorised definitions or sentences must NOT be able to answer correctly. Every question must require at least one of: applying the concept to a NEW scenario or example; explaining why or how; predicting an outcome when a condition changes; spotting and correcting a flawed idea; distinguishing two close concepts; connecting two concepts from today's lesson.
3. NO VERBATIM COPYING: Never reuse sentences or examples from the material. Reword, and use fresh contexts and numbers.
4. MISCONCEPTION-DRIVEN: For each question, identify the most likely student misconception about the concept and design the question (and its wrong options or flawed steps) to expose it.
5. BLOOM LEVELS: Use only "understand", "apply", "analyze" or "evaluate". Never "remember". At least 50% of questions must be "apply" or higher.
6. FAIRNESS: Unambiguous answers, grade-appropriate language, no trick wording. No question may give away the answer to another question in the same paper.
7. CONCEPT TAGGING: First extract 3 to 10 key concepts from the material. Every question maps to one or more concept_ids, and every concept must be tested at least once if the number of questions allows.
8. VARIETY: Spread questions across concepts and difficulty as requested. Do not repeat the same scenario or equation in different questions.

## QUESTION TYPES TO GENERATE (only these, with exactly the requested counts)
{{TYPE_MODULES}}

## SELF-CHECK BEFORE OUTPUT (do silently)
- Could a student answer this by memorising a definition? If yes, rewrite.
- Is there exactly one defensible answer (or exactly the stated set of correct answers)? If not, rewrite.
- Does every question trace to the material and to a concept_id?
- Do counts per type and marks match the request exactly? Do the answer_key fields agree with each other?
- Is the position of correct answers varied?

## OUTPUT FORMAT
Return ONLY valid JSON, no markdown and no commentary, with this envelope:
{{ENVELOPE}}
Use null where a field does not apply. Escape quotes properly. Put math in plain text or LaTeX inside $...$.`;

function typeModule(sel) {
    const d = sel.def;
    const rules = d.rules.map((r) => `- ${r}`).join('\n');
    return [
        `### ${d.id}: ${d.label} (${sel.count} question${sel.count > 1 ? 's' : ''}, ${sel.marks_each} mark${sel.marks_each === 1 ? '' : 's'} each)`,
        d.description,
        'Rules:',
        rules,
        `"content" shape: ${JSON.stringify(d.content_example)}`,
        `"answer_key" shape: ${JSON.stringify(d.answer_key_example)}`,
    ].join('\n');
}

function envelopeExample() {
    return JSON.stringify(
        {
            paper_id: 'string',
            meta: {
                subject: 'string',
                grade: 'string',
                topic: 'string',
                lesson_date: 'YYYY-MM-DD',
                language: 'string',
                duration_minutes: 0,
                total_marks: 0,
                question_counts: { '<type_id>': 0 },
                skipped_types: [{ type: '<type_id>', reason: 'string' }],
                generation_notes: 'string or null',
            },
            concepts: [{ concept_id: 'C1', name: 'string', description: 'string', prerequisites: [] }],
            questions: [
                {
                    question_id: 'Q1',
                    type: '<type_id>',
                    concept_ids: ['C1'],
                    bloom_level: 'understand|apply|analyze|evaluate',
                    difficulty: 'easy|medium|hard',
                    marks: 1,
                    estimated_time_sec: 60,
                    question_text: 'string',
                    misconception_targeted: 'string',
                    why_tests_understanding: 'string',
                    source_evidence: 'short pointer to the part of the material',
                    content: {},
                    answer_key: {},
                    explanation: 'string',
                },
            ],
        },
        null,
        2
    );
}

function buildSystemPrompt(selection) {
    const modules = selection.map(typeModule).join('\n\n');
    const envelope = envelopeExample();
    // function replacers, so "$" sequences inside the inserted text are never interpreted
    return BASE_SYSTEM_PROMPT.replace('{{TYPE_MODULES}}', () => modules).replace('{{ENVELOPE}}', () => envelope);
}

function buildUserPrompt(request, selection, material) {
    const mix = request.difficulty_mix || { easy: 30, medium: 50, hard: 20 };
    const lines = selection.map(
        (s) => `- ${s.id}: ${s.count} question${s.count > 1 ? 's' : ''} x ${s.marks_each} mark${s.marks_each === 1 ? '' : 's'}`
    );
    return [
        `SUBJECT: ${request.subject}`,
        `CLASS/GRADE: ${request.grade}`,
        `BOARD/CURRICULUM: ${request.board || 'not specified'}`,
        `TOPIC: ${request.topic}`,
        `LESSON_DATE: ${request.lesson_date}`,
        `LANGUAGE: ${request.language || 'en'}`,
        `STUDENT_LEVEL: ${request.student_level || 'average'}`,
        `DURATION_MINUTES: ${request.duration_minutes || 'not specified'}`,
        '',
        'QUESTIONS TO GENERATE:',
        ...lines,
        `TOTAL: ${selection.totals.questions} questions, ${selection.totals.marks} marks`,
        '',
        `DIFFICULTY_MIX: easy=${mix.easy}%, medium=${mix.medium}%, hard=${mix.hard}%`,
        '',
        'TEACHING_MATERIAL:',
        '"""',
        material,
        '"""',
        '',
        'Generate the paper as JSON exactly as specified.',
    ].join('\n');
}

/* Envelope-only JSON Schema: use as a structured-output hint.
   Per-type shapes are enforced by validatePaper(), because union schemas
   are poorly supported by some providers. */
function buildResponseSchema(selection) {
    const ids = selection.map((s) => s.id);
    return {
        type: 'object',
        required: ['paper_id', 'meta', 'concepts', 'questions'],
        properties: {
            paper_id: { type: 'string' },
            meta: { type: 'object' },
            concepts: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['concept_id', 'name', 'description'],
                    properties: {
                        concept_id: { type: 'string' },
                        name: { type: 'string' },
                        description: { type: 'string' },
                        prerequisites: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    required: [
                        'question_id', 'type', 'concept_ids', 'bloom_level', 'difficulty', 'marks',
                        'estimated_time_sec', 'question_text', 'content', 'explanation',
                    ],
                    properties: {
                        question_id: { type: 'string' },
                        type: { type: 'string', enum: ids },
                        concept_ids: { type: 'array', items: { type: 'string' } },
                        bloom_level: { type: 'string', enum: BLOOM },
                        difficulty: { type: 'string', enum: DIFFICULTY },
                        marks: { type: 'number' },
                        estimated_time_sec: { type: 'number' },
                        question_text: { type: 'string' },
                        misconception_targeted: { type: 'string' },
                        why_tests_understanding: { type: 'string' },
                        source_evidence: { type: 'string' },
                        content: { type: 'object' },
                        answer_key: { type: 'object', nullable: true },
                        explanation: { type: 'string' },
                    },
                },
            },
        },
    };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isArr = Array.isArray;
const unique = (a) => new Set(a).size === a.length;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function checkOptions(c, e, min, max) {
    const opts = c.options;
    if (!isArr(opts)) return e('content.options must be an array'), [];
    if (opts.length < min || opts.length > max) e(`needs ${min === max ? min : `${min}-${max}`} options, found ${opts.length}`);
    const ids = opts.map((o) => o && o.id);
    if (!unique(ids) || ids.some((i) => !isStr(i))) e('option ids must be unique non-empty strings');
    if (opts.some((o) => !o || !isStr(o.text))) e('every option needs text');
    return ids;
}

const validators = {
    mcq_single(q, e) {
        const ids = checkOptions(q.content || {}, e, 4, 4);
        const k = q.answer_key || {};
        if (!ids.includes(k.correct_option_id)) e('answer_key.correct_option_id missing or not among the options');
    },

    mcq_multi(q, e) {
        const ids = checkOptions(q.content || {}, e, 4, 6);
        const k = q.answer_key || {};
        const c = k.correct_option_ids;
        if (!isArr(c) || c.length < 2) return e('answer_key.correct_option_ids needs at least 2 ids');
        if (c.some((x) => !ids.includes(x))) e('correct_option_ids contains an id that is not an option');
        if (c.length >= ids.length) e('not all options may be correct');
        if (!unique(c)) e('correct_option_ids has duplicates');
    },

    true_false(q, e) {
        const c = q.content || {};
        const k = q.answer_key || {};
        if (!isStr(c.statement)) e('content.statement required');
        if (typeof k.correct_answer !== 'boolean') e('answer_key.correct_answer must be true or false');
        if (c.justification_required && !isStr(k.correct_justification)) e('correct_justification required when justification_required is true');
    },

    fill_blank(q, e) {
        const text = q.question_text || '';
        const found = [...text.matchAll(/\{\{(b\d+)\}\}/g)].map((m) => m[1]);
        const blanks = (q.answer_key || {}).blanks;
        if (!isArr(blanks) || blanks.length === 0) return e('answer_key.blanks required');
        if (found.length === 0) return e('question_text has no {{b1}} placeholders');
        if (found.length > 3) e('maximum 3 blanks');
        if (!sameSet([...new Set(found)], blanks.map((b) => b.id))) e('placeholders in question_text do not match answer_key.blanks ids');
        if (blanks.some((b) => !isStr(b.answer))) e('every blank needs an answer');
    },

    match_following(q, e) {
        const c = q.content || {};
        const k = q.answer_key || {};
        const left = c.left_items;
        const right = c.right_items;
        if (!isArr(left) || !isArr(right)) return e('content.left_items and right_items required');
        if (left.length < 4 || left.length > 6) e('needs 4-6 left items');
        if (right.length <= left.length) e('right_items must be longer than left_items (extra distractors)');
        const lids = left.map((x) => x.id);
        const rids = right.map((x) => x.id);
        if (!unique(lids) || !unique(rids)) e('item ids must be unique');
        const pairs = k.pairs;
        if (!isArr(pairs) || pairs.length !== left.length) return e('answer_key.pairs must have one pair per left item');
        if (!sameSet(pairs.map((p) => p.left_id), lids)) e('every left item needs exactly one pair');
        if (pairs.some((p) => !rids.includes(p.right_id))) e('a pair points to an unknown right item');
        if (!unique(pairs.map((p) => p.right_id))) e('two left items map to the same right item');
    },

    numerical(q, e) {
        const k = q.answer_key || {};
        if (typeof k.correct_value !== 'number' || Number.isNaN(k.correct_value)) e('answer_key.correct_value must be a number');
        if (!('unit' in k)) e('answer_key.unit required (use null if unitless)');
        if (!k.tolerance || typeof k.tolerance.value !== 'number' || !['absolute', 'percent'].includes(k.tolerance.type)) {
            e('answer_key.tolerance needs type (absolute|percent) and numeric value');
        }
        if (!isArr(k.solution_steps) || k.solution_steps.length === 0) e('solution_steps required');
    },

    short_answer(q, e) {
        const k = q.answer_key || {};
        if (!isStr(k.expected_answer)) e('answer_key.expected_answer required');
        else if (k.expected_answer.trim().split(/\s+/).length > 20) e('expected_answer is longer than a short answer');
        if (!isArr(k.key_points) || k.key_points.length === 0) e('answer_key.key_points required');
    },

    assertion_reason(q, e) {
        const c = q.content || {};
        const k = q.answer_key || {};
        if (!isStr(c.assertion) || !isStr(c.reason)) e('assertion and reason required');
        const ids = (c.options || []).map((o) => o.id).join('');
        if (ids !== 'ABCD') e('options must be exactly A, B, C, D');
        let expected = null;
        if (k.assertion_true && k.reason_true) expected = k.reason_explains_assertion ? 'A' : 'B';
        else if (k.assertion_true && !k.reason_true) expected = 'C';
        else if (!k.assertion_true && k.reason_true) expected = 'D';
        if (!expected) e('assertion false and reason false cannot be represented by options A-D');
        else if (k.correct_option_id !== expected) e(`correct_option_id ${k.correct_option_id} contradicts the flags (flags imply ${expected})`);
    },

    order_steps(q, e) {
        const items = (q.content || {}).items;
        const order = (q.answer_key || {}).correct_order;
        if (!isArr(items) || items.length < 4 || items.length > 7) return e('content.items needs 4-7 steps');
        const ids = items.map((i) => i.id);
        if (!unique(ids)) e('item ids must be unique');
        if (!isArr(order) || !sameSet(order, ids)) return e('answer_key.correct_order must be a permutation of the item ids');
        if (ids.join('|') === order.join('|')) e('items are listed in the correct order; they must be shuffled');
    },

    identify_error(q, e) {
        const c = q.content || {};
        const k = q.answer_key || {};
        if (!isArr(c.steps) || c.steps.length < 3 || c.steps.length > 6) return e('content.steps needs 3-6 steps');
        const ids = c.steps.map((s) => s.id);
        if (!isArr(k.error_step_ids) || k.error_step_ids.length === 0) return e('answer_key.error_step_ids required');
        if (k.error_step_ids.some((x) => !ids.includes(x))) e('error_step_ids refers to an unknown step');
        if (c.errors_count !== k.error_step_ids.length) e('errors_count must equal the number of error_step_ids');
        if (!isStr(k.why_wrong) || !isStr(k.corrected_text)) e('why_wrong and corrected_text required');
    },

    scenario_mcq(q, e) {
        if (!isStr((q.content || {}).scenario)) e('content.scenario required');
        validators.mcq_single(q, e);
    },

    case_based(q, e) {
        const c = q.content || {};
        if (!isStr(c.case_text)) e('content.case_text required');
        const subs = c.sub_questions;
        if (!isArr(subs) || subs.length < 3 || subs.length > 5) return e('needs 3-5 sub_questions');
        const allowed = registry.case_sub_types;
        let sum = 0;
        subs.forEach((s) => {
            const tag = s.sub_question_id || '(sub-question)';
            const se = (m) => e(`${tag}: ${m}`);
            if (!allowed.includes(s.sub_type)) return se(`sub_type must be one of ${allowed.join(', ')}`);
            if (typeof s.marks !== 'number') se('marks required');
            else sum += s.marks;
            validators[s.sub_type](
                { question_text: s.question_text, content: s.content, answer_key: s.answer_key },
                se
            );
        });
        if (Math.abs(sum - q.marks) > 1e-9) e(`sub-question marks add up to ${sum} but the case has ${q.marks} marks`);
    },

    code_based(q, e) {
        const c = q.content || {};
        const k = q.answer_key || {};
        if (!isStr(c.language) || !isStr(c.code)) e('content.language and content.code required');
        else if (c.code.split('\n').length > 15) e('code is longer than 15 lines');
        if (!['predict_output', 'find_error', 'complete_code'].includes(c.task)) e('content.task invalid');
        if (!['mcq', 'text'].includes(c.response_mode)) e('content.response_mode must be mcq or text');
        if (c.response_mode === 'mcq') {
            const ids = checkOptions(c, e, 4, 4);
            if (!ids.includes(k.correct_option_id)) e('answer_key.correct_option_id missing or not among the options');
        } else if (c.task === 'predict_output' && !isStr(k.expected_output)) {
            e('answer_key.expected_output required');
        }
        if (!isArr(k.trace) || k.trace.length === 0) e('answer_key.trace required');
    },

    drag_drop_classify(q, e) {
        const c = q.content || {};
        const k = q.answer_key || {};
        const cats = c.categories;
        const items = c.items;
        if (!isArr(cats) || cats.length < 2 || cats.length > 4) return e('needs 2-4 categories');
        if (!isArr(items) || items.length < 6 || items.length > 10) return e('needs 6-10 items');
        const cids = cats.map((x) => x.id);
        const iids = items.map((x) => x.id);
        if (!unique(cids) || !unique(iids)) e('ids must be unique');
        const map = k.mapping;
        if (!isArr(map) || !sameSet(map.map((m) => m.item_id), iids)) return e('mapping must cover every item exactly once');
        if (map.some((m) => !cids.includes(m.category_id))) e('mapping points to an unknown category');
        cids.forEach((cid) => {
            if (map.filter((m) => m.category_id === cid).length < 2) e(`category ${cid} must contain at least 2 items`);
        });
    },
};

function validatePaper(paper, selection) {
    const errors = [];
    if (!paper || !isArr(paper.questions)) return ['paper.questions missing'];

    const skipped = new Set(((paper.meta || {}).skipped_types || []).map((s) => s.type));
    const conceptIds = new Set((paper.concepts || []).map((c) => c.concept_id));
    if (conceptIds.size === 0) errors.push('concepts missing');

    const qids = paper.questions.map((q) => q.question_id);
    if (!unique(qids)) errors.push('question_id values must be unique');

    const wantedMarksPerType = {};
    let expectedMarks = 0;
    selection.forEach((s) => {
        wantedMarksPerType[s.id] = s.marks_each;
        const got = paper.questions.filter((q) => q.type === s.id).length;
        if (skipped.has(s.id)) {
            if (got > 0) errors.push(`${s.id} is listed in skipped_types but ${got} question(s) were generated`);
            return;
        }
        if (got !== s.count) errors.push(`${s.id}: expected ${s.count} question(s), found ${got}`);
        expectedMarks += s.count * s.marks_each;
    });

    let actualMarks = 0;
    paper.questions.forEach((q) => {
        const id = q.question_id || '(no id)';
        const e = (m) => errors.push(`${id}: ${m}`);
        if (!wantedMarksPerType[q.type]) return e(`type "${q.type}" was not requested`);
        if (!isStr(q.question_text)) e('question_text required');
        if (!BLOOM.includes(q.bloom_level)) e(`bloom_level must be one of ${BLOOM.join(', ')}`);
        if (!DIFFICULTY.includes(q.difficulty)) e('difficulty must be easy, medium or hard');
        if (!isArr(q.concept_ids) || q.concept_ids.length === 0) e('concept_ids required');
        else if (q.concept_ids.some((c) => !conceptIds.has(c))) e('concept_ids contains an unknown concept');
        if (q.marks !== wantedMarksPerType[q.type]) e(`marks should be ${wantedMarksPerType[q.type]}, found ${q.marks}`);
        if (typeof q.marks === 'number') actualMarks += q.marks;
        if (!isStr(q.explanation)) e('explanation required');
        validators[q.type](q, e);
    });

    if (Math.abs(actualMarks - expectedMarks) > 1e-9) {
        errors.push(`total marks are ${actualMarks}, expected ${expectedMarks}`);
    }
    return errors;
}

function buildRetryPrompt(errors) {
    return [
        'Your previous JSON failed validation. Fix ONLY the problems listed below and return the complete corrected JSON, with no commentary.',
        ...errors.slice(0, 20).map((x) => `- ${x}`),
    ].join('\n');
}

/* ------------------------------------------------------------------ */
function generatePrompts(request, material) {
    const selection = resolveSelection(request);
    return {
        selection,
        warnings: selection.warnings,
        totals: selection.totals,
        systemPrompt: buildSystemPrompt(selection),
        userPrompt: buildUserPrompt(request, selection, material),
        responseSchema: buildResponseSchema(selection),
    };
}

module.exports = {
    listTypes,
    resolveSelection,
    generatePrompts,
    buildSystemPrompt,
    buildUserPrompt,
    buildResponseSchema,
    validatePaper,
    buildRetryPrompt,
};