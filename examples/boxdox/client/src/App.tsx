import { useState, useEffect, useRef, useCallback } from 'react'
import { marked } from 'marked'
import './App.css'

interface NavItem {
  name: string; path: string; type: string; ext?: string
  is_markdown?: boolean; is_image?: boolean; children?: NavItem[]
}

interface ChatMsg { role: string; content: string }

interface SearchResult {
  docId: string; title: string; text: string; score: number; metadata?: { path?: string }
}

interface RagDoc { title: string; source: string; chunkCount?: number }

let cid = crypto.randomUUID()

function esc(s: string) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function buildNavHtml(tree: NavItem | null, depth: number): string {
  if (!tree?.children) return ''
  let html = ''
  const sorted = [...tree.children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name < b.name ? -1 : 1
  })
  for (const item of sorted) {
    if (item.type === 'directory') {
      html += '<div class=nav-dir>'
      html += `<div class='nav-item nav-indent' onclick='this.parentElement.classList.toggle("collapsed")' style='cursor:pointer'>` +
        `<span class=icon>${item.children?.length ? '&#9660;' : '&#9654;'}</span>` +
        `<span class=label>${esc(item.name)}</span></div>`
      html += '<div class=dir-children>' + buildNavHtml(item, depth + 1) + '</div>'
      html += '</div>'
    } else if (item.is_markdown) {
      const title = item.name.replace(/\.mdx?$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      const path = item.path.replace(/\.mdx?$/, '')
      html += `<div class='nav-item nav-file' data-path='${esc(path)}' onclick='window.__loadDoc("${esc(path)}")'>` +
        `<span class=icon>#</span><span class=label>${esc(title)}</span></div>`
    }
  }
  return html
}

function getTocFromMarkdown(content: string) {
  const items: { level: number; text: string; anchor: string }[] = []
  const re = /^(#{2,3})\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const text = m[2].trim()
    const anchor = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    items.push({ level: m[1].length, text, anchor })
  }
  return items
}

export default function App() {
  const [connected, setConnected] = useState(false)
  const [navTree, setNavTree] = useState<NavItem | null>(null)
  const [contentHtml, setContentHtml] = useState('')
  const [tocItems, setTocItems] = useState<{ level: number; text: string; anchor: string }[]>([])
  const [docTitle, setDocTitle] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const aiBubbleRef = useRef<HTMLDivElement | null>(null)
  const chatSendDisabledRef = useRef(false)
  const chatMsgsRef = useRef<HTMLDivElement | null>(null)

  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/events?cid=" + cid
  const sseUrl = (location.protocol === "https:" ? "https:" : "http:") + "//" + location.host + "/events?cid=" + cid

  const addChatMsg = useCallback((role: string, content: string) => {
    setChatMsgs(prev => [...prev, { role, content }])
  }, [])

  const startAiBubble = useCallback(() => {
    addChatMsg('ai', '')
    chatSendDisabledRef.current = true
  }, [addChatMsg])

  const appendAiChunk = useCallback((text: string) => {
    setChatMsgs(prev => {
      const copy = [...prev]
      const last = copy[copy.length - 1]
      if (last && last.role === 'ai') {
        copy[copy.length - 1] = { ...last, content: last.content + text }
      }
      return copy
    })
  }, [])

  const finishAiBubble = useCallback(() => {
    chatSendDisabledRef.current = false
  }, [])

  useEffect(() => {
    const es = new EventSource(sseUrl)
    esRef.current = es

    es.addEventListener('user_msg', (e: MessageEvent) => {
      const m = JSON.parse(e.data)
      addChatMsg('user', m.content)
    })
    es.addEventListener('ai_start', () => startAiBubble())
    es.addEventListener('ai_chunk', (e: MessageEvent) => {
      const m = JSON.parse(e.data)
      appendAiChunk(m.content)
    })
    es.addEventListener('ai_done', () => finishAiBubble())
    es.addEventListener('error', (e: MessageEvent) => {
      if (e.data) {
        try { const m = JSON.parse(e.data); addChatMsg('system', m.body) } catch {}
      }
      finishAiBubble()
    })
    es.addEventListener('open', () => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('__ping__')
        }, 25000)
        ws.onclose = () => {
          setConnected(false)
          clearInterval(ping)
        }
      }
      ws.onmessage = (e) => {
        if (e.data === '__pong__') return
      }
    })

    return () => {
      es.close()
      wsRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch('/api/nav-tree')
      .then(r => r.json())
      .then(tree => setNavTree(tree))
      .catch(() => {})
  }, [])

  const loadDoc = useCallback((path: string) => {
    setContentHtml('<div class=loading><div class=spinner></div><span>Loading...</span></div>')
    let contentPath = path
    if (!contentPath.endsWith('.md') && !contentPath.endsWith('.mdx')) contentPath += '.md'

    const doFetch = (p: string): Promise<string> => {
      return fetch('/content/' + p).then(r => {
        if (!r.ok) throw new Error('not found')
        return r.text()
      })
    }

    doFetch(contentPath).catch(() => {
      if (!contentPath.endsWith('README.md')) {
        const dirPath = contentPath.replace(/\/[^/]+$/, '/README.md')
        return doFetch(dirPath)
      }
      throw new Error('Page not found')
    }).then(raw => {
      let content = raw
      let title = ''
      if (raw.startsWith('---')) {
        const endIdx = raw.indexOf('---', 3)
        if (endIdx > 3) content = raw.slice(endIdx + 3).trim()
      }
      const h1Match = content.match(/^#\s+(.+)/m)
      if (h1Match) title = h1Match[1].trim()
      setDocTitle(title)
      document.title = title ? `${title} - BoxDox` : 'BoxDox - BoxLang Docs'
      setContentHtml(marked.parse(content) as string)
      setTocItems(getTocFromMarkdown(content))

      document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-path') === path)
      })
    }).catch(err => {
      setContentHtml(`<p style='padding:40px;color:var(--red)'>Error: ${err.message}</p>`)
      setTocItems([])
    })
  }, [])

  useEffect(() => {
    (window as any).__loadDoc = loadDoc
  }, [loadDoc])

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) return
    setSearchQuery(q)
    setSearching(true)
    setSearchOpen(true)
    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(r => r.json())
      .then(data => {
        setSearchResults(data.results || [])
        setSearching(false)
      })
      .catch(() => setSearching(false))
  }, [])

  const sendChat = useCallback(() => {
    const input = document.getElementById('chatInput') as HTMLInputElement
    if (!input) return
    const text = input.value.trim()
    if (!text || chatSendDisabledRef.current) return
    input.value = ''
    // Don't add locally — SSE will broadcast back the user message
    wsRef.current?.send('chat ' + text)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    chatMsgsRef.current?.scrollTo({ top: chatMsgsRef.current.scrollHeight })
  }, [chatMsgs])

  const navHtml = buildNavHtml(navTree, 0)

  return (
    <>
      <div className="topbar">
        <div className="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          BoxDox
        </div>
        <div className="search-wrap">
          <span className="icon">&#128269;</span>
          <input
            id="topSearchInput"
            type="text"
            placeholder="Search BoxLang docs..."
            onKeyDown={e => { if (e.key === 'Enter') doSearch((e.target as HTMLInputElement).value) }}
          />
        </div>
        <span className={'badge' + (connected ? ' online' : '')}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
        <div className="actions">
          <button className={chatOpen ? 'active' : ''} onClick={() => setChatOpen(v => !v)}>
            AI Chat
          </button>
          <button onClick={() => window.open(location.origin + '/api/documents', '_blank')}>
            Docs API
          </button>
        </div>
      </div>

      <div className="body">
        <nav className="sidebar" dangerouslySetInnerHTML={{ __html: navHtml }} />
        <main className="content" id="content" dangerouslySetInnerHTML={{ __html: contentHtml || `
          <div class='empty-state'>
            <h2>Welcome to BoxLang Docs</h2>
            <p>Browse the documentation using the sidebar, or ask AI a question.</p>
          </div>
        `}} />
        <aside className="toc">
          <h3>On this page</h3>
          {tocItems.map((item, i) => (
            <a key={i} href={`#${item.anchor}`}
               className={'toc-h' + item.level}
               onClick={e => {
                 e.preventDefault()
                 const el = document.getElementById(item.anchor)
                 if (el) el.scrollIntoView({ behavior: 'smooth' })
               }}>
              {item.text}
            </a>
          ))}
        </aside>
        <div className={'chat-panel' + (chatOpen ? ' open' : '')}>
          <div className="chat-header">
            <span>AI Chat</span>
            <span className="close" onClick={() => setChatOpen(false)}>&times;</span>
          </div>
          <div className="chat-msgs" ref={chatMsgsRef}>
            {chatMsgs.map((msg, i) => (
              <div key={i} className={'msg ' + msg.role}>
                {msg.role === 'ai' && !msg.content ? (
                  <span style={{ color: 'var(--text-3)' }}>Thinking...</span>
                ) : msg.role === 'ai' ? (
                  <div dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }} />
                ) : msg.content}
              </div>
            ))}
          </div>
          <div className="chat-input-wrap">
            <input id="chatInput" type="text" placeholder="Ask about BoxLang..."
                   onKeyDown={e => { if (e.key === 'Enter') sendChat() }} />
            <button onClick={sendChat} disabled={chatSendDisabledRef.current}>Send</button>
          </div>
        </div>
      </div>

      <div className={'search-overlay' + (searchOpen ? ' open' : '')}>
        <h2>{searching ? `Searching: ${searchQuery}` : `Search Results: ${searchQuery}`}</h2>
        {searching ? (
          <div className="loading"><div className="spinner"></div><span>Searching...</span></div>
        ) : searchResults.length === 0 ? (
          <p style={{ color: 'var(--text-3)', padding: 20 }}>No results found.</p>
        ) : (
          searchResults.map((r, i) => (
            <div key={i} className="search-result"
                 onClick={() => { setSearchOpen(false); loadDoc(r.docId) }}>
              <div>
                <span className="title">{esc(r.title)}</span>
                <span className="score"> [{r.score.toFixed(3)}]</span>
              </div>
              <div className="snippet">{esc(r.text)}</div>
            </div>
          ))
        )}
      </div>

      <RagDebugPanel />
      <VowelAgent />
    </>
  )
}

function RagDebugPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'documents' | 'chat'>('documents')
  const [docs, setDocs] = useState<RagDoc[]>([])
  const [stats, setStats] = useState({ docCount: 0, chunkCount: 0 })
  const [ragQuery, setRagQuery] = useState('')
  const [ragResults, setRagResults] = useState<SearchResult[]>([])
  const [ragSearching, setRagSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  const [statusText, setStatusText] = useState('Connected')
  const [statusDot, setStatusDot] = useState('green')

  useEffect(() => {
    if (!open || docs.length > 0) return
    setLoading(true)
    setStatusText('Loading...')
    setStatusDot('yellow')
    Promise.all([
      fetch('/api/documents').then(r => r.json()),
      fetch('/api/stats').then(r => r.json())
    ]).then(([docsData, statsData]) => {
      setDocs(docsData)
      setStats(statsData)
      setStatusText(`${statsData.docCount} docs, ${statsData.chunkCount} chunks indexed`)
      setStatusDot('green')
      setLoading(false)
    }).catch(err => {
      setStatusText('Error loading')
      setStatusDot('red')
      setLoading(false)
    })
  }, [open, docs.length])

  const doRagSearch = useCallback(() => {
    if (!ragQuery.trim()) return
    setRagSearching(true)
    setStatusText('Searching...')
    setStatusDot('yellow')
    fetch('/api/search?q=' + encodeURIComponent(ragQuery))
      .then(r => r.json())
      .then(data => {
        const results = data.results || []
        setRagResults(results)
        setStatusText(results.length + ' results')
        setStatusDot('green')
        setRagSearching(false)
      })
      .catch(() => {
        setRagSearching(false)
        setStatusText('Error')
        setStatusDot('red')
      })
  }, [ragQuery])

  const folders: Record<string, RagDoc[]> = {}
  docs.forEach(d => {
    const parts = d.source.split('/')
    const folder = parts.slice(0, -1).join(' > ') || '(root)'
    if (!folders[folder]) folders[folder] = []
    folders[folder].push(d)
  })

  return (
    <>
      <button className="rag-debug-fab" title="RAG Debug" onClick={() => setOpen(v => !v)}>
        &#128300;
      </button>
      <div className={'rag-debug-dialog' + (open ? '' : ' hidden')}>
        <div className="rag-debug-header">
          <h3>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            RAG Debug
          </h3>
          <button className="rag-debug-close" onClick={() => setOpen(false)}>&times;</button>
        </div>
        <div className="rag-debug-tabs">
          <button className={'rag-debug-tab' + (tab === 'documents' ? ' active' : '')}
                  onClick={() => setTab('documents')}>Documents</button>
          <button className={'rag-debug-tab' + (tab === 'chat' ? ' active' : '')}
                  onClick={() => setTab('chat')}>Search</button>
        </div>
        <div className="rag-debug-body">
          {tab === 'documents' && (
            loading ? (
              <div className="loading"><div className="spinner"></div><span>Loading docs...</span></div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 11, color: 'var(--text-3)' }}>
                  <span>Docs: <strong style={{ color: 'var(--text)' }}>{stats.docCount}</strong></span>
                  <span>Chunks: <strong style={{ color: 'var(--text)' }}>{stats.chunkCount}</strong></span>
                </div>
                {Object.keys(folders).sort().map(folder => (
                  <div key={folder}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-2)', padding: '6px 0 2px' }}>
                      {folder} ({folders[folder].length})
                    </div>
                    {folders[folder].slice(0, 10).map((d, i) => (
                      <div key={i} className="doc-item">
                        <div>{esc(d.title)} <span className="count">({d.chunkCount || '?'} chunks)</span></div>
                        <div className="path">{esc(d.source)}</div>
                      </div>
                    ))}
                    {folders[folder].length > 10 && (
                      <div style={{ color: 'var(--text-3)', fontSize: 11, padding: '2px 10px' }}>
                        +{folders[folder].length - 10} more
                      </div>
                    )}
                  </div>
                ))}
              </>
            )
          )}
          {tab === 'chat' && (
            ragSearching ? (
              <div className="loading"><div className="spinner"></div><span>Searching...</span></div>
            ) : ragResults.length === 0 ? (
              <p style={{ color: 'var(--text-3)', padding: 12 }}>No results yet. Enter a query above.</p>
            ) : (
              <>
                <p style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
                  Found {ragResults.length} matches
                </p>
                {ragResults.map((r, i) => (
                  <div key={i} className="result-item">
                    <div>
                      <span className="src">{esc(r.metadata?.path || r.docId || '')}</span>
                      <span className="score"> [{(r.score * 100).toFixed(0)}%]</span>
                    </div>
                    <div className="text">{esc(r.text || '')}</div>
                  </div>
                ))}
              </>
            )
          )}
        </div>
        <div className="rag-debug-input-wrap">
          <input type="text" placeholder="Test RAG query..."
                 value={ragQuery}
                 onChange={e => setRagQuery(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') doRagSearch() }} />
          <button onClick={doRagSearch}>Search</button>
        </div>
        <div className="rag-debug-status">
          <span className={'dot ' + statusDot}></span>
          <span>{statusText}</span>
        </div>
      </div>
    </>
  )
}

function VowelAgent() {
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    let appId = ''
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        appId = cfg?.vowel?.appId || ''
        if (!appId) { console.log('[vowel] No appId from config'); return null }
        return import('@vowel.to/client')
      })
      .then(mod => {
        if (!mod || !appId) return
        const { Vowel } = mod
        if (!Vowel) { console.log('[vowel] Vowel class not found in module'); return }

        const config: Record<string, any> = {
          appId,
          realtimeApiUrl: 'wss://realtime.vowel.to/v1',
          _voiceConfig: {
            provider: 'vowel-prime',
            vowelPrimeConfig: { environment: 'testing' },
            llmProvider: 'openrouter',
            model: 'deepseek/deepseek-v4-flash:free',
            stt: { provider: 'groq-whisper' },
            tts: { provider: 'grok' },
            voice: 'ara',
            language: 'en-US',
            turnDetection: { mode: 'server_vad' },
          },
          _caption: { enabled: true, position: 'bottom-center', showRole: true, showStreaming: true },
          borderGlow: { enabled: false },
          floatingCursor: { enabled: false },
          instructions: 'You are the voice assistant for BoxDox. Help users learn BoxLang. Use searchKnowledgeBase for doc questions. After searching, navigate to the best matching doc page. Be concise.',
        }
        const client = new Vowel(config as any)

        client.registerActions({
          searchKnowledgeBase: {
            definition: { description: 'Search BoxLang documentation knowledge base', parameters: {} as any },
            handler: async (args: any) => {
              const q = args.query || args.text || ''
              if (!q) return { results: [] }
              try {
                const r = await fetch('/api/search?q=' + encodeURIComponent(q))
                return await r.json()
              } catch (e: any) { return { error: e.message, results: [] } }
            },
          },
          navigateToDoc: {
            definition: { description: 'Navigate to a documentation page by path', parameters: {} as any },
            handler: async (args: any) => {
              if (args.path && (window as any).__loadDoc) (window as any).__loadDoc(args.path)
              return { success: true }
            },
          },
          getCurrentPageInfo: {
            definition: { description: 'Get current page info', parameters: {} as any },
            handler: () => {
              const el = document.getElementById('content')
              const headings = el
                ? Array.from(el.querySelectorAll('h1,h2,h3')).map(h => ({
                    level: parseInt(h.tagName[1]),
                    text: h.textContent || ''
                  }))
                : []
              return { title: document.title, sections: headings }
            },
          },
          searchDocRoutes: {
            definition: { description: 'Search doc page titles and routes', parameters: {} as any },
            handler: async (args: any) => {
              const q = (args.query || '').toLowerCase()
              if (!q) return { results: [] }
              const matches: { path: string; title: string }[] = []
              document.querySelectorAll('.nav-item[data-path]').forEach(el => {
                const path = el.getAttribute('data-path') || ''
                const title = el.querySelector('.label')?.textContent || ''
                if (path && (path.toLowerCase().includes(q) || title.toLowerCase().includes(q)))
                  matches.push({ path, title })
              })
              return { results: matches.slice(0, 10) }
            },
          },
        })

        client.startSession()
        console.log('[vowel] Agent initialized')
      })
      .catch(err => console.warn('[vowel] Init failed:', err))
  }, [])

  return <div className="vowel-agent-container" id="vowelContainer" />
}
