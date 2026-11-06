# Personal agent (MVP)

A private assistant you use over SSH (Termius). It keeps notes and tasks,
works with files in one workspace folder, and can read your exported research
results. It runs as your own user, not as root, and uses a **local model**
(Ollama, on this machine only). It cannot browse the web, send messages,
spend money, run commands or trade.

The code is in `src/personal-agent/`, separate from the autonomous agent in
`src/agent` and from the research and sandbox code. A test enforces this: it
imports nothing from them, and nothing imports it.

## Commands

    node ~/automaton/dist/personal-agent/main.js <command>
    alias pa='node ~/automaton/dist/personal-agent/main.js'

| Command | What it does |
|---|---|
| `pa doctor` | Checks the folders, the configuration and whether the local model is installed. No model call. |
| `pa chat` | Conversation. Each change asks `Allow ...? [y/N]` first. `/clear` forgets the conversation (notes and tasks are kept), `/tools` lists the tools, `/exit` leaves. |
| `pa ask <question>` | One question. It cannot change anything, because nobody is there to confirm. |
| `pa notes`, `pa tasks` | Lists notes or open tasks without calling the model. |

## Tools and the rules they follow

| Tool | Kind |
|---|---|
| `get_time`, `note_search`, `note_list`, `task_list`, `workspace_list`, `workspace_read`, `research_results_list`, `research_result_read` | Read only |
| `note_add`, `task_add`, `task_done` | Change your notes or tasks. Asks first, unless `autoApproveLocalWrites` is `true`. |
| `workspace_write` | Creates or replaces a file in `~/agent-workspace`. **Always** asks. |

- **Files:**
  - The workspace is `~/agent-workspace`. Paths must stay inside it: no
    `..`, no absolute paths, and links are never followed.
  - Reads are capped at 64 KB and writes at 256 KB.
  - Text read from files is passed to the model marked as untrusted data,
    and it is told never to follow instructions found in it.
- **Research results:** read-only, from the folders that `jobs export`
  creates in `~/research-results/`. They are always described as
  hypothetical results on fictional data.
- **Data:**
  - Everything lives in `~/.personal-agent/` (mode 700; files mode 600).
  - `audit.jsonl` records each model call and tool decision. It stores a
    hash of the tool arguments, not the arguments themselves.
  - The conversation keeps the last 40 messages.
- **Model:**
  - Only a loopback address is accepted (`http://127.0.0.1:11434` by
    default).
  - A paid provider doesn't exist yet. When you approve one, it is refused
    unless you also set a daily token budget.

## Configuration: `~/.personal-agent/config.json`

    {
      "version": 1,
      "provider": "ollama",
      "ollama": { "baseUrl": "http://127.0.0.1:11434", "model": "qwen2.5:3b" },
      "autoApproveLocalWrites": false,
      "workspaceDir": "/home/<you>/agent-workspace",
      "researchResultsDir": "/home/<you>/research-results"
    }

Unknown keys, a provider other than `ollama`, or folders outside your home
folder are refused.
