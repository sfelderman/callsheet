import { jest } from '@jest/globals';

const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();
const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: jest.fn(),
  existsSync: mockExistsSync,
  mkdirSync: jest.fn(),
}));

jest.unstable_mockModule('node:http', () => ({
  createServer: jest.fn(),
}));

const mockModify = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockTrash = jest.fn<(...args: unknown[]) => Promise<unknown>>();

const mockGmail = jest.fn(() => ({
  users: {
    messages: {
      modify: mockModify,
      trash: mockTrash,
    },
  },
}));

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
      })),
    },
    gmail: mockGmail,
  },
}));

const { archiveMessage, markMessageRead, trashMessage, getGmailClient } = await import(
  '../../src/connectors/gmail-mutate.js'
);

beforeEach(() => {
  jest.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.endsWith('credentials.json') || p.endsWith('shared.json')) {
      return JSON.stringify({
        installed: {
          client_id: 'id',
          client_secret: 'secret',
          redirect_uris: ['http://localhost'],
        },
      });
    }
    return JSON.stringify({ access_token: 'tok' });
  });
  mockModify.mockResolvedValue({});
  mockTrash.mockResolvedValue({});
});

describe('getGmailClient', () => {
  it('resolves a multi-account token by name', () => {
    getGmailClient(
      {
        credentials_dir: 'secrets',
        accounts: [
          { name: 'Primary', token_file: 'token_primary.json' },
          { name: 'Secondary', token_file: 'token_secondary.json' },
        ],
      },
      'Secondary',
    );
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('token_secondary.json'),
      'utf-8',
    );
  });

  it('defaults to the first account when no name is given', () => {
    getGmailClient({
      credentials_dir: 'secrets',
      accounts: [{ name: 'Primary', token_file: 'token_primary.json' }],
    });
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('token_primary.json'),
      'utf-8',
    );
  });

  it('falls back to token_gmail.json in legacy single-account mode', () => {
    getGmailClient({ credentials_dir: 'secrets' });
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('token_gmail.json'),
      'utf-8',
    );
  });

  it('throws a listing-available-accounts error when the name is unknown', () => {
    expect(() =>
      getGmailClient(
        {
          credentials_dir: 'secrets',
          accounts: [{ name: 'Alice' }, { name: 'Bob' }],
        },
        'Charlie',
      ),
    ).toThrow(/account 'Charlie' is not configured/i);
  });

  it('derives the default token filename from the account name when token_file omitted', () => {
    getGmailClient(
      { credentials_dir: 'secrets', accounts: [{ name: 'Primary' }] },
      'Primary',
    );
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('token_gmail_primary.json'),
      'utf-8',
    );
  });
});

describe('gmail mutators', () => {
  it('archiveMessage removes the INBOX label', async () => {
    const client = getGmailClient({ credentials_dir: 'secrets' });
    await archiveMessage(client, 'msg_abc');
    expect(mockModify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg_abc',
      requestBody: { removeLabelIds: ['INBOX'] },
    });
  });

  it('markMessageRead removes the UNREAD label', async () => {
    const client = getGmailClient({ credentials_dir: 'secrets' });
    await markMessageRead(client, 'msg_xyz');
    expect(mockModify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg_xyz',
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  });

  it('trashMessage calls users.messages.trash', async () => {
    const client = getGmailClient({ credentials_dir: 'secrets' });
    await trashMessage(client, 'msg_123');
    expect(mockTrash).toHaveBeenCalledWith({ userId: 'me', id: 'msg_123' });
  });
});
