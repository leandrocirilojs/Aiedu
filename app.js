const $ = (id) => document.getElementById(id);
let currentResult = null;
let selectedFile = null;
let loaderInterval = null;

const sectionsMap = {
  visaoGeral: ['Visão geral do tema', 'Conceitos principais'],
  resumo: ['Resumo simplificado'],
  explicacao: ['Explicação detalhada', 'Exemplos práticos', 'Mapa mental textual'],
  quiz: ['Quiz'],
  flashcards: ['Flashcards'],
  plano: ['Plano de estudo'],
  revisao: ['Revisão final']
};

window.addEventListener('DOMContentLoaded', () => {
  $('apiKey').value = localStorage.getItem('groq_api_key') || '';
  bindEvents();
  renderHistory();
});

function bindEvents(){
  $('saveKey').onclick = () => {
    localStorage.setItem('groq_api_key', $('apiKey').value.trim());
    alert('Chave salva no navegador.');
  };

  document.querySelectorAll('[data-main-tab]').forEach(btn => btn.onclick = () => switchMainTab(btn.dataset.mainTab));
  document.querySelectorAll('[data-section]').forEach(btn => btn.onclick = () => showSection(btn.dataset.section));

  $('generateTopic').onclick = generateFromTopic;
  $('processFile').onclick = generateFromFile;
  $('fileInput').onchange = (e) => {
    selectedFile = e.target.files[0];
    $('fileName').textContent = selectedFile ? `Arquivo selecionado: ${selectedFile.name}` : '';
  };

  $('copyResult').onclick = () => navigator.clipboard.writeText(currentResult?.raw || '');
  $('downloadTxt').onclick = downloadTxt;
  $('openHistory').onclick = openHistory;
  $('closeHistory').onclick = closeHistory;
}

function switchMainTab(tab){
  document.querySelectorAll('[data-main-tab]').forEach(b => b.classList.toggle('active', b.dataset.mainTab === tab));
  $('inputView').classList.toggle('active', tab === 'input');
  $('resultsView').classList.toggle('active', tab === 'results');
}

async function generateFromTopic(){
  const topic = $('topicInput').value.trim();
  const level = $('topicLevel').value;
  if(!topic) return alert('Digite um tema primeiro.');
  await generateContent({ title: topic, level, content: topic, type: 'Tema manual' });
}

async function generateFromFile(){
  if(!selectedFile) return alert('Escolha um arquivo primeiro.');
  if(selectedFile.size > 10 * 1024 * 1024) return alert('O arquivo deve ter no máximo 10MB.');
  const level = $('fileLevel').value;
  showLoader();
  try{
    const text = await extractFileText(selectedFile);
    if(!text.trim()) throw new Error('Não foi possível extrair texto do arquivo.');
    await generateContent({ title: selectedFile.name, level, content: text.slice(0, 18000), type: 'Arquivo' }, true);
  }catch(err){
    hideLoader();
    alert(err.message);
  }
}

async function extractFileText(file){
  const ext = file.name.split('.').pop().toLowerCase();
  if(ext === 'txt') return await file.text();
  if(ext === 'pdf'){
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let text = '';
    for(let i = 1; i <= pdf.numPages; i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }
    return text;
  }
  if(ext === 'docx'){
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
  }
  throw new Error('Formato não suportado. Use PDF, DOCX ou TXT.');
}

async function generateContent(payload, loaderAlreadyOpen = false){
  const apiKey = $('apiKey').value.trim() || localStorage.getItem('groq_api_key');
  if(!apiKey) return alert('Informe sua chave da Groq primeiro.');
  if(!loaderAlreadyOpen) showLoader();
  try{
    const raw = await callGroq(apiKey, payload.content, payload.level);
    currentResult = { ...payload, raw, date: new Date().toLocaleString('pt-BR') };
    saveHistory(currentResult);
    renderResult(currentResult);
    switchMainTab('results');
  }catch(err){
    alert('Erro ao chamar a Groq: ' + err.message);
  }finally{
    hideLoader();
  }
}

async function callGroq(apiKey, content, level){
  const prompt = `Você é uma IA educacional especialista em transformar qualquer tema ou arquivo em material de estudo.\n\nTema ou conteúdo:\n${content}\n\nNível do aluno: ${level}\n\nGere a resposta exatamente com estas seções:\n\n## Visão geral do tema\n## Conceitos principais\n## Resumo simplificado\n## Explicação detalhada\n## Exemplos práticos\n## Mapa mental textual\n## Quiz\nCrie 5 perguntas com alternativas A, B, C, D, resposta correta e explicação.\n## Flashcards\nCrie 5 flashcards no formato Frente e Verso.\n## Plano de estudo\n## Revisão final\n\nUse linguagem clara, envolvente e adaptada ao nível informado.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 5000
    })
  });
  const data = await response.json();
  if(!response.ok) throw new Error(data?.error?.message || 'Falha desconhecida');
  return data.choices?.[0]?.message?.content || 'Sem resposta.';
}

function renderResult(result){
  $('emptyResult').classList.add('hidden');
  $('resultBox').classList.remove('hidden');
  $('resultTitle').textContent = result.title;
  $('resultMeta').textContent = `${result.type} • ${result.level} • ${result.date}`;
  showSection('visaoGeral');
}

function showSection(section){
  if(!currentResult) return;
  document.querySelectorAll('[data-section]').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  const labels = sectionsMap[section];
  const html = extractSections(currentResult.raw, labels);
  $('resultContent').innerHTML = html || formatMarkdown(currentResult.raw);
}

function extractSections(text, labels){
  let output = '';
  for(const label of labels){
    const regex = new RegExp(`##\\s*${escapeRegex(label)}([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
    const match = text.match(regex);
    if(match) output += `<h3>${label}</h3>${formatMarkdown(match[1].trim())}\n`;
  }
  return output;
}

function formatMarkdown(text){
  return text
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function escapeRegex(str){ return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function saveHistory(item){
  const list = JSON.parse(localStorage.getItem('eduai_history') || '[]');
  list.unshift(item);
  localStorage.setItem('eduai_history', JSON.stringify(list.slice(0, 20)));
  renderHistory();
}

function renderHistory(){
  const list = JSON.parse(localStorage.getItem('eduai_history') || '[]');
  if(!list.length){
    $('historyList').innerHTML = `<article class="result-card empty"><h2>Nenhuma sessão encontrada</h2><p>Comece a estudar agora mesmo!</p></article>`;
    return;
  }
  $('historyList').innerHTML = list.map((item, index) => `
    <div class="history-item">
      <div><strong>${item.title}</strong><br><small>${item.type} • ${item.level} • ${item.date}</small></div>
      <button onclick="loadHistory(${index})">Continuar</button>
    </div>`).join('');
}

window.loadHistory = function(index){
  const list = JSON.parse(localStorage.getItem('eduai_history') || '[]');
  currentResult = list[index];
  closeHistory();
  renderResult(currentResult);
  switchMainTab('results');
};

function openHistory(){ $('historyView').classList.remove('hidden'); $('inputView').classList.remove('active'); $('resultsView').classList.remove('active'); }
function closeHistory(){ $('historyView').classList.add('hidden'); switchMainTab('input'); }

function downloadTxt(){
  if(!currentResult) return;
  const blob = new Blob([currentResult.raw], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${currentResult.title.replace(/[^a-z0-9]/gi, '_')}_eduai.txt`;
  link.click();
}

function showLoader(){
  const messages = ['Analisando conteúdo...', 'Identificando conceitos principais...', 'Criando resumo...', 'Gerando quiz...', 'Montando flashcards...', 'Organizando plano de estudo...'];
  let i = 0;
  $('loader').classList.remove('hidden');
  $('loaderText').textContent = messages[0];
  loaderInterval = setInterval(() => { i = (i + 1) % messages.length; $('loaderText').textContent = messages[i]; }, 1400);
}
function hideLoader(){ clearInterval(loaderInterval); $('loader').classList.add('hidden'); }
