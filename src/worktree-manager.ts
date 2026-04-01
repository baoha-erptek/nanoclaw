import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

import {
  createWorktreeRecord,
  getExpiredWorktrees,
  updateWorktreeStatus,
  getWorktreeForTicket,
  TicketWorktree,
} from './db.js';
import { logger } from './logger.js';

const WORKTREES_DIR = '.worktrees';

export interface WorktreeCreateResult {
  worktreePath: string;
  branchName: string;
  created: boolean;
}

export interface CleanupResult {
  ticketId: string;
  action: 'archived' | 'expired' | 'error';
  message: string;
}

function runGit(repoPath: string, args: string): string {
  return execSync(`git -C "${repoPath}" ${args}`, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

/**
 * Create a worktree for a ticket. If one already exists and is active,
 * returns the existing worktree info.
 */
export function createWorktree(
  repoPath: string,
  groupFolder: string,
  ticketId: string,
  baseBranch: string = 'master',
  branchPrefix: string = 'bugfix',
  description: string = '',
): WorktreeCreateResult {
  const existing = getWorktreeForTicket(groupFolder, ticketId);
  if (existing && fs.existsSync(existing.worktree_path)) {
    logger.info(
      { ticketId, path: existing.worktree_path },
      'Worktree already exists',
    );
    return {
      worktreePath: existing.worktree_path,
      branchName: existing.branch_name,
      created: false,
    };
  }

  const slug = description
    ? `-${description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40)}`
    : '';
  const branchName = `${branchPrefix}/${ticketId}${slug}`;
  const worktreePath = path.join(repoPath, WORKTREES_DIR, ticketId);

  // Ensure base is up-to-date
  try {
    runGit(repoPath, `fetch origin ${baseBranch}`);
  } catch (err) {
    logger.warn(
      { err, baseBranch },
      'Failed to fetch base branch, using local',
    );
  }

  // Create worktree with new branch
  const startPoint = `origin/${baseBranch}`;
  try {
    runGit(
      repoPath,
      `worktree add "${worktreePath}" -b "${branchName}" ${startPoint}`,
    );
  } catch (err) {
    // Branch may already exist (e.g. from a previous incomplete cleanup)
    const errMsg = String(err);
    if (errMsg.includes('already exists')) {
      // Try using existing branch
      try {
        runGit(repoPath, `worktree add "${worktreePath}" "${branchName}"`);
      } catch (innerErr) {
        logger.error(
          { innerErr, ticketId },
          'Failed to create worktree with existing branch',
        );
        throw innerErr;
      }
    } else {
      throw err;
    }
  }

  createWorktreeRecord(groupFolder, ticketId, worktreePath, branchName);

  logger.info({ ticketId, worktreePath, branchName }, 'Worktree created');

  return { worktreePath, branchName, created: true };
}

/**
 * Remove a worktree for a ticket. Optionally deletes the branch if merged.
 */
export function removeWorktree(
  repoPath: string,
  groupFolder: string,
  ticketId: string,
  deleteBranchIfMerged: boolean = true,
): void {
  const worktree = getWorktreeForTicket(groupFolder, ticketId);
  if (!worktree) {
    logger.info({ ticketId }, 'No active worktree to remove');
    return;
  }

  const { worktree_path, branch_name } = worktree;

  // Remove worktree
  try {
    if (fs.existsSync(worktree_path)) {
      runGit(repoPath, `worktree remove "${worktree_path}" --force`);
    }
  } catch (err) {
    logger.warn(
      { err, ticketId, worktree_path },
      'Failed to remove worktree via git, cleaning manually',
    );
    // Fallback: remove directory and prune
    try {
      fs.rmSync(worktree_path, { recursive: true, force: true });
      runGit(repoPath, 'worktree prune');
    } catch (pruneErr) {
      logger.error({ pruneErr, ticketId }, 'Failed to prune worktree');
    }
  }

  // Delete branch if merged
  if (deleteBranchIfMerged && checkBranchMerged(repoPath, branch_name)) {
    try {
      runGit(repoPath, `branch -d "${branch_name}"`);
      logger.info({ branch_name }, 'Merged branch deleted');
    } catch {
      logger.info(
        { branch_name },
        'Branch not deleted (may have upstream tracking)',
      );
    }
  }

  updateWorktreeStatus(groupFolder, ticketId, 'archived');
  logger.info({ ticketId, branch_name }, 'Worktree removed');
}

/**
 * Check if a branch has been merged into a target branch.
 */
export function checkBranchMerged(
  repoPath: string,
  branchName: string,
  targetBranch: string = 'master',
): boolean {
  try {
    const merged = runGit(repoPath, `branch --merged ${targetBranch}`);
    return merged
      .split('\n')
      .some(
        (line) =>
          line.trim() === branchName || line.trim() === `* ${branchName}`,
      );
  } catch {
    return false;
  }
}

/**
 * Clean up worktrees that have been idle longer than maxIdleDays.
 * Returns a summary of actions taken.
 */
export function cleanupExpiredWorktrees(
  repoPath: string,
  maxIdleDays: number = 3,
): CleanupResult[] {
  const expired = getExpiredWorktrees(maxIdleDays);
  const results: CleanupResult[] = [];

  for (const wt of expired) {
    try {
      const isMerged = checkBranchMerged(repoPath, wt.branch_name);

      if (isMerged) {
        removeWorktree(repoPath, wt.group_folder, wt.ticket_id, true);
        results.push({
          ticketId: wt.ticket_id,
          action: 'archived',
          message: `Branch ${wt.branch_name} merged and cleaned up`,
        });
      } else {
        updateWorktreeStatus(wt.group_folder, wt.ticket_id, 'expired');
        results.push({
          ticketId: wt.ticket_id,
          action: 'expired',
          message: `Branch ${wt.branch_name} not merged, marked expired (idle ${maxIdleDays}+ days)`,
        });
      }
    } catch (err) {
      results.push({
        ticketId: wt.ticket_id,
        action: 'error',
        message: `Cleanup failed: ${err}`,
      });
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, results },
      'Worktree cleanup completed',
    );
  }

  return results;
}

/**
 * List all git worktrees for a repo.
 */
export function listWorktrees(repoPath: string): string[] {
  try {
    const output = runGit(repoPath, 'worktree list --porcelain');
    return output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.replace('worktree ', ''));
  } catch {
    return [];
  }
}
