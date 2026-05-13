(function () {
  'use strict';

  var ws = null;
  var userId = null;
  var nickname = null;
  var currentRoom = 'lobby';
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var pingTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/ws';
    setStatus('offline', 'Connecting...');

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      setStatus('error', 'Failed');
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      setStatus('online', 'Connected');
      reconnectAttempt = 0;
      startPing();
    };

    ws.onclose = function () {
      setStatus('offline', 'Disconnected');
      stopPing();
      scheduleReconnect();
    };

    ws.onerror = function () {
      setStatus('error', 'Error');
    };

    ws.onmessage = function (event) {
      if (typeof event.data !== 'string') return;
      if (event.data === 'pong') return;
      try {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) { }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
    reconnectAttempt++;
    setStatus('offline', 'Reconnect in ' + (delay / 1000).toFixed(0) + 's');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      }
    }, 25000);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function setStatus(color, text) {
    var dot = $('statusDot');
    var badge = $('statusBadge');
    if (!dot || !badge) return;
    dot.className = 'w-2 h-2 rounded-full ' + (
      color === 'online' ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]' :
      color === 'error' ? 'bg-red-400' :
      'bg-gray-600');
    var textEl = $('statusText');
    if (textEl) textEl.textContent = text;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        userId = msg.userId;
        nickname = msg.nickname;
        currentRoom = msg.room || 'lobby';
        $('currentRoom').textContent = currentRoom;
        $('nickInput').value = nickname;
        renderRooms(msg.rooms || []);
        renderUsers(msg.users || []);
        addMsg('system', 'Welcome!');
        break;

      case 'chat':
        addMsg(msg.user === nickname ? 'self' : 'chat',
          '<span class="text-cyan-400 font-semibold text-xs">' + esc(msg.user) + '</span> ' + esc(msg.text));
        break;

      case 'join':
        addMsg('join', msg.user + ' joined');
        break;

      case 'leave':
        addMsg('leave', msg.user + ' left');
        break;

      case 'nick':
        nickname = msg.nickname;
        $('nickInput').value = nickname;
        addMsg('system', 'You are now known as ' + nickname);
        break;

      case 'notice':
        addMsg('notice', msg.text);
        break;

      case 'room_created':
        addMsg('system', 'Room "' + msg.room + '" created');
        break;

      case 'room_joined':
        currentRoom = msg.room;
        $('currentRoom').textContent = currentRoom;
        addMsg('system', 'Joined room: ' + currentRoom);
        if (msg.users) renderUsers(msg.users);
        break;

      case 'rooms_updated':
        if (msg.rooms) renderRooms(msg.rooms);
        break;

      case 'error':
        addMsg('error', msg.text);
        break;
    }
  }

  function addMsg(type, html) {
    var container = $('messages');
    if (!container) return;
    var div = document.createElement('div');
    var cls = 'px-3 py-1.5 rounded-lg text-sm max-w-[75%] leading-relaxed ';
    if (type === 'chat') cls += 'bg-gray-800 self-start';
    else if (type === 'self') cls += 'bg-cyan-900/50 self-end';
    else if (type === 'join' || type === 'leave') cls += 'bg-gray-800/50 self-center text-xs text-gray-400 italic';
    else if (type === 'notice') cls += 'bg-gray-800/30 self-center text-xs text-gray-500 italic';
    else if (type === 'system') cls += 'self-center text-xs text-gray-500';
    else if (type === 'error') cls += 'bg-red-900/30 self-center text-xs text-red-400';
    div.className = cls;
    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function renderRooms(rooms) {
    var list = $('roomList');
    if (!list) return;
    list.innerHTML = '';
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      var div = document.createElement('div');
      var isActive = r.name === currentRoom;
      div.className = 'flex items-center justify-between px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors ' +
        (isActive ? 'bg-cyan-900/40 text-cyan-300' : 'hover:bg-gray-800 text-gray-300 hover:text-gray-100');
      div.innerHTML = '<span class="truncate">' + esc(r.name) + '</span>' +
        '<span class="text-xs ' + (isActive ? 'text-cyan-500' : 'text-gray-600') + '">' + r.users + '</span>';
      if (!isActive) {
        div.addEventListener('click', function (name) {
          return function () { if (ws && ws.readyState === WebSocket.OPEN) ws.send('/join ' + name); };
        }(r.name));
      }
      list.appendChild(div);
    }
  }

  function renderUsers(users) {
    var list = $('userList');
    var count = $('userCount');
    if (!list) return;
    list.innerHTML = '';
    if (count) count.textContent = '(' + users.length + ')';
    for (var i = 0; i < users.length; i++) {
      var li = document.createElement('li');
      li.className = 'px-2 py-1 rounded text-sm text-gray-300 truncate';
      li.textContent = users[i];
      list.appendChild(li);
    }
  }

  function esc(str) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  // ── Event bindings ──

  document.addEventListener('DOMContentLoaded', function () {

    // Chat form — plain text only, use UI for room/nick actions
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = $('msgInput').value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (text.charAt(0) === '/') {
        addMsg('error', 'Use the sidebar to join rooms or the field above to set your nickname');
        $('msgInput').value = '';
        return;
      }
      ws.send(text);
      $('msgInput').value = '';
    });

    // Nickname
    $('nickBtn').addEventListener('click', function () {
      var val = $('nickInput').value.trim();
      if (val && ws && ws.readyState === WebSocket.OPEN) ws.send('/nick ' + val);
    });
    $('nickInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('nickBtn').click(); }
    });

    // Create room modal
    $('createRoomBtn').addEventListener('click', function () {
      $('createModal').classList.remove('hidden');
      $('newRoomInput').value = '';
      setTimeout(function () { $('newRoomInput').focus(); }, 100);
    });
    $('cancelRoomBtn').addEventListener('click', function () {
      $('createModal').classList.add('hidden');
    });
    $('newRoomInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('confirmRoomBtn').click(); }
      if (e.key === 'Escape') { $('createModal').classList.add('hidden'); }
    });
    $('confirmRoomBtn').addEventListener('click', function () {
      var val = $('newRoomInput').value.trim().toLowerCase();
      if (val && ws && ws.readyState === WebSocket.OPEN) {
        ws.send('/create ' + val);
        $('createModal').classList.add('hidden');
      }
    });
    $('createModal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    connect();
  });
})();
