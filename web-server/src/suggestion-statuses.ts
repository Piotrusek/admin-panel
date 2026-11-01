// Shared with the React client. Keep in sync with discord-bot/src/suggestions.ts (a test checks this).
export const SUGGESTION_STATUSES = ['Denied', 'Done', 'Under consideration', 'Maybe next season', 'Waiting for update', 'Testing', 'Poll'] as const;
export type SuggestionStatus = typeof SUGGESTION_STATUSES[number];
