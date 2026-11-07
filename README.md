# Agent I Backend — 150K Input

Node.js HTTP backend for the Agent I Yahoo SSE client. It accepts up to **150,000 Unicode code points** per job, persists conversations and jobs with **better-sqlite3**, and processes long text in bounded chunks through a SQLite-backed queue.

> Important: Yahoo's endpoint is undocumented and third-party. The 150K limit is what this application accepts and queues; it is not a guarantee Yahoo will always process every job. Large inputs are split into multiple upstream requests, and failures are surfaced as failed jobs.

## Requirements

- Node.js 20+
- npm
- Network access to search.yahoo.co.jp and search-agent.yahoo.co.jp

## Install

~~~bash
npm install
cp .env.example .env
npm start
~~~

Windows PowerShell:

~~~powershell
Copy-Item .env.example .env
$env:API_TOKEN = "replace-with-a-long-random-secret"
npm install
npm start
~~~

Default bind: 127.0.0.1:3000. To expose the service outside localhost, set a strong API_TOKEN and use an HTTPS reverse proxy. The server refuses non-localhost binding without an API token.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| HOST | 127.0.0.1 | Bind address |
| PORT | 3000 | HTTP port |
| API_TOKEN | empty | Bearer token; required for non-localhost binding |
| DATABASE_PATH | ./data/agent-i.sqlite | SQLite file |
| AGENT_TIMEOUT_MS | 120000 | Timeout per Yahoo request |
| AGENT_MIN_DELAY_MS | 1500 | Minimum delay between Agent I calls |
| AGENT_MAX_ATTEMPTS | 3 | Retry attempts for transient failures |
| AGENT_SOURCE | chattab_searchbar | Agent I source identifier |
| LINE_VERSION | 26.7.2 | LINE User-Agent version |
| JOB_POLL_MS | 500 | Queue polling interval |
| MAX_ACTIVE_JOBS | 20 | Maximum queued + running jobs |

## Submit a job

POST /v1/jobs

~~~json
{
  "instruction": "Summarize this document and list the key facts.",
  "input": "A long document goes here...",
  "mode": "auto"
}
~~~

The endpoint returns HTTP 202 immediately with a jobId, conversationId, chunk count, and pollUrl. Poll GET /v1/jobs/{jobId} for status, stage, progress, and (when completed) the result.

Read saved conversation messages with GET /v1/conversations/{conversationId}. Add ?includeContent=1 to return full content; otherwise the API returns short previews. GET /health reports service and queue status.

When API_TOKEN is set, send Authorization: Bearer YOUR_TOKEN on legacy and OpenAI routes. Anthropic routes accept x-api-key (and also accept Bearer for convenience). The shared GET /v1/models route returns the OpenAI model-list format by default; it returns the Anthropic model-list format when the request includes anthropic-version or x-api-key.

## API compatibility endpoints

The original asynchronous API remains unchanged. Two synchronous compatibility routes are also available; both submit work to the same SQLite-backed job queue and wait for the job to finish before returning the protocol-shaped response.

### OpenAI Chat Completions

- POST /v1/chat/completions
- GET /v1/models (OpenAI model-list format)
- Advertised model ID: `gpt-agent-v1`
- Authentication: Authorization: Bearer YOUR_TOKEN
- Supports text messages with system, developer, user, and assistant roles.
- Supports stream: true using OpenAI-style Server-Sent Events.

Example:

~~~bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-agent-v1",
    "messages": [
      {"role": "system", "content": "Answer clearly."},
      {"role": "user", "content": "Explain what Node.js is."}
    ]
  }'
~~~

### Anthropic Messages

- POST /v1/messages
- GET /v1/models (Anthropic model-list format when sent with `anthropic-version` or `x-api-key`)
- Advertised model ID: `claude-agent-v1`
- Authentication: x-api-key: YOUR_TOKEN (Anthropic SDK-compatible); Bearer is also accepted.
- Requires model, max_tokens, and messages.
- Supports system text and user/assistant text messages.
- Supports stream: true using Anthropic Messages Server-Sent Events.

Example:

~~~bash
curl http://127.0.0.1:3000/v1/messages \
  -H "x-api-key: YOUR_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-agent-v1",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Explain what Node.js is."}
    ]
  }'
~~~

### Tool calling examples

OpenAI Chat Completions request:

~~~json
{
  "model": "gpt-agent-v1",
  "messages": [{ "role": "user", "content": "Look up record 42." }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "lookup_record",
      "description": "Look up a record by its numeric ID.",
      "parameters": {
        "type": "object",
        "properties": { "id": { "type": "integer" } },
        "required": ["id"],
        "additionalProperties": false
      }
    }
  }],
  "tool_choice": "auto"
}
~~~

When a tool is needed, the response contains an assistant message with `tool_calls` and `finish_reason: "tool_calls"`. Execute the call in the client, then append the assistant message and a `role: "tool"` result message (with the matching `tool_call_id`) to the next request.

Anthropic Messages uses the same flow with `tools` entries containing `name`, `description`, and `input_schema`. The assistant response contains a `tool_use` content block and `stop_reason: "tool_use"`. After executing the tool, send a `tool_result` block in a user message using the returned `tool_use_id`.

### Compatibility notes

- The `model` value is a client-facing alias echoed in the response. Use `gpt-agent-v1` on the OpenAI-compatible route and `claude-agent-v1` on the Anthropic Messages route. The shared GET /v1/models path returns protocol-specific list formats: OpenAI by default, Anthropic when `anthropic-version` or `x-api-key` is present. The actual engine remains Yahoo Agent I; these aliases do not connect to OpenAI or Anthropic model engines.
- These routes are synchronous from the client's perspective: the HTTP request stays open while the durable job is processed. Large prompts still use chunking and summarization internally. For explicit asynchronous polling, continue using POST /v1/jobs.
- `stream: true` emits protocol-compatible SSE frames, but Agent I still generates a complete job result first; the adapter then emits that result in chunks. It is not token-by-token streaming from Yahoo.
- OpenAI sampling controls such as `temperature`, `top_p`, and `max_tokens`, and Anthropic's required `max_tokens`, are accepted for request compatibility but are not enforced by the Yahoo Agent I upstream.
- Yahoo Agent I chat requests send `accept-language: en` as a locale preference. The backend also adds an explicit response-language policy: follow any explicit output-language instruction; otherwise match the latest user request. During tool-result continuation, determine the language from the original user request and translate tool results into that language. Do not switch to Japanese unless it was requested or the user wrote in Japanese.
- Token usage fields are estimates based on UTF-8 size, not exact provider tokenizer counts or billing data.
- Text content and tool calling are supported. Image input remains unsupported.
- OpenAI tools use `tools: [{ type: "function", function: { name, description, parameters } }]`; Anthropic tools use `tools: [{ name, description, input_schema }]`.
- Tool definitions and arguments are translated through a prompt-based DSML protocol. Tool requests use a structured prompt layout (system instructions, conversation history, tool definitions and rules, then the latest user message or tool results) and are sent directly to Yahoo Agent I without the generic long-document source-text wrapper. This is not native Yahoo tool calling, and the upstream model may still fail to emit valid DSML.
- DSML calls are parsed and checked against the declared tool names and supported JSON Schema constraints before being returned. Invalid calls receive up to two formatting/validation recovery attempts.
- Multiple tool calls in one response are supported. The backend returns the tool request only; the API client must execute it and send the result in the next request. The backend does not execute client tools.
- OpenAI continuation uses assistant `tool_calls` followed by `role: "tool"` messages. Anthropic continuation uses assistant `tool_use` blocks followed by user `tool_result` blocks.
- Tool-call requests run in direct mode and are limited to 30,000 UTF-8 bytes for the complete structured prompt, including instructions, tool schemas, and conversation. Long-document analyze/transform modes are not supported together with tool calls.
- Tool-call recovery detects the same set of calls repeated across three consecutive assistant turns and asks the model to stop calling tools.
- JSON Schema validation covers common constraints including types, required/properties, additionalProperties, enum/const, combinators, local references, string and numeric limits, arrays, and pattern constraints. It is not a complete JSON Schema implementation; external references and format-specific validation are not performed.
- The backend does not add internal Web Search, Web Fetch, shell, or filesystem executors.
- `n` must be 1 on the OpenAI route.

## Processing modes

- auto (default): direct request for small text up to 7,000 combined UTF-8 bytes; otherwise automatically uses chunked analyze.
- direct: one Agent I request; limited to 7,000 combined UTF-8 bytes.
- analyze: losslessly splits the document, extracts notes from each segment, compresses notes if needed, then asks Agent I for a final answer. Best for summarization, Q&A, extraction, and analysis.
- transform: transforms each segment separately and joins results in source order. Best for long translation or rewriting; cross-segment references may need review.

For long-form translation or rewriting, set mode to transform. For document Q&A or summaries, use analyze.

## Limits and operations

- Input: maximum 150,000 Unicode code points and 600,000 UTF-8 bytes.
- Instruction: maximum 2,000 code points and 6,000 UTF-8 bytes.
- Chunk: maximum 5,000 code points and 9,000 UTF-8 bytes.
- JSON body: maximum 2 MB.
- One worker processes requests sequentially by default to avoid overwhelming Yahoo.
- Queue limit defaults to 20 active jobs; submissions above the limit receive HTTP 429.
- SQLite stores input, chunks, output, status, and conversation summaries. Protect the database and backups as user data.
- Running jobs/chunks are reset to queued/pending after restart; completed chunk outputs are reused.
- better-sqlite3 is a native dependency. On Windows, use Node.js 20+ and ensure npm can install a prebuilt binary or compile it with C++ build tools.

## PowerShell example

~~~powershell
$body = @{
  instruction = "Summarize this document and list important facts."
  input = ("Example long text. " * 7000)
  mode = "analyze"
} | ConvertTo-Json -Depth 5

$result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/v1/jobs" -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$result
Invoke-RestMethod ("http://127.0.0.1:3000" + $result.pollUrl)
~~~

## Tests

~~~bash
npm test
~~~

Tests are local and do not send real requests to Yahoo.
