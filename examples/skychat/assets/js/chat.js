(() => {
    'use strict';

    let ws = null;
    let userId = null;
    let nickname = null;
    let reconnectTimer = null;
    let aiMsgEl = null;

    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const usersEl = document.getElementById('users');

    // ── WebSocket ────────────────────────────────────────────────

    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}${location.pathname}`;

        ws = new WebSocket(url);
        ws.onopen = () => { console.log('[WS] Connected'); };
        ws.onmessage = handleMessage;
        ws.onclose = () => {
            console.log('[WS] Disconnected');
            scheduleReconnect();
        };
        ws.onerror = (e) => { console.error('[WS] Error', e); };
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            console.log('[WS] Reconnecting...');
            connect();
        }, 2000);
    }

    function send(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }

    // ── Message Parsing ──────────────────────────────────────────

    function handleMessage(event) {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (_) {
            return;
        }

        switch (msg.type) {
            case 'welcome':     handleWelcome(msg); break;
            case 'join':        handleJoin(msg); break;
            case 'leave':       handleLeave(msg); break;
            case 'chat':        handleChat(msg); break;
            case 'nick':        handleNick(msg); break;
            case 'notice':      handleNotice(msg); break;
            case 'error':       handleError(msg); break;
            case 'help':        handleHelp(msg); break;
            case 'ai_start':    handleAiStart(); break;
            case 'ai_chunk':    handleAiChunk(msg); break;
            case 'ai_done':     handleAiDone(msg); break;
        }
    }

    // ── Handlers ────────────────────────────────────────────────

    function handleWelcome(msg) {
        userId = msg.userId;
        nickname = msg.nickname;
        updateUserList(msg.users);
        addMessage('system', `Welcome, ${nickname}! Type /help for commands.`);
    }

    function handleJoin(msg) {
        addMessage('join', `${msg.user} joined`);
    }

    function handleLeave(msg) {
        if (msg.users) updateUserList(msg.users);
        addMessage('leave', `${msg.user} left`);
    }

    function handleChat(msg) {
        const isMe = msg.user === nickname;
        addMessage(isMe ? 'me' : 'other', msg.text, msg.user);
    }

    function handleNick(msg) {
        nickname = msg.nickname;
        addMessage('notice', `You are now known as ${nickname}`);
    }

    function handleNotice(msg) {
        addMessage('notice', msg.text);
    }

    function handleError(msg) {
        addMessage('error', msg.text);
    }

    function handleHelp(msg) {
        const lines = msg.commands.map(c => `<code>${c}</code>`).join('<br>');
        addMessage('help', lines);
    }

    function handleAiStart() {
        aiMsgEl = document.createElement('div');
        aiMsgEl.className = 'msg ai';
        aiMsgEl.innerHTML = `
            <div class="msg-user">AI</div>
            <div class="ai-thinking">Thinking</div>
            <div class="ai-streaming" style="display:none"></div>
        `;
        messagesEl.appendChild(aiMsgEl);
        scrollToBottom();
    }

    function handleAiChunk(msg) {
        if (!aiMsgEl) return;
        const thinking = aiMsgEl.querySelector('.ai-thinking');
        const streaming = aiMsgEl.querySelector('.ai-streaming');
        if (thinking) {
            thinking.style.display = 'none';
            streaming.style.display = 'inline';
        }
        const chunk = document.createElement('span');
        chunk.className = 'chunk';
        chunk.textContent = msg.content;
        streaming.appendChild(chunk);
        scrollToBottom();
    }

    function handleAiDone(msg) {
        if (!aiMsgEl) return;
        const streaming = aiMsgEl.querySelector('.ai-streaming');
        const thinking = aiMsgEl.querySelector('.ai-thinking');
        if (thinking) thinking.style.display = 'none';
        if (streaming) streaming.style.display = 'inline';

        // Remove blinking cursor
        const cursor = aiMsgEl.querySelector('.cursor-blink');
        if (cursor) cursor.remove();

        aiMsgEl = null;
    }

    function updateUserList(users) {
        usersEl.innerHTML = '';
        for (const u of users) {
            const li = document.createElement('li');
            li.textContent = u.nickname;
            if (u.id === userId) {
                li.style.color = 'var(--accent)';
                li.style.fontWeight = '600';
            }
            usersEl.appendChild(li);
        }
    }

    function addMessage(type, content, user) {
        const el = document.createElement('div');
        el.className = `msg ${type}`;

        if (user && (type === 'other' || type === 'me')) {
            const userEl = document.createElement('div');
            userEl.className = 'msg-user';
            userEl.textContent = user;
            el.appendChild(userEl);
        }

        const textEl = document.createElement('div');
        textEl.innerHTML = content;
        el.appendChild(textEl);
        messagesEl.appendChild(el);
        scrollToBottom();
    }

    function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Input ────────────────────────────────────────────────────

    function handleSend() {
        const text = inputEl.value.trim();
        if (!text) return;

        // Show own messages immediately
        if (!text.startsWith('/')) {
            addMessage('me', text, nickname);
        }

        send(text);
        inputEl.value = '';
    }

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSend();
    });

    sendBtn.addEventListener('click', handleSend);

    // ── Init ─────────────────────────────────────────────────────

    connect();
})();
