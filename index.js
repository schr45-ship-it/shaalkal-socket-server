const dotenv = require('dotenv'); dotenv.config();
const express = require('express');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const defaultOrigins = ['http://localhost:5173','http://127.0.0.1:5173','https://shaalkal.web.app'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean) : defaultOrigins);
app.use(cors({ origin: allowedOrigins, methods: ['GET','POST','OPTIONS'], credentials: true }));
app.use(express.json({ limit: '2mb' }));

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

function sanitizeOption(s) {
  let t = String(s || '').trim();
  // remove common prefixes like numbering or bullets
  t = t.replace(/^([\-–—•]|\d+\.|\(?\d+\)?|[A-Dא-ד]\.|[A-Dא-ד]\)|\(?[A-Dא-ד]\)?)(\s+)?/, '');
  // remove labels like 'נכון', 'טעות', 'תשובה', 'Correct', 'Wrong'
  t = t.replace(/^\s*(נכון:?|תשובה\s*נכונה:?|טעות:?|שגוי:?|Correct:?|True:?|False:?|Wrong:?)/i, '').trim();
  // collapse spaces and clip length
  t = t.replace(/\s+/g, ' ').trim().slice(0, 80);
  return t || 'אפשרות';
}

function sanitizeQuestionList(list, count, topicText) {
  const topic = String(topicText||'');
  const topicWords = Array.from(new Set(topic
    .replace(/[^\p{L}\p{N}\s-]/gu,' ')
    .split(/\s+/)
    .filter(w => w && w.length >= 3)
    .slice(0, 12)
  ));
  function stripTopic(str){
    let out = String(str||'');
    // remove the word 'חידון'
    out = out.replace(/\bחידון\b/gu, '').trim();
    // remove topic keywords
    for (const w of topicWords){
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'giu');
      out = out.replace(re, '').trim();
    }
    out = out.replace(/\s+/g,' ').trim();
    return out;
  }
  function canon(s){
    let t = sanitizeOption(s).toLowerCase();
    // unify punctuation and remove wrappers
    t = t.replace(/[“”"'`]+/g,'');
    t = t.replace(/[()\[\]{}*]+/g,'');
    t = t.replace(/[–—‑−]/g,'-');
    t = t.replace(/\s*-\s*/g,'-');
    // canonicalize years or year ranges
    const m = t.match(/(1\d{3}|20\d{2})(?:\s*[-]\s*(1\d{3}|20\d{2}))?/);
    if (m){
      const y1 = parseInt(m[1],10);
      const y2 = m[2] ? parseInt(m[2],10) : null;
      if (y2!=null){ const a = Math.min(y1,y2), b = Math.max(y1,y2); return `${a}-${b}`; }
      return String(y1);
    }
    return t;
  }
  function norm(s){ return canon(s); }
  function genYearDistractors(baseText, correctText, need, seen){
    const out = [];
    const m = String(correctText||'').match(/(1\d{3}|20\d{2})(?:\D+(1\d{3}|20\d{2}))?/);
    if (m){
      const y1 = parseInt(m[1],10);
      const y2 = m[2] ? parseInt(m[2],10) : null;
      const shifts = [ -7, -5, -3, 3, 5, 7, 10, -10 ];
      for (let s of shifts){
        if (out.length>=need) break;
        const candidate = y2 ? `${y1+s}-${y2+s}` : String(y1+s);
        const k = norm(candidate);
        if (!seen.has(k)) out.push(candidate);
      }
    }
    while (out.length<need){
      const fillers = ['תקופה אחרת', 'בחירה חלופית', 'נתון שונה', 'גרסה אחרת'];
      const candidate = fillers[out.length % fillers.length];
      const k = norm(candidate);
      if (!seen.has(k)) out.push(candidate);
    }
    return out;
  }

  const qs = (list || []).slice(0, count).map((q) => {
    let cleanText = String(q.text || '').replace(/^שאלה:?\s*/,'').slice(0, 200);
    cleanText = stripTopic(cleanText) || 'שאלה';
    const raw = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
    let correct = Math.max(0, Math.min(3, Number(q.correct) || 0));
    const sanitized = raw.map(sanitizeOption);
    // deduplicate while preserving first occurrence and correct mapping
    const seen = new Map();
    const unique = [];
    let correctVal = sanitized[correct] || sanitized[0] || '';
    for (let i=0;i<sanitized.length;i++){
      const k = norm(sanitized[i]);
      if (!seen.has(k)){
        seen.set(k, unique.length);
        unique.push(sanitized[i]);
      } else {
        // if duplicate was the correct one, remap to the first instance
        if (i === correct) correct = seen.get(k);
      }
    }
    // ensure correct option present
    if (unique.length===0){ unique.push(correctVal || 'אפשרות'); correct = 0; }
    // pad to 4 with smart distractors
    if (unique.length < 4){
      const need = 4 - unique.length;
      const adds = genYearDistractors(cleanText, correctVal, need, seen).map(sanitizeOption);
      for (const a of adds){
        const k = norm(a);
        if (!seen.has(k)){
          seen.set(k, unique.length);
          unique.push(a);
        }
      }
      // if still less than 4, use generic placeholders not in seen
      const fillers = ['אפשרות א', 'אפשרות ב', 'אפשרות ג', 'אפשרות ד'];
      for (const f of fillers){
        if (unique.length>=4) break;
        const k = norm(f);
        if (!seen.has(k)) { seen.set(k, unique.length); unique.push(f); }
      }
    }
    let options = unique.slice(0,4).map(o => stripTopic(o) || 'אפשרות');
    // final guard: if correct index out of range, set to 0
    if (correct < 0 || correct >= options.length) correct = 0;
    // shuffle options while keeping track of the correct index
    const idxs = options.map((_,i)=>i);
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    const shuffled = idxs.map(i => options[i]);
    const newCorrect = idxs.indexOf(correct);
    options = shuffled;
    correct = newCorrect >= 0 ? newCorrect : 0;

    // FINAL ENFORCEMENT: ensure exactly 4 UNIQUE options
    const final = [];
    const finalSeen = new Map();
    let finalCorrect = 0;
    for (let i=0;i<options.length;i++){
      const k = norm(options[i]);
      if (!finalSeen.has(k)){
        const newIndex = final.length;
        finalSeen.set(k, newIndex);
        final.push(options[i]);
        if (i === correct) finalCorrect = newIndex;
      } else {
        // if the duplicate was the correct one, map to first occurrence
        if (i === correct) finalCorrect = finalSeen.get(k);
      }
      if (final.length === 4) break;
    }
    // pad if needed with numbered fillers that cannot collide
    let fillerIdx = 1;
    while (final.length < 4) {
      const candidate = `אפשרות ${fillerIdx++}`;
      const k = norm(candidate);
      if (!finalSeen.has(k)) {
        finalSeen.set(k, final.length);
        final.push(candidate);
      }
    }
    options = final.slice(0,4);
    correct = (finalCorrect >= 0 && finalCorrect < options.length) ? finalCorrect : 0;
    return {
      text: cleanText,
      options,
      correct,
      durationSec: Math.max(5, Math.min(120, Number(q.durationSec) || 15))
    };
  });
  return qs;
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ['GET','POST','OPTIONS'], credentials: true } });

// In-memory store for MVP
const rooms = new Map();

// In-memory AI planning chat sessions (MVP)
const aiSessions = new Map();
function getAiSession(id){
  const now = Date.now();
  // cleanup expired
  for (const [sid, s] of aiSessions.entries()) {
    if ((s.expiresAt||0) < now) aiSessions.delete(sid);
  }
  let s = aiSessions.get(id);
  if (!s) {
    s = { id, answers: {}, createdAt: now, expiresAt: now + 10*60*1000 };
    aiSessions.set(id, s);
  } else {
    s.expiresAt = now + 10*60*1000;
  }
  return s;
}

function createPin(){
  return String(Math.floor(100000 + Math.random()*900000));
}

io.on('connection', (socket) => {
  // Host creates room
  socket.on('host:create_room', ({ title }) => {
    const pin = createPin();
    rooms.set(pin, {
      hostId: socket.id,
      title: title || 'New Quiz',
      meta: { title: title || 'New Quiz', coverImageUrl: '', coverDescription: '' },
      players: new Map(),
      currentQuestion: null,
      questionEndsAt: null,
      leaderboard: new Map()
    });
    socket.join(pin);
    io.to(socket.id).emit('host:room_created', { pin });
  });

  // Player joins room
  socket.on('player:join', ({ pin, name }) => {
    const room = rooms.get(pin);
    if (!room) return socket.emit('error:join', 'Room not found');
    room.players.set(socket.id, { name: name?.trim() || 'שחקן', score: 0, answeredAt: null, answer: null });
    socket.join(pin);
    io.to(pin).emit('room:players', Array.from(room.players.values()));
    socket.emit('player:joined', { pin });
  });

  // Host starts a question
  socket.on('host:start_question', ({ pin, question }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    const now = Date.now();
    const durationMs = Math.max(5, Number(question?.durationSec || 20)) * 1000;
    room.currentQuestion = {
      id: question?.id || now,
      text: String(question?.text || ''),
      type: question?.type || 'mc',
      options: Array.isArray(question?.options) ? question.options.slice(0,6) : [],
      correct: question?.correct ?? null,
      startedAt: now,
      durationSec: Math.floor(durationMs/1000)
    };
    room.questionEndsAt = now + durationMs;
    room.paused = false;
    room.pauseRemainingMs = null;
    // hide any interstitial screen
    io.to(pin).emit('interstitial:hide');
    // reset player answers
    room.players.forEach(p => { p.answer = null; p.answeredAt = null; });
    io.to(pin).emit('question:start', { question: room.currentQuestion, endsAt: room.questionEndsAt });
  });

  // Player submits answer
  socket.on('player:answer', ({ pin, answer }) => {
    const room = rooms.get(pin);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !room.currentQuestion) return;
    if (room.paused) return; // paused: ignore
    if (Date.now() > room.questionEndsAt) return; // late
    if (player.answer != null) return; // already answered
    player.answer = answer;
    player.answeredAt = Date.now();
    // notify host of progress
    const answered = Array.from(room.players.values()).filter(p => p.answer != null).length;
    io.to(room.hostId).emit('host:progress', { answered, total: room.players.size });
  });

  // Host finishes question and scores
  socket.on('host:finish_question', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id || !room.currentQuestion) return;
    room.paused = false;
    room.pauseRemainingMs = null;
    const q = room.currentQuestion;
    const correctIndex = q.correct;
    const results = [];
    room.players.forEach((p, sid) => {
      const correct = (correctIndex == null) ? false : Number(p.answer) === Number(correctIndex);
      let add = 0;
      if (correct) {
        // simple speed scoring: faster -> more points
        const elapsed = Math.max(0, (p.answeredAt ?? room.questionEndsAt) - q.startedAt);
        const remaining = Math.max(0, (q.durationSec*1000) - elapsed);
        add = 500 + Math.floor(remaining/100); // 500 base + up to ~200
      }
      p.score = (p.score || 0) + add;
      results.push({ name: p.name, answer: p.answer, correct, add, score: p.score });
    });
    // leaderboard
    const leaderboard = Array.from(room.players.values())
      .map(p => ({ name: p.name, score: p.score }))
      .sort((a,b) => b.score - a.score)
      .slice(0,10);
    io.to(pin).emit('question:results', { correctIndex, results, leaderboard });
    room.currentQuestion = null;
    room.questionEndsAt = null;
  });

  // Host updates quiz meta (cover image/description/title)
  socket.on('host:set_meta', ({ pin, meta }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    room.meta = { ...(room.meta||{}), ...(meta||{}) };
    if (typeof room.meta.title === 'string') room.title = room.meta.title;
    io.to(pin).emit('room:meta', room.meta);
  });

  // Host shows interstitial screen between questions
  socket.on('host:interstitial', ({ pin, message, durationMs, imageUrl, youtubeUrl, bgColor }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    const payload = { message: String(message||'שאלה הבאה מיד...'), imageUrl: imageUrl||'', youtubeUrl: youtubeUrl||'', bgColor: bgColor||'', until: durationMs ? (Date.now()+Number(durationMs)) : null };
    io.to(pin).emit('interstitial:show', payload);
  });

  // Host pauses current question
  socket.on('host:pause_question', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id || !room.currentQuestion || room.paused) return;
    const remaining = Math.max(0, (room.questionEndsAt || 0) - Date.now());
    room.paused = true;
    room.pauseRemainingMs = remaining;
    room.questionEndsAt = Date.now(); // so late guard triggers
    io.to(pin).emit('question:paused');
  });

  // Host resumes current question
  socket.on('host:resume_question', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id || !room.currentQuestion || !room.paused) return;
    const dur = Math.max(1000, Number(room.pauseRemainingMs || 0));
    room.paused = false;
    room.questionEndsAt = Date.now() + dur;
    room.pauseRemainingMs = null;
    io.to(pin).emit('question:resumed', { endsAt: room.questionEndsAt });
  });

  // Host requests to skip the video segment gating so players can answer now
  socket.on('host:skip_video', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    io.to(pin).emit('video:skip');
  });

  // Host requests to show current scores to all players
  socket.on('host:show_scores', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    const leaderboard = Array.from(room.players.values())
      .map(p => ({ name: p.name, score: p.score || 0 }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 50);
    io.to(pin).emit('scores:show', { leaderboard });
  });

  // Host ends the game and sends final leaderboard
  socket.on('host:end_game', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room || room.hostId !== socket.id) return;
    const leaderboard = Array.from(room.players.values())
      .map(p => ({ name: p.name, score: p.score || 0 }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 20);
    io.to(pin).emit('game:final', { leaderboard });
    io.to(pin).emit('room:ended');
    rooms.delete(pin);
  });

  socket.on('disconnect', () => {
    // clean up from all rooms
    for (const [pin, room] of rooms.entries()) {
      if (room.hostId === socket.id) {
        io.to(pin).emit('room:ended');
        rooms.delete(pin);
      } else if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(pin).emit('room:players', Array.from(room.players.values()));
      }
    }
  });
});

app.get('/', (_req, res) => res.send('Quiz Live server running'));
app.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// Chat wizard: ask next clarifying question or return final summary
app.post('/ai/plan', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'default');
    const partial = req.body?.answers || {};
    const s = getAiSession(sessionId);
    s.answers = { ...(s.answers||{}), ...(partial||{}) };

    const order = ['topic','level','count','style'];
    const labels = {
      topic: 'נושא החידון',
      level: 'גיל/רמת קהל היעד',
      count: 'מספר השאלות',
      style: 'סגנון/התמקדות (למשל היסטוריה, אישים, תאריכים)'
    };

    function normalize(a){
      const out = { ...a };
      if (out.count != null) {
        const n = Math.max(1, Math.min(20, Number(out.count)||8));
        out.count = n;
      }
      if (typeof out.topic === 'string') out.topic = out.topic.trim();
      if (typeof out.level === 'string') out.level = out.level.trim();
      if (typeof out.style === 'string') out.style = out.style.trim();
      return out;
    }

    s.answers = normalize(s.answers);
    const missing = order.find(k => !s.answers[k]);

    if (missing) {
      // Ask a short Hebrew question for the missing key via Gemini/OpenAI, with a safe fallback
      const context = `עד כה ידוע: topic="${s.answers.topic||''}", level="${s.answers.level||''}", count="${s.answers.count||''}", style="${s.answers.style||''}".`;
      const instruction = `נסח משפט שאלה קצר וברור בעברית כדי לבקש ${labels[missing]}. אל תוסיף הסברים. רק שאלה אחת.`;

      async function askWithGemini(){
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
        const r = await withTimeout(model.generateContent(`${context}\n${instruction}`), 4000);
        return (r?.response?.text() || '').trim();
      }
      async function askWithOpenAI(){
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const chat = await withTimeout(client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Write one short Hebrew question only. No explanations.' },
            { role: 'user', content: `${context}\n${instruction}` }
          ]
        }), 4000);
        return (chat.choices?.[0]?.message?.content || '').trim();
      }

      let question = '';
      try {
        if (process.env.GOOGLE_API_KEY) question = await askWithGemini();
        else if (process.env.OPENAI_API_KEY) question = await askWithOpenAI();
      } catch(_e) {}
      if (!question) {
        const defaults = {
          topic: 'על איזה נושא תרצה שהחידון יתמקד?',
          level: 'מה גיל או רמת קהל היעד?',
          count: 'כמה שאלות ליצור (1–20)?',
          style: 'איזה סגנון מועדף? (לדוגמה: תאריכים, אישים, עובדות קצרות)'
        };
        question = defaults[missing];
      }
      return res.json({ done: false, nextKey: missing, question });
    }

    // Done: build final summary and prompt for /ai/generate
    const summary = normalize(s.answers);
    const promptLines = [
      summary.topic || 'נושא כללי',
      summary.level ? `קהל יעד: ${summary.level}` : '',
      summary.style ? `סגנון: ${summary.style}` : ''
    ].filter(Boolean);
    const promptText = promptLines.join('\n');
    const count = summary.count || 8;
    return res.json({ done: true, summary, promptText, count });
  } catch (e) {
    res.status(400).json({ error: 'bad_request' });
  }
});

// Simple AI endpoint — returns mock questions when no OPENAI_API_KEY is provided
app.post('/ai/generate', async (req, res) => {
  try {
    const promptText = String(req.body?.promptText || '').trim();
    const count = Math.max(1, Math.min(20, Number(req.body?.count)||8));

    // 1) Prefer Gemini if GOOGLE_API_KEY is set
    if (process.env.GOOGLE_API_KEY) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: 'application/json' }
        });
        const prompt = [
          'אתה מחולל חידונים. חשוב: אל תעתיק את טקסט הקלט. אל תשתמש במילה "חידון" בגוף השאלות או האופציות. צור שאלות ידע קצרות וברורות על הנושא,',
          'עם 4 אפשרויות שונות וקצרות כאשר רק אחת נכונה. החזר אך ורק JSON תקין לפי הסכמה:',
          '{ "title": string, "questions": [ { "text": string, "options": string[4], "correct": number(0-3), "durationSec": number } ] }',
          'כללים:',
          '- 4 אופציות בלבד, שונות זו מזו, ללא חזרות, ללא תוויות כמו "נכון"/"טעות".',
          '- ניסוח קצר (עד 80 תווים לאופציה, ועד 120 תווים לשאלה).',
          '- אין להשתמש בביטוי "כתוב חידון" או בהוראות המשתמש כנוסח התשובות/שאלות.',
          '- אם הקלט הוא נושא כללי (כמו "דוד בן גוריון"), הפק שאלות עובדתיות עליו.',
          'דוגמה (פורמט בלבד, לא להחזיר את הדוגמה):',
          '{"title":"דוד בן גוריון","questions":[{"text":"באיזו שנה הוכרזה מדינת ישראל?","options":["1948","1936","1956","1967"],"correct":0,"durationSec":15}]}',
          `מספר שאלות: ${count}. נושא/טקסט מקור:\n${promptText || 'כללי'}`
        ].join('\n');
        const result = await withTimeout(model.generateContent(prompt), 6000);
        const content = result?.response?.text() || '{}';
        const parsed = JSON.parse(content);
        if (!parsed || !Array.isArray(parsed.questions)) throw new Error('bad_output');
        const qs = sanitizeQuestionList(parsed.questions, count, promptText);
        const title = String(parsed.title||'חידון חדש').slice(0,60);
        return res.json({ title, questions: qs });
      } catch (e) {
        // fall through to OpenAI or mock
      }
    }

    // 2) Else try OpenAI if available
    if (process.env.OPENAI_API_KEY) {
      try {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const sys = 'You generate factual multiple-choice questions in Hebrew. Output strictly valid JSON only with schema: { "title": string, "questions": [ { "text": string, "options": string[4], "correct": number(0-3), "durationSec": number } ] }. No markdown. Exactly 4 short distinct options. Do not copy or echo the user input. Do not use the word "חידון" in questions or options. durationSec ≈ 15.';
        const user = [
          `נושא/טקסט: ${promptText || 'כללי'}`,
          `מספר שאלות: ${count}`,
          'כללים:',
          '- שאלות עובדתיות קצרות וברורות.',
          '- 4 אופציות שונות וקצרות, רק אחת נכונה, ללא תוויות כמו נכון/טעות.',
          '- אל תעתיק את ההוראה "כתוב חידון" וכדומה.',
          'דוגמה מבנית (לא להחזיר את הטקסט הזה):',
          '{"title":"דוד בן גוריון","questions":[{"text":"באיזו שנה הוכרזה מדינת ישראל?","options":["1948","1936","1956","1967"],"correct":0,"durationSec":15}]}'
        ].join('\n');
        const chat = await withTimeout(client.chat.completions.create({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ]
        }), 6000);
        const content = chat.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(content);
        if (!parsed || !Array.isArray(parsed.questions)) throw new Error('bad_output');
        const qs = sanitizeQuestionList(parsed.questions, count, promptText);
        const title = String(parsed.title||'חידון חדש').slice(0,60);
        return res.json({ title, questions: qs });
      } catch (e) {
        // fall through to mock
      }
    }

    // 3) Mock generator as a safe fallback
    {
      const base = promptText || 'נושא כללי';
      const seeds = base
        .replace(/\r/g,'')
        .split(/\n+|[.!?]+\s+/)
        .map(s=>s.trim()).filter(Boolean);
      const qs = [];
      for (let i=0;i<count;i++){
        const s = seeds[i % Math.max(1,seeds.length)] || base;
        const text = `שאלה: ${s.slice(0,80)}`;
        const correct = Math.floor(Math.random()*4);
        const opts = [
          `${s.slice(0,24) || 'אפשרות א'}`,
          `${base.slice(2, 26) || 'אפשרות ב'}`,
          `${base.slice(4, 28) || 'אפשרות ג'}`,
          `${base.slice(6, 30) || 'אפשרות ד'}`
        ];
        qs.push({ text, options: opts, correct, durationSec: 15 });
      }
      return res.json({ title: 'חידון חדש', questions: sanitizeQuestionList(qs, count, promptText) });
    }
  } catch (e) {
    res.status(400).json({ error: 'bad_request' });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
