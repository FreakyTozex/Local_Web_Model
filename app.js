const modelSelect = document.querySelector('#model');
const connection = document.querySelector('#connection');
const form = document.querySelector('#composer');
const promptBox = document.querySelector('#prompt');
const sendButton = document.querySelector('#send');
const messagesEl = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const filePicker = document.querySelector('#file-picker');
const attachmentsEl = document.querySelector('#attachments');
const webSearchToggle = document.querySelector('#web-search');
let history = [];
let pendingFiles = [];
let busy = false;
let activeRequest = null;
let activeChatId = null;
let savedModelToRestore = null;
let databasePromise = null;
let currentResponseId = null;

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
    if (savedModelToRestore && data.models.includes(savedModelToRestore)) modelSelect.value = savedModelToRestore;
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

function openChatDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('conversa-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('chats', {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function getSavedChats() {
  const db = await openChatDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('chats', 'readonly').objectStore('chats').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

async function getSavedChat(id) {
  const db = await openChatDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('chats', 'readonly').objectStore('chats').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeSavedChat(chat) {
  const db = await openChatDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('chats', 'readwrite').objectStore('chats').put(chat);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function renderChatList() {
  const list = document.querySelector('#chat-list');
  try {
    const chats = await getSavedChats();
    list.replaceChildren();
    for (const chat of chats) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'saved-chat';
      button.classList.toggle('active', chat.id === activeChatId);
      button.textContent = chat.title || 'Nova conversa';
      button.title = chat.title || 'Nova conversa';
      button.disabled = busy;
      button.addEventListener('click', () => restoreChat(chat.id));
      list.append(button);
    }
  } catch (err) {
    console.warn('Não foi possível carregar o histórico local:', err);
  }
}

function makeChatId() {
  return crypto.randomUUID ? crypto.randomUUID() : `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function saveCurrentChat(chatId, chatHistory) {
  if (!chatId || !chatHistory.length) return;
  const displayMessages = [...messagesEl.querySelectorAll('.message')].map(message => ({
    role: message.classList.contains('user') ? 'user' : 'assistant',
    text: message.querySelector('.message-body')?.textContent || ''
  }));
  const firstUser = displayMessages.find(message => message.role === 'user');
  const title = (firstUser?.text || 'Nova conversa').replace(/\s+/g, ' ').slice(0, 48);
  try {
    await storeSavedChat({
      id: chatId, title, history: chatHistory, displayMessages,
      model: modelSelect.value,
      responseId: activeChatId === chatId ? currentResponseId : null,
      updatedAt: Date.now()
    });
    await renderChatList();
  } catch (err) {
    console.warn('Não foi possível guardar o histórico local:', err);
  }
}

async function restoreChat(id) {
  if (busy) return;
  try {
    const chat = await getSavedChat(id);
    if (!chat) return;
    activeChatId = chat.id;
    history = chat.history || [];
    currentResponseId = chat.responseId || null;
    pendingFiles = [];
    renderAttachments();
    messagesEl.replaceChildren();
    const savedMessages = chat.displayMessages || [];
    welcome.classList.toggle('hidden', savedMessages.length > 0);
    savedMessages.forEach(message => addMessage(message.role, message.text));
    if (chat.model) {
      savedModelToRestore = chat.model;
      if ([...modelSelect.options].some(option => option.value === chat.model)) modelSelect.value = chat.model;
    }
    await renderChatList();
  } catch (err) {
    showError(`Não foi possível abrir esta conversa: ${err.message}`);
  }
}

async function restoreLatestChat() {
  try {
    const chats = await getSavedChats();
    if (chats.length) await restoreChat(chats[0].id);
    else await renderChatList();
  } catch (err) {
    console.warn('Não foi possível inicializar o histórico local:', err);
  }
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
  const body = addMessage('assistant', `Erro: ${message}`);
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
  webSearchToggle.disabled = value;
  renderChatList();
}

async function sendMessage(text) {
  const files = pendingFiles.slice();
  if ((!text && !files.length) || busy) return;
  if (!modelSelect.value) { showError('Confirma que o servidor local do LM Studio está ativo e que tens um modelo carregado.'); return; }
  const chatId = activeChatId || makeChatId();
  activeChatId = chatId;
  const chatHistory = history;
  const responseIdForRequest = currentResponseId;
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
  
  const body = addMessage('assistant');
  const thinking = document.createElement('span');
  thinking.className = 'thinking-indicator';
  thinking.setAttribute('role', 'status');
  thinking.setAttribute('aria-label', 'A pensar');
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.setAttribute('aria-hidden', 'true');
    thinking.append(dot);
  }
  body.append(thinking);
  const agentStatus = document.createElement('small');
  agentStatus.className = 'agent-status';
  body.append(agentStatus);
  let answer = '';
  let newResponseId = null;
  let userMessageAdded = false;
  try {
    if (webSearchToggle.checked && text) {
      agentStatus.textContent = 'A pesquisar na Internet…';
      const searchResponse = await fetch(`/api/search?q=${encodeURIComponent(text)}`, {signal: activeRequest.signal});
      const searchData = await searchResponse.json();
      if (!searchResponse.ok) throw new Error(searchData.error || 'Falha na pesquisa na Internet.');
      const results = searchData.results || [];
      const research = results.length
        ? `\n\nResultados de pesquisa na Internet (usa apenas como fontes e inclui as ligações relevantes na resposta):\n${results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}${r.snippet ? `\nResumo: ${r.snippet}` : ''}`).join('\n\n')}`
        : '\n\nA pesquisa na Internet não encontrou resultados.';
      const lastPart = parts.find(part => part.type === 'text');
      if (lastPart) lastPart.text += research;
      else parts.unshift({type: 'text', text: research});
      agentStatus.textContent = results.length ? `A consultar ${results.length} resultados…` : '';
    }
    chatHistory.push({role: 'user', content: parts});
    userMessageAdded = true;
    await saveCurrentChat(chatId, chatHistory);
    const response = await fetch('/api/chat', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model: modelSelect.value, messages: chatHistory, response_id: responseIdForRequest}),
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
        if (chunk.response_id) newResponseId = chunk.response_id;
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.tool_event) {
          const {name, status} = chunk.tool_event;
          agentStatus.textContent = status === 'start'
            ? `A usar ${name}…`
            : status === 'success' ? 'A processar resultados…' : `Falhou: ${name}`;
          continue;
        }
        const token = chunk.message?.content || '';
        if (!token) continue;
        answer += token;
        body.textContent = answer;
        body.parentElement.parentElement.scrollIntoView({behavior: 'smooth', block: 'nearest'});
      }
    }
    if (pending.trim()) {
      const chunk = JSON.parse(pending);
      if (chunk.response_id) newResponseId = chunk.response_id;
      if (chunk.error) throw new Error(chunk.error);
      const token = chunk.message?.content || '';
      if (token) {
        answer += token;
        body.textContent = answer;
      }
    }
    if (answer) chatHistory.push({role: 'assistant', content: answer});
    if (activeChatId === chatId && newResponseId) currentResponseId = newResponseId;
    if (activeChatId === chatId) await saveCurrentChat(chatId, chatHistory);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (answer) chatHistory.push({role: 'assistant', content: answer});
      if (activeChatId === chatId && newResponseId) currentResponseId = newResponseId;
      if (activeChatId === chatId && answer) await saveCurrentChat(chatId, chatHistory);
    } else {
      body.textContent = `Erro: ${err.message}`;
      body.classList.add('error');
      if (userMessageAdded) chatHistory.pop();
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
  activeChatId = null;
  currentResponseId = null;
  history = [];
  pendingFiles = [];
  renderAttachments();
  messagesEl.replaceChildren();
  welcome.classList.remove('hidden');
  renderChatList();
  promptBox.focus();
});
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
  promptBox.value = button.textContent;
  promptBox.focus();
  promptBox.setSelectionRange(promptBox.value.length, promptBox.value.length);
}));
loadModels();
restoreLatestChat();
