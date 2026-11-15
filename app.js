const modelSelect = document.querySelector('#model');
const connection = document.querySelector('#connection');
const form = document.querySelector('#composer');
const promptBox = document.querySelector('#prompt');
const sendButton = document.querySelector('#send');
const messagesEl = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const filePicker = document.querySelector('#file-picker');
const attachmentsEl = document.querySelector('#attachments');
let history = [];
let pendingFiles = [];
let busy = false;
let activeRequest = null;

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

function renderAttachments() {
  attachmentsEl.replaceChildren();
  pendingFiles.forEach((entry, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const name = document.createElement('span');
    name.textContent = entry.file.name;
    name.title = entry.file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remover ${entry.file.name}`);
    remove.addEventListener('click', () => {
      pendingFiles.splice(index, 1);
      renderAttachments();
    });
    chip.append(name, remove);
    attachmentsEl.append(chip);
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Não foi possível ler ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function extractDocument(file) {
  const dataUrl = await readAsDataUrl(file);
  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: file.name, data: dataUrl.split(',', 2)[1]})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Não foi possível ler ${file.name}.`);
  return result;
}

async function addFiles(fileList) {
  for (const file of fileList) {
    const isImage = file.type.startsWith('image/');
    const isDocument = /\.(pdf|docx)$/i.test(file.name);
    const isText = file.type.startsWith('text/') || /\.(txt|md|csv|tsv|json|xml|html?|css|js|ts|py|java|c|cpp|h|hpp|rs|go|php|rb|sh|ps1|ya?ml|toml|ini|log|sql|r|ipynb)$/i.test(file.name);
    if (!isImage && !isText && !isDocument) {
      showError(`O formato de ${file.name} não é suportado. Anexa PDF, Word (.docx), texto, código, dados ou imagens.`);
      continue;
    }
    if (file.size > (isImage ? 12 : isDocument ? 15 : 2) * 1024 * 1024) {
      showError(`${file.name} é demasiado grande (limite: ${isImage ? '12 MB' : isDocument ? '15 MB' : '2 MB'}).`);
      continue;
    }
    try {
      if (isDocument) {
        const result = await extractDocument(file);
        pendingFiles.push({file, isImage: false, isDocument: true, value: result.text, images: result.images || [], pageCount: result.page_count});
      } else {
        const value = isImage ? await readAsDataUrl(file) : await file.text();
        pendingFiles.push({file, isImage, isDocument: false, value, images: []});
      }
    } catch (err) {
      showError(err.message);
    }
  }
  renderAttachments();
}

function setBusy(value) {
  busy = value;
  sendButton.classList.toggle('stop', value);
  sendButton.textContent = value ? '■' : '↑';
  sendButton.setAttribute('aria-label', value ? 'Parar resposta' : 'Enviar mensagem');
  sendButton.title = value ? 'Parar resposta' : 'Enviar mensagem';
  document.querySelector('#attach').disabled = value;
}

async function sendMessage(text) {
  const files = pendingFiles.slice();
  if ((!text && !files.length) || busy) return;
  if (!modelSelect.value) { showError('Confirma que o servidor local do LM Studio está ativo e que tens um modelo carregado.'); return; }
  setBusy(true);
  activeRequest = new AbortController();
  const displayText = [text, ...files.map(({file}) => `📎 ${file.name}`)].filter(Boolean).join('\n');
  addMessage('user', displayText);
  pendingFiles = [];
  renderAttachments();

  const parts = [];
  if (text) parts.push({type: 'text', text});
  for (const entry of files) {
    if (entry.isImage) {
      parts.push({type: 'image_url', image_url: {url: entry.value}});
    } else if (entry.isDocument) {
      const description = entry.pageCount ? `PDF com ${entry.pageCount} páginas` : 'Documento Word';
      if (entry.value.trim()) parts.push({type: 'text', text: `Conteúdo extraído de ${entry.file.name} (${description}):\n${entry.value}`});
      entry.images.forEach((image, index) => {
        if (image.page) parts.push({type: 'text', text: `Página ${image.page} de ${entry.file.name}:`});
        parts.push({type: 'image_url', image_url: {url: image.url}});
      });
    } else {
      parts.push({type: 'text', text: `Conteúdo do ficheiro ${entry.file.name}:\n\`\`\`\n${entry.value}\n\`\`\``});
    }
  }
  if (!text && files.length) parts.unshift({type: 'text', text: 'Analisa os ficheiros anexados.'});
  history.push({role: 'user', content: parts});
  const body = addMessage('assistant');
  let answer = '';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model: modelSelect.value, messages: history}),
      signal: activeRequest.signal
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
    if (answer) history.push({role: 'assistant', content: answer});
  } catch (err) {
    if (err.name === 'AbortError') {
      if (answer) history.push({role: 'assistant', content: answer});
    } else {
      body.textContent = `Erro: ${err.message}`;
      body.classList.add('error');
      history.pop();
    }
  } finally {
    activeRequest = null;
    setBusy(false);
    promptBox.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) {
    activeRequest?.abort();
    return;
  }
  const text = promptBox.value.trim();
  if (!text && !pendingFiles.length) return;
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
document.querySelector('#attach').addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', async () => {
  await addFiles(filePicker.files);
  filePicker.value = '';
});
document.querySelector('#refresh').addEventListener('click', loadModels);
document.querySelector('#new-chat').addEventListener('click', () => {
  if (busy) activeRequest?.abort();
  history = [];
  pendingFiles = [];
  renderAttachments();
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
