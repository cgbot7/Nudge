# Ollama notes

Running local language models with Ollama on a Windows machine with one GPU.

## Pull and list models

ollama pull llama3.2 downloads a model from the library; ollama list shows what is installed
and ollama rm llama3.2 deletes one to free disk space.

## Run and chat

ollama run qwen3 opens an interactive chat in the terminal. Type /bye to leave.
ollama ps shows which models are loaded in memory right now and whether they sit on the GPU.

## HTTP API

The server listens on http://localhost:11434. POST /api/chat with a model and messages
for a chat reply, POST /api/embed for embedding vectors, and GET /api/tags lists models.
Set "stream": false to get one JSON reply instead of a stream of chunks.

## Where models are stored

Models live in %USERPROFILE%\.ollama\models by default. Set the OLLAMA_MODELS environment
variable to move them to a bigger drive, then restart the Ollama app.

## Keep a model loaded

By default a model unloads after five minutes idle. Set OLLAMA_KEEP_ALIVE=1h, or pass
keep_alive in the request, so the first answer after a pause does not wait for a reload.
