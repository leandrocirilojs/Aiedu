const $ = (id) => document.getElementById(id);
let currentResult = null;
let selectedFile = null;
let loaderInterval = null;
let abortController = null;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ============ Mapa de seções (campos do JSON gerado) ============ */
const sectionsMap = {
  visaoGeral: [
    ['visaoGeral', 'Visão geral do tema'],
    ['conceitos', 'Conceitos principais']
  ],
  resumo: [['resumo', 'Resumo simplificado']],
  explicacao: [
    ['explicacao', 'Explicação detalhada'],
    ['exemplos', 'Exemplos práticos'],
    ['mapaMental', 'Mapa mental textual']
  ],
  plano: [['plano', 'Plano de estudo']],
  revisao: [['revisao', 'Revisão final']]
};

/* ============ Inicialização ============ */
window.addEventListener('DOMContentLoaded', () => {
  $('apiKey').value = localStorage.getItem('groq_api_key') || '';
  $('modelSelect').value = localStorage.getItem('eduai_model') || 'llama-3.3-70b-versatile';
  bindEvents();
  renderHistory();
});

function bindEvents() {
  $('saveKey').onclick = () => {
    localStorage.setItem('groq_api_key', $('apiKey').value.trim());
    toast('Chave salva no navegador.');
  };
  $('modelSelect').onchange = () => localStorage.setItem('eduai_model', $('modelSelect').value);

  document.querySelectorAll('[data-main-tab]').forEach(btn => btn.onclick = () => switchMainTab(btn.dataset.mainTab));
  document.querySelectorAll('[data-section]').forEach(btn => btn.onclick = () => showSection(btn.dataset.section));

  $('generateTopic').onclick = generateFromTopic;
  $('topicInput').addEventListener('keydown', e => { if (e.key === 'Enter') generateFromTopic(); });
  $('processFile').onclick = generateFromFile;

  $('fileInput').onchange = (e) => setFile(e.target.files[0]);

  const dz = $('dropZone');
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]); });

  $('copyResult').onclick = async () => {
    if (!currentResult) return;
    await navigator.clipboard.writeText(buildRawText(currentResult));
    toast('Conteúdo copiado!');
  };
  $('downloadTxt').onclick = downloadTxt;
  $('downloadPdf').onclick = downloadPdf;
  $('downloadAnki').onclick = downloadAnkiCsv;

  $('openHistory').onclick = openHistory;
  $('closeHistory').onclick = closeHistory;
  $('clearHistory').onclick = () => {
    if (confirm('Apagar todo o histórico de estudos?')) {
      localStorage.setItem('eduai_history', '[]');
      renderHistory();
      toast('Histórico apagado.');
    }
  };

  $('cancelGen').onclick = () => { if (abortController) abortController.abort(); };

  $('historyList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (btn.dataset.act === 'open') loadHistory(idx);
    if (btn.dataset.act === 'del') deleteHistory(idx);
  });

  $('resultContent').addEventListener('click', onResultContentClick);
}

function setFile(file) {
  selectedFile = file || null;
  $('fileName').textContent = selectedFile ? `Arquivo selecionado: ${selectedFile.name}` : '';
}

function switchMainTab(tab) {
  document.querySelectorAll('[data-main-tab]').forEach(b => b.classList.toggle('active', b.dataset.mainTab === tab));
  $('inputView').classList.toggle('active', tab === 'input');
  $('resultsView').classList.toggle('active', tab === 'results');
  $('historyView').classList.add('hidden');
}

/* ============ Geração ============ */
async function generateFromTopic() {
  const topic = $('topicInput').value.trim();
  const level = $('topicLevel').value;
  if (!topic) return toast('Digite um tema primeiro.', 'warn');
  await generateContent({ title: topic, level, content: topic, type: 'Tema manual' });
}

async function generateFromFile() {
  if (!selectedFile) return toast('Escolha um arquivo primeiro.', 'warn');
  if (selectedFile.size > 10 * 1024 * 1024) return toast('O arquivo deve ter no máximo 10MB.', 'warn');
  const level = $('fileLevel').value;
  const apiKey = getApiKey();
  if (!apiKey) return;
  showLoader();
  try {
    setLoaderText('Extraindo texto do arquivo...');
    const text = await extractFileText(selectedFile);
    if (!text.trim()) throw new Error('Não foi possível extrair texto do arquivo.');
    const content = await prepareContent(text, apiKey);
    await generateContent({ title: selectedFile.name, level, content, type: 'Arquivo' }, true);
  } catch (err) {
    hideLoader();
    if (err.name !== 'AbortError') toast(err.message, 'error');
    else toast('Geração cancelada.');
  }
}

async function extractFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'txt') return await file.text();
  if (ext === 'pdf') {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }
    return text;
  }
  if (ext === 'docx') {
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
  }
  throw new Error('Formato não suportado. Use PDF, DOCX ou TXT.');
}

/* Chunking inteligente: documentos longos são resumidos por partes antes da geração final */
const DIRECT_LIMIT = 24000;
const CHUNK_SIZE = 12000;
const MAX_CHUNKS = 8;

async function prepareContent(text, apiKey) {
  if (text.length <= DIRECT_LIMIT) return text;
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    setLoaderText(`Documento longo: resumindo parte ${i + 1} de ${chunks.length}...`);
    const summary = await callGroq(apiKey, [{
      role: 'user',
      content: `Resuma o texto abaixo de forma densa e fiel, preservando conceitos, definições, exemplos, números e termos técnicos importantes. Responda apenas com o resumo, em português.\n\n${chunks[i]}`
    }], { maxTokens: 1200 });
    summaries.push(summary);
  }
  return 'Resumo consolidado de um documento longo (gerado por partes):\n\n' + summaries.join('\n\n');
}

async function generateContent(payload, loaderAlreadyOpen = false) {
  const apiKey = getApiKey();
  if (!apiKey) return;
  if (!loaderAlreadyOpen) showLoader();
  try {
    setLoaderText('Gerando material de estudo...');
    const raw = await callGroq(apiKey, [{ role: 'user', content: buildStudyPrompt(payload.content, payload.level) }], {
      json: true,
      maxTokens: 8000
    });
    const data = parseJsonLoose(raw);
    if (!data || !data.visaoGeral) throw new Error('A IA retornou um formato inesperado. Tente novamente.');
    normalizeData(data);
    currentResult = {
      id: Date.now(),
      title: payload.title,
      level: payload.level,
      type: payload.type,
      date: new Date().toLocaleString('pt-BR'),
      data
    };
    saveHistory(currentResult);
    renderResult(currentResult);
    switchMainTab('results');
    toast('Material gerado com sucesso!');
  } catch (err) {
    if (err.name === 'AbortError') toast('Geração cancelada.');
    else toast('Erro ao gerar: ' + err.message, 'error');
  } finally {
    hideLoader();
  }
}

function buildStudyPrompt(content, level) {
  return `Você é uma IA educacional especialista em transformar qualquer tema ou conteúdo em material de estudo completo, em português do Brasil.

Tema ou conteúdo base:
${content}

Nível do aluno: ${level}

Responda APENAS com um objeto JSON válido (sem texto antes ou depois, sem cercas de código), exatamente com estas chaves:
{
  "visaoGeral": "texto em Markdown",
  "conceitos": "texto em Markdown (lista dos conceitos principais)",
  "resumo": "texto em Markdown",
  "explicacao": "texto em Markdown (explicação detalhada)",
  "exemplos": "texto em Markdown (exemplos práticos)",
  "mapaMental": "texto em Markdown (mapa mental textual com hierarquia em listas)",
  "quiz": [
    { "pergunta": "...", "alternativas": ["...", "...", "...", "..."], "correta": 0, "explicacao": "..." }
  ],
  "flashcards": [
    { "frente": "...", "verso": "..." }
  ],
  "plano": "texto em Markdown (plano de estudo passo a passo)",
  "revisao": "texto em Markdown (revisão final com os pontos-chave)"
}

Regras:
- "quiz": exatamente 6 perguntas; "correta" é o índice (0 a 3) da alternativa certa; "explicacao" justifica a resposta.
- "flashcards": exatamente 8 cartões com frente curta (pergunta/termo) e verso objetivo (resposta/definição).
- Nos textos em Markdown use apenas: ### subtítulos, **negrito**, listas com "-" e listas numeradas.
- Linguagem clara, envolvente e adaptada ao nível "${level}".`;
}

/* ============ Groq API ============ */
function getApiKey() {
  const key = $('apiKey').value.trim() || localStorage.getItem('groq_api_key');
  if (!key) { toast('Informe sua chave da Groq primeiro.', 'warn'); return null; }
  return key;
}

async function callGroq(apiKey, messages, { json = false, maxTokens = 2000 } = {}) {
  const body = {
    model: $('modelSelect').value || 'llama-3.3-70b-versatile',
    messages,
    temperature: 0.5,
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: abortController ? abortController.signal : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Falha desconhecida');
  return data.choices?.[0]?.message?.content || '';
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) {}
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function normalizeData(data) {
  if (!Array.isArray(data.quiz)) data.quiz = [];
  if (!Array.isArray(data.flashcards)) data.flashcards = [];
  data.quiz = data.quiz.filter(q => q && q.pergunta && Array.isArray(q.alternativas) && q.alternativas.length >= 2);
  data.quiz.forEach(q => { q.correta = Math.min(Math.max(Number(q.correta) || 0, 0), q.alternativas.length - 1); });
  data.flashcards = data.flashcards.filter(c => c && c.frente && c.verso);
}

/* ============ Renderização ============ */
function renderResult(result) {
  $('emptyResult').classList.add('hidden');
  $('resultBox').classList.remove('hidden');
  $('resultTitle').textContent = result.title;
  $('resultMeta').textContent = `${result.type} • ${result.level} • ${result.date}`;
  result._answers = result._answers || {};
  showSection('visaoGeral');
}

function showSection(section) {
  if (!currentResult) return;
  document.querySelectorAll('[data-section]').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  const box = $('resultContent');

  // Compatibilidade com histórico antigo (texto bruto em Markdown)
  if (!currentResult.data) {
    box.innerHTML = `<p class="legacy-note">Sessão antiga: quiz e flashcards interativos só estão disponíveis em materiais novos.</p>` +
      legacyMarkdown(currentResult.raw || '');
    return;
  }

  if (section === 'quiz') return renderQuiz();
  if (section === 'flashcards') return renderFlashcards();

  let html = '';
  for (const [field, label] of sectionsMap[section]) {
    if (currentResult.data[field]) {
      html += `<h3>${escapeHtml(label)}</h3>` + markdownToHtml(currentResult.data[field]);
    }
  }
  box.innerHTML = html || '<p>Seção vazia.</p>';
}

/* ============ Quiz interativo ============ */
function renderQuiz() {
  const quiz = currentResult.data.quiz;
  const answers = currentResult._answers;
  if (!quiz.length) { $('resultContent').innerHTML = '<p>Nenhuma questão gerada.</p>'; return; }

  const answered = Object.keys(answers).length;
  const correct = quiz.reduce((acc, q, i) => acc + (answers[i] === q.correta ? 1 : 0), 0);
  const wrongCount = answered - correct;

  let html = `<div class="quiz-score">Pontuação: <strong>${correct}</strong> de ${answered} respondidas (${quiz.length} questões)</div>`;

  quiz.forEach((q, qi) => {
    const chosen = answers[qi];
    const done = chosen !== undefined;
    html += `<div class="q-item">
      <p class="q-text"><strong>${qi + 1}.</strong> ${escapeHtml(q.pergunta)}</p>
      <div class="q-alts">`;
    q.alternativas.forEach((alt, ai) => {
      let cls = 'alt';
      if (done) {
        if (ai === q.correta) cls += ' correct';
        else if (ai === chosen) cls += ' wrong';
        cls += ' locked';
      }
      html += `<button class="${cls}" data-quiz-q="${qi}" data-quiz-a="${ai}" ${done ? 'disabled' : ''}>
        <span class="alt-letter">${String.fromCharCode(65 + ai)}</span> ${escapeHtml(alt)}
      </button>`;
    });
    html += `</div>`;
    if (done) {
      const ok = chosen === q.correta;
      html += `<div class="q-expl ${ok ? 'ok' : 'nok'}">
        <strong>${ok ? '✔ Correto!' : '✘ Incorreto.'}</strong> ${escapeHtml(q.explicacao || '')}
      </div>`;
    }
    html += `</div>`;
  });

  if (answered === quiz.length) {
    html += `<div class="quiz-final">
      <h3>Resultado: ${correct}/${quiz.length} (${Math.round((correct / quiz.length) * 100)}%)</h3>
      <div class="quiz-final-actions">
        <button class="primary-btn slim" data-action="more-questions">${wrongCount > 0 ? '🎯 Praticar meus erros (+5 questões)' : '➕ Gerar mais 5 questões'}</button>
        <button class="ghost-btn" data-action="reset-quiz">↺ Refazer quiz</button>
      </div>
    </div>`;
  }

  $('resultContent').innerHTML = html;
}

function onResultContentClick(e) {
  const altBtn = e.target.closest('button[data-quiz-q]');
  if (altBtn && !altBtn.disabled) {
    const qi = Number(altBtn.dataset.quizQ);
    currentResult._answers[qi] = Number(altBtn.dataset.quizA);
    renderQuiz();
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'more-questions') generateMoreQuestions();
  if (action === 'reset-quiz') { currentResult._answers = {}; renderQuiz(); }
  if (action === 'flip-card') e.target.closest('.fc-card').classList.toggle('flipped');
  if (action === 'start-review') startReview();
  if (action === 'show-answer') { $('srsCard').classList.add('flipped'); $('srsGrades').classList.remove('hidden'); $('showAnswerBtn').classList.add('hidden'); }
  if (action === 'grade') gradeCard(e.target.closest('[data-grade]').dataset.grade);
  if (action === 'exit-review') renderFlashcards();
}

async function generateMoreQuestions() {
  const apiKey = getApiKey();
  if (!apiKey) return;
  const quiz = currentResult.data.quiz;
  const answers = currentResult._answers;
  const wrong = quiz.filter((q, i) => answers[i] !== undefined && answers[i] !== q.correta);
  const focus = wrong.length
    ? 'O aluno errou estas questões, foque nos mesmos pontos fracos:\n' + wrong.map(q => '- ' + q.pergunta).join('\n')
    : 'O aluno acertou tudo, aumente um pouco a dificuldade.';

  showLoader();
  setLoaderText('Criando novas questões...');
  try {
    const raw = await callGroq(apiKey, [{
      role: 'user',
      content: `Sobre o tema "${currentResult.title}" (nível ${currentResult.level}), em português do Brasil.\n${focus}\n\nResponda APENAS com JSON válido no formato:\n{"quiz":[{"pergunta":"...","alternativas":["...","...","...","..."],"correta":0,"explicacao":"..."}]}\nGere exatamente 5 questões novas, diferentes das anteriores.`
    }], { json: true, maxTokens: 3000 });
    const data = parseJsonLoose(raw);
    if (!data || !Array.isArray(data.quiz) || !data.quiz.length) throw new Error('Formato inesperado, tente de novo.');
    normalizeData(data);
    currentResult.data.quiz = currentResult.data.quiz.concat(data.quiz);
    saveHistory(currentResult);
    renderQuiz();
    toast(`${data.quiz.length} novas questões adicionadas!`);
  } catch (err) {
    if (err.name !== 'AbortError') toast('Erro: ' + err.message, 'error');
  } finally {
    hideLoader();
  }
}

/* ============ Flashcards + repetição espaçada (SM-2 simplificado) ============ */
function srsKey(id) { return 'eduai_srs_' + id; }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function loadSrs(result) {
  let srs = null;
  try { srs = JSON.parse(localStorage.getItem(srsKey(result.id)) || 'null'); } catch (e) {}
  const n = result.data.flashcards.length;
  if (!srs || srs.length !== n) {
    srs = result.data.flashcards.map((_, i) => ({ i, interval: 0, ease: 2.5, due: todayStr(), reps: 0 }));
  }
  return srs;
}
function saveSrs(result, srs) { localStorage.setItem(srsKey(result.id), JSON.stringify(srs)); }

function renderFlashcards() {
  const cards = currentResult.data.flashcards;
  if (!cards.length) { $('resultContent').innerHTML = '<p>Nenhum flashcard gerado.</p>'; return; }
  const srs = loadSrs(currentResult);
  const due = srs.filter(c => c.due <= todayStr()).length;

  let html = `<div class="fc-toolbar">
    <button class="primary-btn slim" data-action="start-review">🧠 Revisar agora (${due} para hoje)</button>
    <span class="fc-hint">Toque em um cartão para virar</span>
  </div><div class="fc-grid">`;

  cards.forEach((c, i) => {
    const meta = srs[i];
    html += `<div class="fc-card" data-action="flip-card">
      <div class="fc-inner">
        <div class="fc-face fc-front"><small>FRENTE</small><p>${escapeHtml(c.frente)}</p></div>
        <div class="fc-face fc-back"><small>VERSO</small><p>${escapeHtml(c.verso)}</p>
          <span class="fc-meta">próxima revisão: ${meta.due <= todayStr() ? 'hoje' : meta.due.split('-').reverse().join('/')}</span>
        </div>
      </div>
    </div>`;
  });
  html += `</div>`;
  $('resultContent').innerHTML = html;
}

let reviewQueue = [];
let reviewSrs = null;

function startReview() {
  reviewSrs = loadSrs(currentResult);
  reviewQueue = reviewSrs.filter(c => c.due <= todayStr()).map(c => c.i);
  if (!reviewQueue.length) return toast('Nenhum cartão para revisar hoje. Volte amanhã!');
  renderReviewCard();
}

function renderReviewCard() {
  if (!reviewQueue.length) {
    $('resultContent').innerHTML = `<div class="srs-done">
      <h3>🎉 Revisão concluída!</h3>
      <p>Todos os cartões de hoje foram revisados. A repetição espaçada vai trazê-los de volta na hora certa.</p>
      <button class="ghost-btn" data-action="exit-review">← Voltar aos flashcards</button>
    </div>`;
    return;
  }
  const idx = reviewQueue[0];
  const card = currentResult.data.flashcards[idx];
  $('resultContent').innerHTML = `
    <div class="srs-top">
      <button class="ghost-btn" data-action="exit-review">← Sair</button>
      <span>${reviewQueue.length} restante(s)</span>
    </div>
    <div class="fc-card srs-card" id="srsCard">
      <div class="fc-inner">
        <div class="fc-face fc-front"><small>FRENTE</small><p>${escapeHtml(card.frente)}</p></div>
        <div class="fc-face fc-back"><small>VERSO</small><p>${escapeHtml(card.verso)}</p></div>
      </div>
    </div>
    <button class="primary-btn slim" id="showAnswerBtn" data-action="show-answer">Mostrar resposta</button>
    <div id="srsGrades" class="srs-grades hidden">
      <button class="grade-btn g-again" data-action="grade" data-grade="again">Errei</button>
      <button class="grade-btn g-good" data-action="grade" data-grade="good">Bom</button>
      <button class="grade-btn g-easy" data-action="grade" data-grade="easy">Fácil</button>
    </div>`;
}

function gradeCard(grade) {
  const idx = reviewQueue.shift();
  const card = reviewSrs[idx];
  if (grade === 'again') {
    card.interval = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.due = todayStr();
    card.reps = 0;
    reviewQueue.push(idx); // volta para o fim da fila de hoje
  } else if (grade === 'good') {
    card.interval = card.interval ? Math.round(card.interval * card.ease) : 1;
    card.due = addDays(card.interval);
    card.reps++;
  } else if (grade === 'easy') {
    card.interval = card.interval ? Math.round(card.interval * card.ease * 1.3) : 3;
    card.ease += 0.1;
    card.due = addDays(card.interval);
    card.reps++;
  }
  saveSrs(currentResult, reviewSrs);
  renderReviewCard();
}

/* ============ Markdown → HTML (com escape) ============ */
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markdownToHtml(text) {
  const lines = escapeHtml(text).split('\n');
  let html = '', inUl = false, inOl = false;
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };
  const inline = s => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  for (const lineRaw of lines) {
    const t = lineRaw.trim();
    if (/^[-*•]\s+/.test(t)) {
      if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
      html += '<li>' + inline(t.replace(/^[-*•]\s+/, '')) + '</li>';
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
      html += '<li>' + inline(t.replace(/^\d+[.)]\s+/, '')) + '</li>';
      continue;
    }
    closeLists();
    if (/^###/.test(t)) html += '<h4>' + inline(t.replace(/^#+\s*/, '')) + '</h4>';
    else if (/^##/.test(t)) html += '<h3>' + inline(t.replace(/^#+\s*/, '')) + '</h3>';
    else if (t) html += '<p>' + inline(t) + '</p>';
  }
  closeLists();
  return html;
}

function legacyMarkdown(text) {
  return escapeHtml(text)
    .replace(/^###?\s*(.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

/* ============ Exportações ============ */
function buildRawText(result) {
  if (!result.data) return result.raw || '';
  const d = result.data;
  let out = `${result.title}\n${result.type} • ${result.level} • ${result.date}\n\n`;
  const block = (label, txt) => txt ? `## ${label}\n${txt}\n\n` : '';
  out += block('Visão geral do tema', d.visaoGeral);
  out += block('Conceitos principais', d.conceitos);
  out += block('Resumo simplificado', d.resumo);
  out += block('Explicação detalhada', d.explicacao);
  out += block('Exemplos práticos', d.exemplos);
  out += block('Mapa mental textual', d.mapaMental);
  if (d.quiz.length) {
    out += '## Quiz\n';
    d.quiz.forEach((q, i) => {
      out += `${i + 1}. ${q.pergunta}\n`;
      q.alternativas.forEach((a, ai) => out += `   ${String.fromCharCode(65 + ai)}) ${a}\n`);
      out += `   Resposta: ${String.fromCharCode(65 + q.correta)} — ${q.explicacao || ''}\n\n`;
    });
  }
  if (d.flashcards.length) {
    out += '## Flashcards\n';
    d.flashcards.forEach((c, i) => out += `${i + 1}. Frente: ${c.frente}\n   Verso: ${c.verso}\n`);
    out += '\n';
  }
  out += block('Plano de estudo', d.plano);
  out += block('Revisão final', d.revisao);
  return out;
}

function safeFilename(name) { return name.replace(/[^a-z0-9]/gi, '_').slice(0, 60); }

function downloadTxt() {
  if (!currentResult) return;
  const blob = new Blob([buildRawText(currentResult)], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${safeFilename(currentResult.title)}_eduai.txt`);
}

function downloadPdf() {
  if (!currentResult) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageH = doc.internal.pageSize.getHeight();
  let y = 20;

  const write = (txt, size, bold = false) => {
    doc.setFontSize(size);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    const clean = String(txt).replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^[-*•]\s+/gm, '• ');
    const lines = doc.splitTextToSize(clean, 176);
    for (const ln of lines) {
      if (y > pageH - 18) { doc.addPage(); y = 20; }
      doc.text(ln, 17, y);
      y += size * 0.5;
    }
    y += 3;
  };

  write(currentResult.title, 18, true);
  write(`${currentResult.type} • ${currentResult.level} • ${currentResult.date}`, 10);
  y += 4;

  const raw = buildRawText(currentResult);
  raw.split(/^## /m).slice(1).forEach(section => {
    const nl = section.indexOf('\n');
    write(section.slice(0, nl), 14, true);
    write(section.slice(nl + 1).trim(), 11);
    y += 2;
  });

  doc.save(`${safeFilename(currentResult.title)}_eduai.pdf`);
  toast('PDF gerado!');
}

function downloadAnkiCsv() {
  if (!currentResult?.data?.flashcards?.length) return toast('Este material não tem flashcards.', 'warn');
  const esc = s => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = currentResult.data.flashcards.map(c => `${esc(c.frente)},${esc(c.verso)}`).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, `${safeFilename(currentResult.title)}_anki.csv`);
  toast('CSV pronto! No Anki: Arquivo → Importar.');
}

function triggerDownload(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

/* ============ Histórico ============ */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('eduai_history') || '[]'); } catch (e) { return []; }
}

function saveHistory(item) {
  const list = getHistory();
  const clean = { ...item };
  delete clean._answers;
  const existing = list.findIndex(h => h.id === item.id);
  if (existing >= 0) list[existing] = clean;
  else list.unshift(clean);
  localStorage.setItem('eduai_history', JSON.stringify(list.slice(0, 20)));
  renderHistory();
}

function renderHistory() {
  const list = getHistory();
  if (!list.length) {
    $('historyList').innerHTML = `<article class="result-card empty"><h2>Nenhuma sessão encontrada</h2><p>Comece a estudar agora mesmo!</p></article>`;
    return;
  }
  $('historyList').innerHTML = list.map((item, index) => `
    <div class="history-item">
      <div><strong>${escapeHtml(item.title)}</strong><br><small>${escapeHtml(item.type || '')} • ${escapeHtml(item.level || '')} • ${escapeHtml(item.date || '')}</small></div>
      <div class="history-actions">
        <button data-act="open" data-idx="${index}">Continuar</button>
        <button data-act="del" data-idx="${index}" class="danger">✕</button>
      </div>
    </div>`).join('');
}

function loadHistory(index) {
  const list = getHistory();
  if (!list[index]) return;
  currentResult = list[index];
  closeHistory();
  renderResult(currentResult);
  switchMainTab('results');
}

function deleteHistory(index) {
  const list = getHistory();
  const removed = list.splice(index, 1)[0];
  if (removed?.id) localStorage.removeItem(srsKey(removed.id));
  localStorage.setItem('eduai_history', JSON.stringify(list));
  renderHistory();
  toast('Sessão removida.');
}

function openHistory() {
  $('historyView').classList.remove('hidden');
  $('inputView').classList.remove('active');
  $('resultsView').classList.remove('active');
}
function closeHistory() { $('historyView').classList.add('hidden'); switchMainTab('input'); }

/* ============ Loader + Toasts ============ */
function setLoaderText(t) { $('loaderText').textContent = t; }

function showLoader() {
  abortController = new AbortController();
  const messages = ['Analisando conteúdo...', 'Identificando conceitos principais...', 'Criando resumo...', 'Gerando quiz...', 'Montando flashcards...', 'Organizando plano de estudo...'];
  let i = 0;
  $('loader').classList.remove('hidden');
  setLoaderText(messages[0]);
  clearInterval(loaderInterval);
  loaderInterval = setInterval(() => { i = (i + 1) % messages.length; setLoaderText(messages[i]); }, 1800);
}

function hideLoader() {
  clearInterval(loaderInterval);
  $('loader').classList.add('hidden');
  abortController = null;
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}
