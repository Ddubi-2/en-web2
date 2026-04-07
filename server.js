import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import multer from 'multer';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function requireOpenAI(req, res, next) {
  if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.' });
  next();
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'english-study.html'));
});

// data.json에서 DATA를 읽어 context 문자열로 변환
function buildContext() {
  let DATA;
  try {
    DATA = JSON.parse(readFileSync(join(__dirname, 'data.json'), 'utf-8'));
  } catch {
    return '';
  }

  const lines = [];

  lines.push('=== 표현/숙어 목록 ===');
  for (const p of DATA.phrases) {
    lines.push(`[${p.id}] ${p.en} → ${p.ko} (카테고리: ${p.cat}, 레벨: ${p.level || ''})`);
    if (p.examples && p.examples.length > 0)
      lines.push(`  예문: "${p.examples[0].en}" → "${p.examples[0].ko}"`);
    if (p.nuance) lines.push(`  뉘앙스: ${p.nuance}`);
  }

  lines.push('\n=== 상황별 예문 목록 ===');
  for (const s of DATA.sentences) {
    lines.push(`[${s.id}] ${s.en} → ${s.ko} (카테고리: ${s.cat})`);
  }

  return lines.join('\n');
}

const CONTEXT = buildContext();

// data.json을 클라이언트에 제공하는 API
app.get('/api/data', (req, res) => {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'data.json'), 'utf-8'));
    res.json(data);
  } catch (err) {
    console.error('data.json 읽기 오류:', err.message);
    res.status(500).json({ error: '데이터를 불러올 수 없습니다.' });
  }
});

const SYSTEM_PROMPT = `당신은 영어 회화 학습 앱의 AI 도우미입니다.
아래는 앱에 등록된 표현, 숙어, 예문 데이터입니다. 이 데이터를 참고하여 사용자 질문에 답변하세요.

${CONTEXT}

답변 규칙:
- 한국어로 친절하고 자연스럽게 답변하세요.
- 앱 데이터에 관련 표현이 있으면 구체적으로 인용해 주세요.
- 사용법, 뉘앙스, 비슷한 표현 비교 등 학습에 도움되는 내용을 포함하세요.
- 답변은 간결하되 실용적으로 작성하세요.`;

app.post('/api/ask', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: '잘못된 요청 형식입니다.' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    res.json({ answer: response.content[0].text });
  } catch (err) {
    console.error('Claude API 오류:', err.message);
    res.status(500).json({ error: 'AI 응답 중 오류가 발생했습니다.' });
  }
});

/* ── 음성 대화 ── */

const VOICE_SYSTEM_PROMPT = `You are a friendly English conversation partner helping Korean learners practice English.
Rules:
- Always reply in English (short, natural sentences — 1~3 sentences max).
- After your English reply, add a Korean translation on a new line starting with "🇰🇷 ".
- Gently correct grammar mistakes if any, starting with "💡 ".
- Keep the conversation going by asking a follow-up question.
- Be encouraging and positive.`;

// 1. STT: 오디오 → 텍스트 (Whisper)
app.post('/api/voice/transcribe', requireOpenAI, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '오디오 파일이 없습니다.' });

  // 클라이언트가 보낸 파일명에서 확장자 추출 (webm / mp4 / ogg)
  const origName = req.file.originalname || 'voice.webm';
  const ext      = origName.split('.').pop() || 'webm';
  const tmpPath  = join(__dirname, `_tmp_${Date.now()}.${ext}`);

  try {
    writeFileSync(tmpPath, req.file.buffer);
    const result = await openai.audio.transcriptions.create({
      file:     createReadStream(tmpPath),
      model:    'whisper-1',
      language: 'en',
    });
    res.json({ text: result.text });
  } catch (err) {
    console.error('Whisper 오류:', err.message);
    res.status(500).json({ error: `음성 인식 실패: ${err.message}` });
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
});

// 2. Chat: 텍스트 → Claude 답변
app.post('/api/voice/chat', requireOpenAI, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '잘못된 요청입니다.' });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: VOICE_SYSTEM_PROMPT,
      messages,
    });
    res.json({ answer: response.content[0].text });
  } catch (err) {
    console.error('Claude 음성 대화 오류:', err.message);
    res.status(500).json({ error: 'AI 응답 중 오류가 발생했습니다.' });
  }
});

// 3. TTS: 텍스트 → 음성 (OpenAI TTS)
app.post('/api/voice/speak', requireOpenAI, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '텍스트가 없습니다.' });
  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'nova',
      input: text,
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('TTS 오류:', err.message);
    res.status(500).json({ error: '음성 생성에 실패했습니다.' });
  }
});

// 번역 채점 API
app.post('/api/translate/check', async (req, res) => {
  const { ko, en, userAnswer } = req.body;
  if (!ko || !en || !userAnswer) return res.status(400).json({ error: '잘못된 요청입니다.' });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are an English writing evaluator for Korean learners. Evaluate the user's English translation and respond ONLY with valid JSON — no markdown, no extra text.`,
      messages: [{
        role: 'user',
        content: `Korean sentence: "${ko}"
Model answer: "${en}"
User's answer: "${userAnswer}"

Evaluate whether the user's answer is correct or acceptable (same meaning, even if different wording).
Respond with JSON exactly like this:
{
  "correct": true or false,
  "feedback": "한국어로 짧게 (1~2문장): 정답이면 칭찬, 틀렸으면 어디가 틀렸는지 구체적으로",
  "hint": "한국어로 (틀렸을 때만): 올바른 표현을 위한 핵심 힌트 1가지, 정답이면 빈 문자열",
  "wordNotes": "한국어로 (1~2문장): 모범 답안의 핵심 단어나 표현이 이 맥락에서 왜 자연스러운지 설명. 비슷한 단어와의 뉘앙스 차이도 언급",
  "alternatives": ["같은 의미의 자연스러운 대안 표현 1 (영어)", "같은 의미의 자연스러운 대안 표현 2 (영어)"]
}`,
      }],
    });

    let raw = response.content[0].text.trim();
    raw = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    const result = JSON.parse(raw);
    res.json(result);
  } catch (err) {
    console.error('번역 채점 오류:', err.message);
    res.status(500).json({ error: 'AI 채점 중 오류가 발생했습니다.' });
  }
});

import { networkInterfaces } from 'os';

function getLocalIP() {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const ip = getLocalIP();
  console.log(`서버 실행 중`);
  console.log(`  PC:     http://localhost:${PORT}`);
  console.log(`  휴대폰: http://${ip}:${PORT}  (같은 와이파이 필요)`);
});
