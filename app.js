const modelSelect = document.querySelector('#model');
const connection = document.querySelector('#connection');
const form = document.querySelector('#composer');
const promptBox = document.querySelector('#prompt');
const sendButton = document.querySelector('#send');
const messagesEl = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
let history = [];
let busy = false;

function setConnection(online, text) {
  connection.classList.toggle('offline', !online);
  connection.querySelector('span:last-child').textContent = text;
}

async function loadModels() {
  modelSelect.innerHTML = '<option value="">A procurar modelos…</option>';
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao carregar modelos.');
    if (!data.models.length) throw new Error('Não há modelos disponíveis no LM Studio.');
    modelSelect.innerHTML = data.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    setConnection(true, 'Ligado ao LM Studio');
  } catch (err) {
    modelSelect.innerHTML = '<option value="">Sem ligação</option>';
    setConnection(false, 'Sem ligação');
    showError(err.message);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function addMessage(role, text = '') {
  welcome.classList.add('hidden');
  const item = document.createElement('article');
  item.className = `message ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'Tu' : '✳';
  const content = document.createElement('div');
  content.className = 'message-content';
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'TU' : 'ASSISTENTE';
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = text;
  content.append(label, body);
  item.append(avatar, content);
  messagesEl.append(item);
  item.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  return body;
}

function showError(message) {
  const body = addMessage('assistant', `Não consegui ligar ao modelo. ${message}`);
  body.classList.add('error');
}

async function sendMessage(text) {
  if (!text || busy) return;
  if (!modelSelect.value) { showError('Confirma que o servidor local do LM Studio está ativo e que tens um modelo carregado.'); return; }
  busy = true;
  sendButton.disabled = true;
  addMessage('user', text);
  history.push({role: 'user', content: text});
  const body = addMessage('assistant');
  let answer = '';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model: modelSelect.value, messages: history})
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Erro do servidor local.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      pending += decoder.decode(value, {stream: true});
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        answer += chunk.message?.content || '';
        body.textContent = answer;
        body.parentElement.parentElement.scrollIntoView({behavior: 'smooth', block: 'nearest'});
      }
    }
    if (pending.trim()) {
      const chunk = JSON.parse(pending);
      answer += chunk.message?.content || '';
      body.textContent = answer;
    }
    history.push({role: 'assistant', content: answer});
  } catch (err) {
    body.textContent = `Erro: ${err.message}`;
    body.classList.add('error');
    history.pop();
  } finally {
    busy = false;
    sendButton.disabled = false;
    promptBox.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const text = promptBox.value.trim();
  if (!text) return;
  promptBox.value = '';
  promptBox.style.height = 'auto';
  sendMessage(text);
});
promptBox.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
promptBox.addEventListener('input', () => {
  promptBox.style.height = 'auto';
  promptBox.style.height = `${Math.min(promptBox.scrollHeight, 180)}px`;
});
document.querySelector('#refresh').addEventListener('click', loadModels);
document.querySelector('#new-chat').addEventListener('click', () => {
  history = [];
  messagesEl.replaceChildren();
  welcome.classList.remove('hidden');
  promptBox.focus();
});
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
  promptBox.value = button.textContent;
  promptBox.focus();
  promptBox.setSelectionRange(promptBox.value.length, promptBox.value.length);
}));
loadModels();
