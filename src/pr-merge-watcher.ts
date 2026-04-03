import { execSync } from 'child_process';

import {
  GITHUB_REPO,
  PR_MERGE_POLL_INTERVAL,
  PR_POLL_WINDOW_MS,
} from './config.js';
import { isPrMergeProcessed, recordPrMerge } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

interface PrMergeWatcherDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  storeInboundMessage: (msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
  }) => void;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
}

interface MergedPr {
  number: number;
  title: string;
  mergedAt: string;
  headRefName: string;
}

const TICKET_RE = /\b(NCNB-\d+)\b/i;

function extractTicketFromBranch(branchName: string): string | null {
  const match = branchName.match(TICKET_RE);
  return match ? match[1].toUpperCase() : null;
}

function findDefaultChatJid(
  groups: Record<string, RegisteredGroup>,
): string | null {
  // Find the first registered group (for single-group setups like NWF QA Team)
  const entries = Object.entries(groups);
  if (entries.length === 0) return null;
  return entries[0][0]; // JID is the key
}

async function checkMergedPrs(deps: PrMergeWatcherDeps): Promise<void> {
  let mergedPrs: MergedPr[];
  try {
    const result = execSync(
      `gh pr list --repo "${GITHUB_REPO}" --state merged --limit 10 --json number,title,mergedAt,headRefName`,
      { encoding: 'utf-8', timeout: 30000 },
    );
    mergedPrs = JSON.parse(result);
  } catch (err) {
    logger.warn({ err }, 'Failed to query merged PRs from GitHub');
    return;
  }

  // Filter to PRs merged within the poll window
  const cutoff = new Date(Date.now() - PR_POLL_WINDOW_MS).toISOString();
  const recentPrs = mergedPrs.filter((pr) => pr.mergedAt > cutoff);

  if (recentPrs.length === 0) return;

  const groups = deps.getRegisteredGroups();
  const defaultJid = findDefaultChatJid(groups);
  if (!defaultJid) return;

  for (const pr of recentPrs) {
    if (isPrMergeProcessed(pr.number)) continue;

    const ticketId = extractTicketFromBranch(pr.headRefName);
    if (!ticketId) continue;

    // Record the merge event
    recordPrMerge(
      pr.number,
      ticketId,
      pr.headRefName,
      pr.mergedAt,
      defaultJid,
    );

    logger.info(
      { prNumber: pr.number, ticketId, branch: pr.headRefName },
      'Detected merged PR for tracked ticket',
    );

    // Send notification to Telegram group
    const notification =
      `PR #${pr.number} cho ${ticketId} da duoc merge vao develop.\n` +
      `Branch: ${pr.headRefName}\n\n` +
      `Cac buoc tiep theo: cap nhat task docs, Confluence, chay /learn, don dep worktree.`;
    await deps.sendMessage(defaultJid, notification);

    // Inject synthetic inbound message so the agent picks it up
    // The @Odoo trigger ensures the message loop routes it to a container
    const triggerMessage =
      `@Odoo ${ticketId} PR #${pr.number} da merge vao develop. ` +
      `Thuc hien Buoc 6 don dep: cap nhat task docs, Confluence, chay /learn.`;

    deps.storeInboundMessage({
      id: `merge-${pr.number}-${Date.now()}`,
      chat_jid: defaultJid,
      sender: 'system',
      sender_name: 'PR Merge Watcher',
      content: triggerMessage,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }
}

export function startPrMergeWatcher(deps: PrMergeWatcherDeps): void {
  const loop = async (): Promise<void> => {
    try {
      await checkMergedPrs(deps);
    } catch (err) {
      logger.error({ err }, 'Error in PR merge watcher');
    }
    setTimeout(loop, PR_MERGE_POLL_INTERVAL);
  };
  // Initial delay to let the system stabilize
  setTimeout(loop, 15000);
  logger.info(
    {
      interval: PR_MERGE_POLL_INTERVAL,
      repo: GITHUB_REPO,
      windowMs: PR_POLL_WINDOW_MS,
    },
    'PR merge watcher started',
  );
}
