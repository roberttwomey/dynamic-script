// Writing Tool Server — radio-play.net (ES Module Version)
// Uses Ollama (local LLM) via its OpenAI-compatible API.
// Speech-to-script matching is handled client-side.
// Serves static files from './dist' in production.

import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Ollama via OpenAI-compatible endpoint ──────────────────────────────────
// Ollama must be running locally: `ollama serve`
// Pull the model first: `ollama pull gemma4` (or any other local model)
const openai = new OpenAI({
  baseURL: process.env.OLLAMA_URL || 'http://localhost:11434/v1',
  apiKey:  'ollama', // Ollama doesn't check the key, but the client requires one
});

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:27b';

// ── Script persistence ─────────────────────────────────────────────────────
const defaultScriptPath = path.join(__dirname, 'ubik-demo.json');
let scriptJSON = '{}';

try {
  if (fs.existsSync(defaultScriptPath)) {
    scriptJSON = fs.readFileSync(defaultScriptPath, 'utf-8');
  } else {
    // If not found in dynamic-script root, try copying from writing-tool
    const originalPath = path.join(__dirname, '..', 'writing-tool', 'ubik-demo.json');
    if (fs.existsSync(originalPath)) {
      scriptJSON = fs.readFileSync(originalPath, 'utf-8');
      fs.writeFileSync(defaultScriptPath, scriptJSON, 'utf-8');
      console.log('Copied default script from writing-tool');
    }
  }
} catch (e) {
  console.error('Error loading default script:', e);
}

function saveScriptJSON(data) {
  const outfile = path.join(__dirname, 'ubik-demo-new.json');
  fs.writeFile(outfile, data, (err) => {
    if (err) { console.error('Save error:', err); return; }
    console.log(`Script saved → ${outfile} (${data.length} bytes)`);
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(handleRequest);
server.listen(8080);
console.log('--== Server started on port 8080 ==--');

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});
console.log('--== socket.io listening ==--');
console.log(`--== LLM: Ollama @ ${process.env.OLLAMA_URL || 'http://localhost:11434'} model=${OLLAMA_MODEL} ==--`);

// ── Static file handler ────────────────────────────────────────────────────
function handleRequest(req, res) {
  let pathname = req.url === '/' ? '/index.html' : req.url;
  pathname = pathname.split('?')[0]; // strip query parameters
  
  const ext = path.extname(pathname);
  const typeExt = { 
    '.html': 'text/html', 
    '.js': 'text/javascript', 
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  const contentType = typeExt[ext] || 'text/plain';
  
  const distPath = path.join(__dirname, 'dist', pathname);

  fs.readFile(distPath, (err, data) => {
    if (err) {
      // Fallback: If not found, serve index.html for SPA routing
      fs.readFile(path.join(__dirname, 'dist', 'index.html'), (errHtml, dataHtml) => {
        if (errHtml) {
          res.writeHead(404);
          return res.end('Not Found. If running in dev mode, use the Vite dev server.');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(dataHtml);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('New client: ' + socket.id);
  socket.on('disconnect', () => console.log('Client disconnected: ' + socket.id));

  // ── Request current script ───────────────────────────────────────────────
  socket.on('script', () => {
    console.log(socket.id + ' requested script');
    socket.emit('script', scriptJSON);
  });

  // ── Push updated script to all clients ──────────────────────────────────
  socket.on('update', (data) => {
    console.log('Script update received from ' + socket.id);
    scriptJSON = data;
    saveScriptJSON(data);
    socket.broadcast.emit('script', data);
    console.log('Updated script broadcast to all clients');
  });

  // ── Save script to disk (no broadcast) ──────────────────────────────────
  socket.on('save', (data) => {
    console.log('Save requested by ' + socket.id);
    saveScriptJSON(data);
  });

  // ── LLM completion via Ollama ────────────────────────────────────────────
  socket.on('prompt', (data) => {
    const prompt   = data['prompt'];
    const targetId = data['id'];
    console.log(`Prompt received for "${targetId}": ${prompt.slice(0, 64)}...`);
    promptOllama(prompt, targetId, socket);
  });

  // ── Cursor broadcast (optional multi-client tracking) ───────────────────
  socket.on('cursor', (data) => {
    socket.broadcast.emit('cursor', data);
  });
});

// ── Ollama completion ──────────────────────────────────────────────────────
async function promptOllama(prompt, targetId, socket) {
  const startTime = Date.now();
  try {
    console.log(`[ollama] prompting model=${OLLAMA_MODEL}`);

    const response = await openai.chat.completions.create({
      model:    OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      num_predict: 128,  // Disable thinking by limiting response length
    });

    const endTime = Date.now();
    const duration = endTime - startTime;
    
    const completion = response.choices[0].message.content;
    console.log(`[ollama] completion (${completion.length} chars, ${duration}ms): ${completion.slice(0, 64)}...`);

    socket.emit('completion', { completion, id: targetId });
  } catch (err) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.error(`[ollama] error after ${duration}ms:`, err.message || err);
    socket.emit('completion', {
      completion: `[Error contacting Ollama: ${err.message}]`,
      id: targetId,
    });
  }
}
