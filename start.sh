#!/usr/bin/env bash
set -euo pipefail

SESSION="admin-panel"
RUN_AS="zaremate"
PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Root crontabs should start services under the regular user's tmux server.
if [[ "$(id -un)" != "$RUN_AS" ]]; then
    if [[ "$(id -u)" != "0" ]]; then
        echo "Run this script as $RUN_AS or root." >&2
        exit 1
    fi
    exec runuser -u "$RUN_AS" -- "$PROJECT/start.sh" "$@"
fi

if tmux has-session -t "=$SESSION" 2>/dev/null; then
    echo "tmux session '$SESSION' already exists."
    exit 0
fi

command -v tmux >/dev/null
command -v npm >/dev/null

# Each service loads the .env in its own working directory.
# Pane IDs also work when tmux has a custom base-index or pane-base-index.
WEB_PANE=$(tmux new-session -d -P -F '#{pane_id}' -s "$SESSION" -n main \
    -c "$PROJECT/web-server" 'npm start; exec bash')
SHELL_PANE=$(tmux split-window -P -F '#{pane_id}' -t "$WEB_PANE" -h \
    -c "$PROJECT" 'exec bash')
tmux split-window -t "$SHELL_PANE" -h \
    -c "$PROJECT/discord-bot" 'npm start; exec bash'

tmux select-layout -t "$WEB_PANE" even-horizontal
tmux select-pane -t "$WEB_PANE"

echo "Started detached tmux session: $SESSION"
echo "Attach with: tmux attach -t $SESSION"
