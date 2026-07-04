import React, { useState, useEffect, useRef, useMemo } from 'react';
import { io } from 'socket.io-client';
import { approxSearch } from './utils/stringMatch';
import './App.css';

export default function App() {
  // --- States ---
  const [script, setScript] = useState({ paragraphs: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [activePrompt, setActivePrompt] = useState('');
  const [latestCompletion, setLatestCompletion] = useState('');
  const [speechLogs, setSpeechLogs] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [theme, setTheme] = useState('dark'); // Minimal theme defaults to dark
  
  // Track which gen blocks are currently displaying their prompt inline (Shift + Click toggle)
  const [showingPrompts, setShowingPrompts] = useState(new Set());
  
  // Speech Highlight state: { id: 'paraId', interim: boolean }
  const [speechHighlight, setSpeechHighlight] = useState(null);

  // --- Refs (to avoid stale closures in callbacks) ---
  const scriptRef = useRef(script);
  const cursorRef = useRef({ paragraphIdx: 0, charOffset: 0 });
  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const isListeningRef = useRef(isListening);
  const isBroadcastingRef = useRef(isBroadcasting);

  // Update refs when state changes
  useEffect(() => { scriptRef.current = script; }, [script]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { isBroadcastingRef.current = isBroadcasting; }, [isBroadcasting]);

  // --- Theme Toggle ---
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  // --- Socket.io Setup ---
  useEffect(() => {
    // Establish connection (proxied in development, relative in production)
    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('[socket] Connected to server');
      // Request initial script
      socket.emit('script');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('[socket] Disconnected from server');
    });

    socket.on('script', (data) => {
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        console.log('[socket] Received script data');
        setScript(parsed);
      } catch (err) {
        console.error('[socket] Failed to parse script JSON:', err);
      }
    });

    socket.on('completion', (data) => {
      const { completion, id } = data;
      console.log(`[socket] Completion received for "${id}"`);
      setLatestCompletion(completion);

      // Update script state
      setScript((prev) => {
        const updatedParagraphs = prev.paragraphs.map((p) => {
          if (p.id === id) {
            return { ...p, text: completion };
          }
          return p;
        });
        const newScript = { ...prev, paragraphs: updatedParagraphs };
        
        // Use ref to check active broadcasting state without reconnecting socket
        if (isBroadcastingRef.current) {
          socket.emit('update', JSON.stringify(newScript, null, 4));
        } else {
          socket.emit('save', JSON.stringify(newScript, null, 4));
        }
        return newScript;
      });
    });

    socket.on('cursor', (data) => {
      const { paragraphIdx, charOffset } = data;
      cursorRef.current = { paragraphIdx, charOffset };
      
      // Highlight the paragraph that matches the broadcasted cursor
      if (scriptRef.current.paragraphs && scriptRef.current.paragraphs[paragraphIdx]) {
        const para = scriptRef.current.paragraphs[paragraphIdx];
        setSpeechHighlight({ id: para.id, interim: false });
        scrollToBlock(para.id);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Helper to scroll script blocks into view
  const scrollToBlock = (id) => {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  };

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        downloadScriptAsJSON();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [script]);

  // --- Web Speech API Speech Recognition ---
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[speech] Web Speech API not supported in this browser');
      return;
    }

    const rec = new SpeechRecognition();
    rec.interimResults = true;
    rec.continuous = true;
    recognitionRef.current = rec;

    rec.onresult = (event) => {
      const results = event.results;
      const latestResult = results[results.length - 1];
      const said = latestResult[0].transcript;
      const isFinal = latestResult.isFinal;

      // Update Speech Tracking view
      setSpeechLogs((prev) => {
        // Find if the last log item was an interim one, if so, replace it
        const newLogs = [...prev];
        if (newLogs.length > 0 && newLogs[newLogs.length - 1].interim) {
          newLogs.pop();
        }
        newLogs.push({ text: said, interim: !isFinal });
        // Keep last 40 lines
        return newLogs.slice(-40);
      });

      // Match and update cursor position
      findAndAdvanceCursor(said, isFinal);
    };

    rec.onerror = (e) => {
      console.error('[speech] Recognition error:', e.error);
    };

    rec.onend = () => {
      // Loop recording if the user intended to listen
      if (isListeningRef.current) {
        try {
          rec.start();
        } catch (err) {
          console.warn('[speech] Failed to restart recognition:', err);
        }
      }
    };

    return () => {
      if (rec) rec.abort();
    };
  }, []);

  // Handle Speech cursor matching
  const findAndAdvanceCursor = (pattern, isFinal) => {
    if (!scriptRef.current || !scriptRef.current.paragraphs) return;
    if (!pattern || pattern.trim().length < 3) return;

    const needle = pattern.trim().toLowerCase();
    const paragraphs = scriptRef.current.paragraphs;
    const currentParaIdx = cursorRef.current.paragraphIdx;
    const currentCharOffset = cursorRef.current.charOffset;

    const FORWARD_WINDOW = 8;
    const searchLimit = Math.min(paragraphs.length, currentParaIdx + FORWARD_WINDOW);

    for (let i = currentParaIdx; i < searchLimit; i++) {
      const para = paragraphs[i];
      if (!para.text) continue;

      const searchFrom = (i === currentParaIdx) ? currentCharOffset : 0;
      const haystack = para.text.slice(searchFrom).toLowerCase();

      // Myers approximate search
      const matches = approxSearch(haystack, needle, 10); // MAX_MATCH_ERRORS = 10

      if (matches.length > 0) {
        const match = matches[0];
        const absEnd = searchFrom + match.end;

        if (isFinal) {
          cursorRef.current = { paragraphIdx: i, charOffset: absEnd };
          setSpeechHighlight({ id: para.id, interim: false });

          // Broadcast cursor to other clients
          if (socketRef.current) {
            socketRef.current.emit('cursor', { paragraphIdx: i, charOffset: absEnd });
          }
        } else {
          setSpeechHighlight({ id: para.id, interim: true });
        }

        scrollToBlock(para.id);
        return;
      }
    }
  };

  // Toggle speech listener
  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert('Speech Recognition is not supported by your browser (use Chrome or Safari).');
      return;
    }

    if (isListening) {
      setIsListening(false);
      recognitionRef.current.stop();
      setSpeechHighlight(null);
    } else {
      setIsListening(true);
      setSpeechLogs([]);
      try {
        recognitionRef.current.start();
      } catch (err) {
        console.error(err);
      }
    }
  };

  // --- Handlers & API Calls ---
  
  // Click on a block
  const handleBlockClick = (block, e) => {
    // If Shift + Click on a gen block, toggle its inline view (prompt vs text)
    if (e.shiftKey && block.type === 'gen') {
      e.preventDefault();
      setShowingPrompts((prev) => {
        const next = new Set(prev);
        if (next.has(block.id)) {
          next.delete(block.id);
        } else {
          next.add(block.id);
        }
        return next;
      });
      return;
    }

    setSelectedId(block.id);
    if (block.type === 'gen') {
      setActivePrompt(block.prompt || '');
    } else {
      setActivePrompt('');
    }
  };

  // Double click a block to trigger prompt completion
  const handleBlockDoubleClick = (block) => {
    if (block.type === 'gen') {
      triggerCompletion(block.id, block.prompt);
    }
  };

  // Trigger completion generation
  const triggerCompletion = (id, promptText) => {
    if (!socketRef.current || !id) return;
    
    // Clear old completion display
    setLatestCompletion('Generating...');
    
    socketRef.current.emit('prompt', {
      id: id,
      prompt: promptText
    });
  };

  // Helper to sync current script state to the server (saves or broadcasts)
  const syncScriptToServer = (targetScript = script) => {
    if (!socketRef.current) return;
    const jsonString = JSON.stringify(targetScript, null, 4);
    if (isBroadcasting) {
      socketRef.current.emit('update', jsonString);
    } else {
      socketRef.current.emit('save', jsonString);
    }
  };

  // Update prompt in selected block (called on change)
  const handlePromptChange = (val) => {
    setActivePrompt(val);
    if (!selectedId) return;

    setScript((prev) => {
      const updatedParagraphs = prev.paragraphs.map((p) => {
        if (p.id === selectedId && p.type === 'gen') {
          return { ...p, prompt: val };
        }
        return p;
      });
      return { ...prev, paragraphs: updatedParagraphs };
    });
  };

  // Inline edit paragraph text (called on change)
  const handleBlockTextChange = (id, val) => {
    setScript((prev) => {
      const updatedParagraphs = prev.paragraphs.map((p) => {
        if (p.id === id) {
          return { ...p, text: val };
        }
        return p;
      });
      return { ...prev, paragraphs: updatedParagraphs };
    });
  };

  // Triggered when editing finishes (on blur)
  const handleBlur = () => {
    syncScriptToServer(scriptRef.current);
  };


  // Download local script
  const downloadScriptAsJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(script, null, 4));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "script.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Upload script JSON file
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        setScript(json);
        setSelectedId(null);
        setActivePrompt('');
        
        // Sync uploaded script to server
        syncScriptToServer(json);

        // Reset tracking cursor
        cursorRef.current = { paragraphIdx: 0, charOffset: 0 };
        setSpeechHighlight(null);
      } catch (err) {
        alert('Invalid JSON file format.');
        console.error(err);
      }
    };
    reader.readAsText(file);
  };

  // Textarea auto-resize helper
  const adjustHeight = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  return (
    <div className="app-container fade-in">
      {/* Header */}
      <header className="app-header">
        <div className="header-title">Radio Play // Co-Author</div>
        
        <div className="header-controls">
          {/* Connection Status */}
          <div className="status-indicator">
            <span className={`status-dot ${isConnected ? 'connected' : ''}`}></span>
            {isConnected ? 'Sync Connected' : 'Sync Offline'}
          </div>

          {/* Broadcast Toggle */}
          <div 
            className={`toggle-container ${isBroadcasting ? 'active' : ''}`}
            onClick={() => setIsBroadcasting(!isBroadcasting)}
            title="Broadcast script updates to all connected performers in real time"
          >
            <div className="toggle-switch"></div>
            <span className="toggle-label">Broadcast</span>
          </div>

          {/* Microphone Toggle */}
          <button 
            className={`btn ${isListening ? 'btn-active' : ''}`} 
            onClick={toggleListening}
            title="Start live speech-to-script cursor tracking"
          >
            {isListening ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M10 15V9l5 3-5 3z"/></svg>
                Listening
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                Track Voice
              </>
            )}
          </button>

          {/* Theme Switch */}
          <button 
            className="btn btn-icon-only" 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="Toggle Light/Dark Theme"
          >
            {theme === 'dark' ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
        </div>
      </header>

      {/* Workspace */}
      <div className="app-workspace">
        
        {/* Left Side: Script view */}
        <div className="script-panel">
          <div className="script-editor-container">
            
            {/* Quick documentation overlay */}
            <div className="instructions-overlay">
              <p><strong>Perform & Co-Author Interaction Guide:</strong></p>
              <ul>
                <li><strong>Click</strong> any block to select it.</li>
                <li><strong>Click once + edit text</strong> to modify paragraphs inline.</li>
                <li><strong>Click once</strong> on <span style={{ textDecoration: 'underline' }}>generative prompt block</span> to edit prompt in the panel.</li>
                <li><strong>Double click</strong> a generative prompt block to trigger LLM generation.</li>
                <li><strong>Shift + Click</strong> a generative block to toggle view between Prompt and Completion inline.</li>
              </ul>
            </div>

            {script.paragraphs.map((p, idx) => {
              const isSelected = selectedId === p.id;
              const highlight = speechHighlight?.id === p.id ? (speechHighlight.interim ? 'speech-highlight-interim' : 'speech-highlight') : '';
              const showPromptInline = showingPrompts.has(p.id);

              return (
                <div 
                  key={p.id}
                  id={p.id}
                  className={`script-block block-${p.type} ${isSelected ? 'selected' : ''} ${highlight}`}
                  onClick={(e) => handleBlockClick(p, e)}
                  onDoubleClick={() => handleBlockDoubleClick(p)}
                >
                  {p.type === 'gen' && <span className="gen-tag">AI Generatable</span>}
                  
                  {p.type === 'gen' && showPromptInline ? (
                    <div className="gen-prompt-view">
                      <p><em>Prompt:</em></p>
                      {p.prompt}
                    </div>
                  ) : (
                    <textarea
                      value={p.text || ''}
                      onChange={(e) => handleBlockTextChange(p.id, e.target.value)}
                      onBlur={handleBlur}
                      onInput={adjustHeight}
                      className="script-textarea block-text"
                      rows={1}
                      placeholder={p.type === 'gen' ? '[Double click block to generate text]' : 'Type text here...'}
                      ref={(el) => {
                        if (el) {
                          // Auto resize on initial load
                          el.style.height = 'auto';
                          el.style.height = `${el.scrollHeight}px`;
                        }
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Side: Stacked Panels */}
        <div className="side-panels-container">
          
          {/* Top Panel: Prompt Editor */}
          <div className="panel prompt-panel">
            <div className="panel-header">
              <span className="panel-title">Prompt Panel</span>
              <div className="panel-controls">
                <button 
                  className="btn"
                  disabled={!selectedId || !script.paragraphs.find(p => p.id === selectedId && p.type === 'gen')}
                  onClick={() => {
                    const block = script.paragraphs.find(p => p.id === selectedId);
                    if (block) triggerCompletion(block.id, activePrompt);
                  }}
                  title="Run LLM Completion"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  Generate
                </button>
              </div>
            </div>
            <div className="panel-content">
              {selectedId && script.paragraphs.find(p => p.id === selectedId && p.type === 'gen') ? (
                <textarea
                  className="panel-textarea"
                  value={activePrompt}
                  onChange={(e) => handlePromptChange(e.target.value)}
                  onBlur={handleBlur}
                  placeholder="Selected generative block prompt. Edit here..."
                />
              ) : (
                <div className="speech-log-empty">
                  Select an AI block to view & edit prompt
                </div>
              )}
            </div>
          </div>

          {/* Middle Panel: Latest Completion */}
          <div className="panel completion-panel">
            <div className="panel-header">
              <span className="panel-title">LLM Completion</span>
            </div>
            <div className="panel-content">
              {latestCompletion ? (
                <textarea
                  className="panel-textarea"
                  readOnly
                  value={latestCompletion}
                  placeholder="Generated text will show up here..."
                />
              ) : (
                <div className="speech-log-empty">
                  No generation active
                </div>
              )}
            </div>
          </div>

          {/* Bottom Panel: Speech Tracking Logs */}
          <div className="panel speech-panel">
            <div className="panel-header">
              <span className="panel-title">Speech Tracking</span>
              <div className="panel-controls">
                <button 
                  className="btn" 
                  onClick={() => {
                    // Clear tracking logs
                    setSpeechLogs([]);
                    cursorRef.current = { paragraphIdx: 0, charOffset: 0 };
                    setSpeechHighlight(null);
                  }}
                >
                  Reset Tracker
                </button>
              </div>
            </div>
            <div className="panel-content">
              {speechLogs.length > 0 ? (
                <div className="speech-log">
                  {speechLogs.map((log, i) => (
                    <div 
                      key={i} 
                      className={`speech-log-line ${log.interim ? 'interim' : ''}`}
                    >
                      {log.text}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="speech-log-empty">
                  {isListening ? 'Listening for speech...' : 'Track Voice disabled. Click Track Voice above to start.'}
                </div>
              )}
            </div>
          </div>

          {/* Footer Controls: Upload & Download */}
          <div className="panel-header" style={{ borderTop: '1px solid var(--border-primary)', height: '48px', borderBottom: 'none' }}>
            <span className="panel-title">Script Management</span>
            <div className="panel-controls">
              <label className="btn" title="Upload script JSON">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Import
                <input 
                  type="file" 
                  accept=".json" 
                  className="file-upload-input" 
                  onChange={handleFileUpload}
                />
              </label>
              <button 
                className="btn" 
                onClick={downloadScriptAsJSON}
                title="Download script as JSON"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
