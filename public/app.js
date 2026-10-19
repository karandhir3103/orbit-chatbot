'use strict';

(() => {
  const MAX_CHARS = 4000;          // keep in sync with LIMITS.maxUserChars in api/chat.js
  const MAX_HISTORY = 20;          // most recent messages sent as context
  const CLIENT_TIMEOUT_MS = 40000; // a little longer than the server's upstream timeout
  const ROBOT_SRC = 'assets/robot.png';

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  const messagesEl = $('#messages');
  const emptyEl = $('#empty');
  const form = $('#composer');
  const input = $('#composer-input');
  const sendBtn = $('#send');
  const charCount = $('#char-count');
  const statusText = $('#status-text');
  const announcer = $('#announcer');
  const themeBtn = $('#theme-toggle');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const state = {
    messages: [], // { role: 'user' | 'assistant', content: string }
    controller: null,
    stopReason: null,
    elapsedTimer: null,
  };

  /* ───────── Helpers ───────── */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function announce(text) {
    announcer.textContent = '';
    // Re-set on the next frame so repeated messages are still read out.
    requestAnimationFrame(() => { announcer.textContent = text; });
  }

  function scrollToBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  function scrollToMessage(node) {
    // Long replies: show their start. Short ones: just stick to the bottom.
    if (node.offsetHeight > messagesEl.clientHeight * 0.8) {
      messagesEl.scrollTo({ top: node.offsetTop - 12, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    } else {
      scrollToBottom();
    }
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      ta.remove();
    }
    const original = button.textContent;
    button.textContent = 'COPIED';
    announce('Copied to clipboard');
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  /* ───────── Minimal, safe Markdown ───────── */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  function renderMarkdown(src) {
    const codeBlocks = [];
    let text = src.replace(/\r\n?/g, '\n');
    text = text.replace(/```[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
      codeBlocks.push({ lang, code: code.replace(/\n$/, '') });
      return `\n\u0000${codeBlocks.length - 1}\u0000\n`;
    });

    const lines = escapeHtml(text).split('\n');
    const out = [];
    let para = [];
    let list = null; // { type: 'ul' | 'ol', items: [] }

    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const flushList = () => {
      if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; }
    };
    const flush = () => { flushPara(); flushList(); };
    const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^\u0000(\d+)\u0000$/))) {
        flush();
        const { lang, code } = codeBlocks[Number(m[1])];
        out.push(`<div class="code"><div class="code-head"><span>${escapeHtml(lang || 'code')}</span>` +
          `<button type="button" class="tool-btn" data-copy-code>COPY</button></div>` +
          `<pre><code>${escapeHtml(code)}</code></pre></div>`);
      } else if (!line.trim()) {
        flush();
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flush();
        const level = Math.min(m[1].length + 1, 4); // keep headings below the page's h1
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        out.push('<hr>');
      } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
        flush();
        const head = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        i--;
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' + rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>');
      } else if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
        flush();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (list && list.type !== type) flushList();
        if (!list) list = { type, items: [] };
        list.items.push(m[1]);
      } else if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim(); // wrapped list item
      } else {
        flushList();
        para.push(line);
      }
    }
    flush();
    return out.join('');
  }

  /* ───────── Rendering ───────── */

  function setHasMessages(has) {
    app.classList.toggle('has-messages', has);
    if (has && emptyEl.isConnected) emptyEl.remove();
  }

  function botShell(extraClass) {
    const article = el('article', `msg msg-bot${extraClass ? ` ${extraClass}` : ''}`);
    const avatar = el('div', 'avatar');
    const img = el('img');
    img.src = ROBOT_SRC;
    img.alt = '';
    avatar.appendChild(img);
    const body = el('div', 'msg-body');
    body.appendChild(el('div', 'msg-meta mono', 'ORBIT'));
    article.append(avatar, body);
    return { article, body };
  }

  function addUserMessage(text) {
    setHasMessages(true);
    const article = el('article', 'msg msg-user');
    const body = el('div', 'msg-body');
    const label = el('div', 'msg-meta mono', 'YOU');
    const bubble = el('div', 'bubble', text);
    body.append(label, bubble);
    article.appendChild(body);
    messagesEl.appendChild(article);
    scrollToBottom();
  }

  function addBotMessage(text, { truncated } = {}) {
    const { article, body } = botShell();
    const bubble = el('div', 'bubble md');
    bubble.innerHTML = renderMarkdown(text);
    body.appendChild(bubble);
    if (truncated) body.appendChild(el('div', 'note note-truncated', 'Reply hit the length limit. Ask “continue” for more.'));
    const tools = el('div', 'msg-tools');
    const copy = el('button', 'tool-btn', 'COPY');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy reply');
    copy.dataset.copyMessage = '';
    tools.appendChild(copy);
    body.appendChild(tools);
    article.dataset.raw = text;
    messagesEl.appendChild(article);
    scrollToMessage(article);
  }

  function addTyping() {
    const { article, body } = botShell('msg-typing');
    const bubble = el('div', 'bubble typing');
    const dots = el('span', 'dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('span'), el('span'), el('span'));
    const label = el('span', 'typing-label', 'Thinking…');
    bubble.append(dots, label);
    body.appendChild(bubble);
    // The live log would read the dots out; the announcer covers this instead.
    article.setAttribute('aria-hidden', 'true');
    messagesEl.appendChild(article);
    scrollToBottom();
    return { article, label };
  }

  function addError(message) {
    const { article, body } = botShell('msg-error');
    const bubble = el('div', 'bubble');
    bubble.setAttribute('role', 'alert');
    bubble.append(el('span', 'error-title', 'ERROR'), el('span', null, message));
    const retry = el('button', 'retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      article.remove();
      input.focus();
      requestReply();
    });
    bubble.appendChild(document.createElement('br'));
    bubble.appendChild(retry);
    body.appendChild(bubble);
    messagesEl.appendChild(article);
    scrollToBottom();
  }

  function addNote(text) {
    const note = el('p', 'note', text);
    note.style.margin = '0 0 0 44px';
    messagesEl.appendChild(note);
    scrollToBottom();
  }

  /* ───────── Busy state ───────── */

  function setBusy(busy) {
    app.classList.toggle('is-busy', busy);
    app.setAttribute('aria-busy', String(busy));
    sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
    sendBtn.title = busy ? 'Stop generating (Esc)' : 'Send message';
    statusText.textContent = busy ? 'THINKING…' : 'ONLINE · READY';
    updateComposer();
  }

  function updateComposer() {
    const len = input.value.length;
    const busy = !!state.controller;
    sendBtn.disabled = !busy && input.value.trim().length === 0;
    if (len >= MAX_CHARS * 0.8) {
      charCount.textContent = `${len.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
      charCount.classList.toggle('is-near', len >= MAX_CHARS * 0.95);
    } else {
      charCount.textContent = '';
      charCount.classList.remove('is-near');
    }
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  /* ───────── Networking ───────── */

  async function requestReply() {
    if (state.controller) return;
    const controller = new AbortController();
    state.controller = controller;
    state.stopReason = null;
    setBusy(true);
    announce('Orbit is thinking');

    const typing = addTyping();
    const started = Date.now();
    state.elapsedTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      if (secs >= 6) typing.label.textContent = `Still thinking… ${secs}s`;
    }, 1000);
    const timeout = setTimeout(() => { state.stopReason = 'timeout'; controller.abort(); }, CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: state.messages.slice(-MAX_HISTORY) }),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }

      if (!res.ok || !data || typeof data.reply !== 'string') {
        const fallback = res.status === 404
          ? 'The chat endpoint wasn’t found. Run the app with “npm run dev” or deploy it to Vercel.'
          : `Something went wrong (HTTP ${res.status}). Please try again.`;
        throw new Error((data && data.error) || fallback);
      }

      typing.article.remove();
      state.messages.push({ role: 'assistant', content: data.reply });
      addBotMessage(data.reply, { truncated: data.truncated });
      announce('Orbit replied');
    } catch (err) {
      typing.article.remove();
      if (err.name === 'AbortError' && state.stopReason === 'user') {
        addNote('Stopped. Send a message or edit your question to continue.');
        announce('Stopped');
      } else if (err.name === 'AbortError' && state.stopReason === 'reset') {
        // New chat: nothing to show.
      } else {
        const message = err.name === 'AbortError'
          ? 'Orbit took too long to answer. Please try again.'
          : err instanceof TypeError
            ? 'Couldn’t reach the server. Check your connection and try again.'
            : err.message;
        addError(message);
        announce(`Error: ${message}`);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(state.elapsedTimer);
      if (state.controller === controller) state.controller = null;
      setBusy(false);
    }
  }

  function sendMessage(raw) {
    const text = raw.trim();
    if (!text || state.controller) return;
    if (text.length > MAX_CHARS) {
      announce(`Messages are limited to ${MAX_CHARS} characters.`);
      return;
    }
    state.messages.push({ role: 'user', content: text });
    addUserMessage(text);
    input.value = '';
    autoGrow();
    updateComposer();
    requestReply();
  }

  function stop(reason = 'user') {
    if (!state.controller) return;
    state.stopReason = reason;
    state.controller.abort();
  }

  function newChat() {
    stop('reset');
    state.messages = [];
    messagesEl.replaceChildren(emptyEl);
    setHasMessages(false);
    messagesEl.scrollTop = 0;
    input.value = '';
    autoGrow();
    updateComposer();
    input.focus();
    announce('Started a new chat');
  }

  /* ───────── Theme ───────── */

  function applyThemeUi() {
    const light = document.documentElement.dataset.theme === 'light';
    const label = light ? 'Switch to dark theme' : 'Switch to light theme';
    themeBtn.setAttribute('aria-pressed', String(light));
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', light ? '#eeece5' : '#17181b');
  }

  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.classList.add('theme-switching');
    root.dataset.theme = next;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
    try { localStorage.setItem('orbit-theme', next); } catch { /* not persisted */ }
    applyThemeUi();
  });

  /* ───────── Events ───────── */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.controller) stop('user');
    else sendMessage(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.controller) sendMessage(input.value);
    } else if (e.key === 'Escape' && state.controller) {
      e.preventDefault();
      stop('user');
    }
  });

  input.addEventListener('input', () => { autoGrow(); updateComposer(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.controller) stop('user');
  });

  $('#new-chat').addEventListener('click', newChat);

  emptyEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-prompt]');
    if (!chip) return;
    input.focus();
    sendMessage(chip.dataset.prompt);
  });

  messagesEl.addEventListener('click', (e) => {
    const msgCopy = e.target.closest('[data-copy-message]');
    if (msgCopy) return copyText(msgCopy.closest('.msg').dataset.raw, msgCopy);
    const codeCopy = e.target.closest('[data-copy-code]');
    if (codeCopy) copyText(codeCopy.closest('.code').querySelector('code').textContent, codeCopy);
  });

  applyThemeUi();
  updateComposer();
})();
