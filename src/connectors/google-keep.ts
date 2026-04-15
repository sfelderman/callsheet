import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, WARN, INFO } from '../test-icons.js';

interface KeepLabel {
  id: string | null;
  name: string | null;
}

interface KeepCheckedItem {
  text: string;
  checked: boolean;
}

interface KeepNote {
  id: string | null;
  localId: string | null;
  title: string;
  type: 'LIST' | 'NOTE';
  text: string | null;
  labels: KeepLabel[];
  color: string;
  pinned: boolean;
  pinned_source: 'dom' | 'api';
  archived: boolean;
  trashed: boolean;
  updated: string | null;
  created: string | null;
  checkedItems: KeepCheckedItem[] | null;
  source: 'merged' | 'api_only' | 'dom_only';
}

interface KeepFile {
  scraped_at: string;
  sync_version: string | null;
  total_notes: number;
  merge_stats: { merged: number; api_only: number; dom_only: number };
  notes: KeepNote[];
}

function execFilePromise(
  cmd: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'google_keep',
    description: 'Google Keep — notes and lists',

    async fetch(): Promise<ConnectorResult> {
      const scraperPath = expandHome(
        (config.scraper_path as string) ??
          '~/projects/playwright-browser-controller/local-service/keep-scraper-combined.js',
      );
      const dataFilePath = expandHome(
        (config.data_file as string) ?? '~/.local/share/callsheet/keep-data.json',
      );
      const titles = (config.titles as string[] | undefined) ?? [];
      // TODO: revisit max_notes and updated_days defaults once API investigation is complete
      const maxNotes = (config.max_notes as number) ?? 20;
      const updatedDays = (config.updated_days as number) ?? 2;
      const includeArchived = (config.include_archived as boolean) ?? false;
      const includeTrashed = (config.include_trashed as boolean) ?? false;

      try {
        await execFilePromise('node', [scraperPath], {
          timeout: 20_000,
          env: { ...process.env, KEEP_OUTPUT: dataFilePath },
        });
      } catch (e) {
        throw new Error(
          `Google Keep scraper failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      let file: KeepFile;
      try {
        const raw = readFileSync(dataFilePath, 'utf8');
        file = JSON.parse(raw) as KeepFile;
      } catch (e) {
        throw new Error(
          `Google Keep data file read failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      let notes = file.notes;
      if (!includeArchived) notes = notes.filter(n => !n.archived);
      if (!includeTrashed) notes = notes.filter(n => !n.trashed);
      if (updatedDays > 0) {
        const cutoff = Date.now() - updatedDays * 24 * 60 * 60 * 1000;
        notes = notes.filter(n => n.updated && new Date(n.updated).getTime() > cutoff);
      }
      if (titles.length > 0) {
        notes = notes.filter(n => titles.some(t => n.title.startsWith(t)));
      }
      const filtered_count = notes.length;
      notes = notes.slice(0, maxNotes);

      const total_notes = file.total_notes;

      return {
        source: 'google_keep',
        description:
          `Google Keep: ${filtered_count} notes (of ${total_notes} total). ` +
          `Filters: ${titles.length > 0 ? `titles [${titles.join(', ')}]` : 'all notes'}, ` +
          `updated in last ${updatedDays} days. ` +
          'Each note has: id (null for dom_only), title, type (NOTE or LIST), text, ' +
          'checkedItems (LIST checkbox state from DOM), labels ({id, name} pairs), ' +
          'pinned, color, updated/created timestamps, source (merged/api_only/dom_only). ' +
          'Prefer merged notes (richest data). dom_only notes have visual order but no server ID.',
        data: {
          notes,
          total_notes,
          filtered_count,
        },
        priorityHint: 'normal',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];

  const dataFilePath = expandHome(
    (config.data_file as string) ?? '~/.local/share/callsheet/keep-data.json',
  );
  const scraperPath = expandHome(
    (config.scraper_path as string) ??
      '~/projects/playwright-browser-controller/local-service/keep-scraper-combined.js',
  );
  const maxStaleMinutes = (config.max_stale_minutes as number) ?? 60;

  if (existsSync(dataFilePath)) {
    checks.push([PASS, `Data file found: ${dataFilePath}`, '']);
    try {
      const raw = readFileSync(dataFilePath, 'utf8');
      const file = JSON.parse(raw) as KeepFile;
      if (file.scraped_at) {
        const ageMinutes = Math.floor((Date.now() - new Date(file.scraped_at).getTime()) / 60_000);
        if (ageMinutes <= maxStaleMinutes) {
          checks.push([PASS, `Data is fresh (scraped ${ageMinutes}m ago)`, '']);
        } else {
          checks.push([
            WARN,
            `Data is stale (scraped ${ageMinutes}m ago, max ${maxStaleMinutes}m)`,
            'Run the keep scraper to refresh',
          ]);
        }
      }
    } catch {
      checks.push([WARN, 'Could not read or parse data file', '']);
    }
  } else {
    checks.push([FAIL, `Data file not found: ${dataFilePath}`, 'Run the keep scraper first']);
  }

  if (existsSync(scraperPath)) {
    checks.push([INFO, `Scraper found: ${scraperPath}`, '']);
  } else {
    checks.push([
      INFO,
      `Scraper not found at: ${scraperPath}`,
      'Set scraper_path in config if installed elsewhere',
    ]);
  }

  const titles = config.titles as string[] | undefined;
  checks.push([INFO, `Title filters: ${titles?.length ? titles.join(', ') : '(none — all notes)'}`, '']);
  checks.push([INFO, `Max notes: ${config.max_notes ?? 20}`, '']);
  checks.push([INFO, `Updated window: last ${config.updated_days ?? 2} days`, '']);

  return checks;
}
