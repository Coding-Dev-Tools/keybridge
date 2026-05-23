const API_KEY = process.env.COMMAND_CODE_API_KEY;
if (!API_KEY) { console.error('COMMAND_CODE_API_KEY env var required'); process.exit(1); }

const BASE = process.env.COMMAND_CODE_API_URL || 'https://api.commandcode.ai';
const CLI_VER = process.env.COMMAND_CODE_CLI_VERSION || '0.26.24';
const PORT = parseInt(process.env.PROXY_PORT || '3000');

function convertMessage(m) {
  if (m.role === 'system') return null;
  if (m.role === 'tool') {
    const content = typeof m.content === 'string' ? m.content : 
      (Array.isArray(m.content) ? m.content.find(c => c.type === 'tool-result')?.content || '' : '');
    return { role: 'user', content };
  }
  if (m.role === 'assistant' && m.tool_calls) {
    return {
      role: 'assistant',
      content: [],
      tool_calls: m.tool_calls.map(t => ({
        id: t.id, type: 'function', function: { 
          name: t.function.name, 
          arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments)
        }
      }))
    };
  }
  let text = '';
  if (Array.isArray(m.content)) {
    const textObj = m.content.find(c => c.type === 'text');
    text = textObj?.text || '';
  } else if (typeof m.content === 'string') {
    text = m.content;
  }
  return { role: m.role, content: text };
}

function convertTools(tools) {
  if (!tools || tools.length === 0) return [];
  return tools.map(t => {
    if (t.type === 'function' && t.function) {
      return { name: t.function.name, input_schema: t.function.parameters || {} };
    }
    if (t.name) return { name: t.name, input_schema: t.input_schema || {} };
    return null;
  }).filter(Boolean);
}

async function readAllEvents(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch (e) {}
    }
  }
  return events;
}

function buildOpenAIChunk(id, model, index, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index, delta, finish_reason: finishReason }] };
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: '1.0.0', cli_version: CLI_VER }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    if (url.pathname === '/v1/models') {
      return new Response(JSON.stringify({
        object: 'list', data: [
          { id: 'deepseek/deepseek-v4-pro', object: 'model', created: Date.now(), owned_by: 'deepseek' },
          { id: 'deepseek/deepseek-v4-flash', object: 'model', created: Date.now(), owned_by: 'deepseek' },
          { id: 'MiniMaxAI/MiniMax-M2.7', object: 'model', created: Date.now(), owned_by: 'minimax' },
          { id: 'Qwen/Qwen3.6-Plus', object: 'model', created: Date.now(), owned_by: 'qwen' },
          { id: 'zai-org/GLM-5.1', object: 'model', created: Date.now(), owned_by: 'zai' },
          { id: 'moonshotai/Kimi-K2.6', object: 'model', created: Date.now(), owned_by: 'moonshot' },
        ]
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/v1/chat/completions') {
      let reqBody;
      try { reqBody = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }), { 
          status: 400, headers: { 'Content-Type': 'application/json' } 
        });
      }

      const sysMsg = (reqBody.messages || []).find(m => m.role === 'system')?.content || '';
      const msgs = (reqBody.messages || []).map(m => convertMessage(m)).filter(Boolean);
      const tools = convertTools(reqBody.tools || []);

      const ccBody = {
        config: {
          workingDir: process.cwd(), 
          date: new Date().toISOString().split('T')[0],
          environment: `${process.platform}-${process.arch}`,
          structure: [], isGitRepo: false, currentBranch: 'main', mainBranch: 'main', gitStatus: '', recentCommits: []
        },
        memory: '', taste: '', skills: null, permissionMode: 'standard',
        params: {
          model: reqBody.model || 'deepseek/deepseek-v4-pro',
          messages: msgs,
          tools: tools,
          system: sysMsg,
          max_tokens: reqBody.max_tokens || 4096,
          temperature: reqBody.temperature ?? 0.3,
          stream: true
        },
        threadId: crypto.randomUUID()
      };

      const r = await fetch(`${BASE}/alpha/generate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'x-command-code-version': CLI_VER
        },
        body: JSON.stringify(ccBody)
      });

      if (!r.ok) {
        const text = await r.text();
        let msg = text;
        try { msg = JSON.parse(text).error?.message || msg; } catch (e) {}
        return new Response(JSON.stringify({ error: { message: msg, type: 'api_error' } }), {
          status: r.status, headers: { 'Content-Type': 'application/json' }
        });
      }

      const events = await readAllEvents(r);
      let textContent = '';
      let toolCalls = [];
      let usage = {};
      let finishReason = 'stop';
      let currentToolCall = null;

      for (const ev of events) {
        const t = ev.type;
        if (t === 'text-delta') textContent += ev.text || '';
        else if (t === 'tool-input-start') {
          currentToolCall = { index: toolCalls.length, id: ev.id, name: ev.toolName, args: '' };
        }
        else if (t === 'tool-input-delta' && currentToolCall) {
          currentToolCall.args += ev.delta || '';
        }
        else if (t === 'tool-input-end' && currentToolCall) {
          toolCalls.push({
            id: currentToolCall.id, type: 'function',
            function: { name: currentToolCall.name, arguments: currentToolCall.args }
          });
          currentToolCall = null;
        }
        else if (t === 'tool-call') {
          toolCalls.push({
            id: ev.toolCallId, type: 'function',
            function: { name: ev.toolName, arguments: JSON.stringify(ev.input || {}) }
          });
        }
        else if (t === 'finish' || t === 'finish-step') {
          if (ev.finishReason === 'tool-calls') finishReason = 'tool_calls';
          else if (ev.finishReason === 'stop' || ev.finishReason === 'end_turn') finishReason = 'stop';
          else if (ev.finishReason) finishReason = ev.finishReason;
          usage = ev.totalUsage || ev.usage || {};
        }
      }

      if (reqBody.stream === true) {
        const stream = new ReadableStream({
          async start(controller) {
            let currentToolCall = null;
            let toolCallIndex = 0;
            for (const ev of events) {
              const t = ev.type;
              if (t === 'text-delta') {
                const c = ev.text || '';
                controller.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${crypto.randomUUID()}`, reqBody.model, 0, { content: c }, null))}\n\n`
                ));
              } else if (t === 'tool-input-start') {
                currentToolCall = { index: toolCallIndex++, id: ev.id, name: ev.toolName, args: '' };
              } else if (t === 'tool-input-delta' && currentToolCall) {
                currentToolCall.args += ev.delta || '';
              } else if (t === 'tool-input-end' && currentToolCall) {
                controller.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${crypto.randomUUID()}`, reqBody.model, 0, {
                    tool_calls: [{ index: currentToolCall.index, id: currentToolCall.id, type: 'function', function: { name: currentToolCall.name, arguments: currentToolCall.args } }]
                  }, null))}\n\n`
                ));
                currentToolCall = null;
              } else if (t === 'tool-call') {
                controller.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${crypto.randomUUID()}`, reqBody.model, 0, {
                    tool_calls: [{ index: toolCallIndex++, id: ev.toolCallId, type: 'function', function: { name: ev.toolName, arguments: JSON.stringify(ev.input || {}) } }]
                  }, null))}\n\n`
                ));
              } else if (t === 'finish' || t === 'finish-step') {
                const fr = ev.finishReason === 'tool-calls' ? 'tool_calls' : (ev.finishReason === 'stop' || ev.finishReason === 'end_turn' ? 'stop' : ev.finishReason || 'stop');
                const u = ev.totalUsage || ev.usage || {};
                const final = {
                  id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000), model: reqBody.model,
                  choices: [{ index: 0, delta: {}, finish_reason: fr }]
                };
                if (u.totalTokens) final.usage = { prompt_tokens: u.inputTokens || 0, completion_tokens: u.outputTokens || 0, total_tokens: u.totalTokens || 0 };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(final)}\n\n`));
                controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
              } else if (t === 'error') {
                controller.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: reqBody.model, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })}\n\n`
                ));
                controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
              }
            }
            controller.close();
          }
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
        });
      }

      const response = {
        id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: reqBody.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: textContent || null },
          finish_reason: finishReason
        }],
        usage: { prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens || 0 }
      };

      if (toolCalls.length > 0) {
        response.choices[0].message.tool_calls = toolCalls;
      }

      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  }
});

console.log(`Command Code Proxy on http://localhost:${PORT}`);