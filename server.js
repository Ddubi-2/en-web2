import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(__dirname));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중 → http://localhost:${PORT}`);
});
