import { google } from 'googleapis';
import type { ConnectorConfig } from '../types.js';
import { getCredentials, resolveCredsFile, type GoogleAccount } from './google-auth.js';

/**
 * Gmail write operations used by the triage system. Kept in a separate
 * module from the read-only fetch logic in gmail.ts so the daily brief
 * never accidentally imports a mutator, and so the OAuth scope expansion
 * in gmail.ts has an obvious corresponding consumer here.
 *
 * Every mutator resolves the authed client via the same multi-account
 * token files gmail.ts uses at fetch time, so triage sessions act on
 * the right mailbox without a second OAuth dance.
 */

type GmailClient = ReturnType<typeof google.gmail>;

/**
 * Resolve a Gmail client for the given configured account. Pass
 * `accountName` to pick a specific multi-account token; omit for the
 * legacy single-account `token_gmail.json`.
 */
export function getGmailClient(config: ConnectorConfig, accountName?: string): GmailClient {
  const credsDir = (config.credentials_dir as string) ?? 'secrets';
  const accounts = (config.accounts as GoogleAccount[] | undefined) ?? [];

  let tokenFile: string;
  let credsFile: string | undefined;

  if (accountName && accounts.length > 0) {
    const acct = accounts.find((a) => a.name === accountName);
    if (!acct) {
      throw new Error(
        `Gmail account '${accountName}' is not configured. ` +
          `Available: ${accounts.map((a) => a.name).join(', ') || '<none>'}.`,
      );
    }
    tokenFile = acct.token_file ?? `token_gmail_${acct.name.toLowerCase()}.json`;
    credsFile = resolveCredsFile(acct, config);
  } else if (accounts.length > 0) {
    // Multi-account config but no name given — default to the first.
    const acct = accounts[0];
    tokenFile = acct.token_file ?? `token_gmail_${acct.name.toLowerCase()}.json`;
    credsFile = resolveCredsFile(acct, config);
  } else {
    tokenFile = 'token_gmail.json';
  }

  const oauth2 = getCredentials(credsDir, tokenFile, credsFile);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

/** Archive a message — remove the INBOX label without trashing it. */
export async function archiveMessage(client: GmailClient, messageId: string): Promise<void> {
  await client.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['INBOX'] },
  });
}

/** Mark a message as read — remove the UNREAD label. */
export async function markMessageRead(client: GmailClient, messageId: string): Promise<void> {
  await client.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

/** Move a message to the Trash. Recoverable from Gmail Trash for 30 days. */
export async function trashMessage(client: GmailClient, messageId: string): Promise<void> {
  await client.users.messages.trash({ userId: 'me', id: messageId });
}
