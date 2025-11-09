const dotenv = require('dotenv'); dotenv.config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const defaultOrigins = ['http://localhost:5173','http://127.0.0.1:5173','https://shaalkal.web.app'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean) : defaultOrigins);
app.use(cors({ origin: allowedOrigins, methods: ['GET','POST','OPTIONS'], credentials: true }));
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ['GET','POST','OPTIONS'], credentials: true } });

// In-memory store for MVP
const rooms = new Map();

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

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
